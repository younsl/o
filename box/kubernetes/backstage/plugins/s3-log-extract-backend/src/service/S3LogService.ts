import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import * as tar from 'tar-stream';
import { LogSource } from './types';

// Async gzip decompression so the event loop is not blocked (vs zlib.gunzipSync).
// Runs on the libuv threadpool; bump UV_THREADPOOL_SIZE (deployment env) to
// parallelize decompression beyond the default of 4 threads.
const gunzipAsync = promisify(zlib.gunzip);

export class S3LogService {
  private client: S3Client;
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly bucket: string;
  private readonly prefix: string;
  private credentialExpiry: Date | null = null;

  // Number of S3 objects downloaded/decompressed concurrently.
  private static readonly DOWNLOAD_CONCURRENCY = 16;

  // Buffer applied when pre-filtering keys by their filename timestamp.
  // The epoch in the filename is the batch END time, not the exact span of log
  // lines inside, so we widen the window to avoid dropping edge files.
  private static readonly KEY_BUFFER_MS = 10 * 60 * 1000; // 10m: batch end time, high granularity

  // Object key (both k8s and ec2-shortterm):
  //   .../{YYYY}/{MM}/{DD}/{epochSeconds}-{uuid}.log.gz
  // The epoch is the batch END time (UTC), matching the last log line in the file.
  private static readonly KEY_TS_RE = /\/(\d{10})-[0-9a-fA-F-]+\.log\.gz$/;

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
    const region =
      options.config.getOptionalString('s3LogExtract.region') ??
      'ap-northeast-2';
    this.bucket = options.config.getOptionalString('s3LogExtract.bucket') ?? '';
    this.prefix =
      options.config.getOptionalString('s3LogExtract.prefix') ?? 'app-logs';
    this.client = new S3Client({ region });
  }

  async checkHealth(): Promise<{ connected: boolean; checkedAt: string; error?: string }> {
    const checkedAt = new Date().toISOString();
    if (!this.bucket) {
      return { connected: false, checkedAt, error: 'Bucket not configured' };
    }
    try {
      await this.refreshClient();
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { connected: true, checkedAt };
    } catch (err) {
      return {
        connected: false,
        checkedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private ensureConfigured(): void {
    if (!this.bucket) {
      throw new Error(
        's3LogExtract.bucket is not configured. Set S3_LOG_BUCKET environment variable.',
      );
    }
  }

  private async refreshClient(): Promise<void> {
    const assumeRoleArn = this.config.getOptionalString(
      's3LogExtract.assumeRoleArn',
    );
    if (!assumeRoleArn) return;

    if (
      this.credentialExpiry &&
      this.credentialExpiry.getTime() - Date.now() > 5 * 60 * 1000
    ) {
      return;
    }

    this.logger.info(`Assuming role: ${assumeRoleArn}`);
    const region =
      this.config.getOptionalString('s3LogExtract.region') ??
      'ap-northeast-2';
    const sts = new STSClient({ region });
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: assumeRoleArn,
        RoleSessionName: 'backstage-s3-log-extract',
        DurationSeconds: 3600,
      }),
    );

    const creds = response.Credentials!;
    this.client = new S3Client({
      region,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken!,
      },
    });
    this.credentialExpiry = creds.Expiration ?? null;
  }

  /**
   * List available apps for a given environment and date.
   *
   * k8s: app-logs/k8s/{env}.{app}/YYYY/MM/DD/ — apps listed at top level
   * ec2: app-logs/ec2/YYYY/MM/DD/{env}.{app}/ — apps listed under date
   */
  async listApps(
    env: string,
    date: string,
    source: LogSource,
  ): Promise<string[]> {
    this.ensureConfigured();
    await this.refreshClient();

    if (source === 'k8s') {
      return this.listK8sApps(env);
    }
    return this.listEc2Apps(env, date);
  }

  private async listK8sApps(env: string): Promise<string[]> {
    const prefixPath = `${this.prefix}/k8s/`;
    const envPrefix = `${env}.`;
    const apps = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${prefixPath}${envPrefix}`,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );

      for (const cp of response.CommonPrefixes ?? []) {
        const dirName = cp.Prefix?.replace(prefixPath, '').replace(/\/$/, '');
        if (dirName?.startsWith(envPrefix)) {
          const appName = dirName.substring(envPrefix.length);
          apps.add(appName);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return Array.from(apps).sort();
  }

  // ec2 logs now live under ec2-shortterm/{env}.{app}/java/... with apps listed
  // at the top level (like k8s), so the date argument is unused here.
  private async listEc2Apps(env: string, _date: string): Promise<string[]> {
    const prefixPath = `${this.prefix}/ec2-shortterm/`;
    const envPrefix = `${env}.`;
    const apps = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${prefixPath}${envPrefix}`,
          Delimiter: '/',
          ContinuationToken: continuationToken,
        }),
      );

      for (const cp of response.CommonPrefixes ?? []) {
        const dirName = cp.Prefix?.replace(prefixPath, '').replace(/\/$/, '');
        if (dirName?.startsWith(envPrefix)) {
          const appName = dirName.substring(envPrefix.length);
          apps.add(appName);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return Array.from(apps).sort();
  }

  /**
   * Extract logs from S3, filter by time range, and create a tar.gz archive.
   */
  async extractLogs(
    source: LogSource,
    env: string,
    date: string,
    apps: string[],
    startTime: string,
    endTime: string,
    options?: { onProgress?: (current: number, total: number) => void },
  ): Promise<{
    archivePath: string;
    fileCount: number;
    archiveSize: number;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
  }> {
    this.ensureConfigured();
    await this.refreshClient();

    // Build KST Date boundaries for log line comparison
    const startKst = new Date(`${date}T${startTime}:00+09:00`);
    let endKst = new Date(`${date}T${endTime}:00+09:00`);

    // Cross-midnight: endTime < startTime means end is next day
    if (endKst <= startKst) {
      endKst = new Date(endKst.getTime() + 24 * 60 * 60 * 1000);
    }

    const startMs = startKst.getTime();
    const endMs = endKst.getTime();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-log-extract-'));
    const archivePath = path.join(tempDir, `logs-${env}-${date}.tar.gz`);

    const pack = tar.pack();
    const gzip = zlib.createGzip();
    const output = fs.createWriteStream(archivePath);

    const pipelinePromise = pipeline(pack, gzip, output);

    let fileCount = 0;
    const tsTracker = { minMs: Infinity, maxMs: -Infinity };
    const onAppDone = (done: number) =>
      options?.onProgress?.(done, apps.length);

    if (source === 'k8s') {
      fileCount = await this.extractK8sLogs(
        env,
        date,
        apps,
        startMs,
        endMs,
        pack,
        tsTracker,
        onAppDone,
      );
    } else {
      fileCount = await this.extractEc2Logs(
        env,
        date,
        apps,
        startMs,
        endMs,
        pack,
        tsTracker,
        onAppDone,
      );
    }

    pack.finalize();
    await pipelinePromise;

    const stat = fs.statSync(archivePath);
    const firstTimestamp =
      tsTracker.minMs !== Infinity
        ? new Date(tsTracker.minMs).toISOString()
        : null;
    const lastTimestamp =
      tsTracker.maxMs !== -Infinity
        ? new Date(tsTracker.maxMs).toISOString()
        : null;
    return { archivePath, fileCount, archiveSize: stat.size, firstTimestamp, lastTimestamp };
  }

  /**
   * k8s logs: app-logs/k8s/{env}.{app}/{YYYY}/{MM}/{DD}/{ts}-{uuid}.log.gz
   * Content: JSON array of log entries with UTC timestamps.
   */
  private async extractK8sLogs(
    env: string,
    date: string,
    apps: string[],
    startMs: number,
    endMs: number,
    pack: tar.Pack,
    tsTracker: { minMs: number; maxMs: number },
    onAppDone?: (done: number) => void,
  ): Promise<number> {
    let fileCount = 0;
    let appsProcessed = 0;

    // KST range can span multiple UTC dates; scan with buffer
    const scanStartUtc = new Date(startMs - 60 * 60 * 1000);
    const scanEndUtc = new Date(endMs + 60 * 60 * 1000);
    const datesToScan = this.getUtcDateRange(scanStartUtc, scanEndUtc);

    // Gather candidate keys across all apps/dates, pre-filtered by the filename
    // timestamp so we only download objects that can overlap the time window.
    const work: Array<{ app: string; key: string }> = [];
    let scanned = 0;
    for (const app of apps) {
      const appDir = `${env}.${app}`;
      for (const scanDate of datesToScan) {
        const [sy, sm, sd] = scanDate.split('-');
        const prefixPath = `${this.prefix}/k8s/${appDir}/${sy}/${sm}/${sd}/`;
        const keys = await this.listAllKeys(prefixPath);
        scanned += keys.length;
        for (const key of keys) {
          if (this.keyInRange(key, startMs, endMs)) work.push({ app, key });
        }
      }
      appsProcessed++;
      onAppDone?.(appsProcessed);
    }
    this.logger.info(
      `k8s extract: ${work.length}/${scanned} objects in range, downloading with concurrency ${S3LogService.DOWNLOAD_CONCURRENCY}`,
    );

    return this.downloadFilterPack(
      work,
      pack,
      tsTracker,
      content => this.filterJsonLogEntries(content, startMs, endMs),
      (app, key) =>
        `${app}/${(key.split('/').pop() ?? 'unknown').replace(/\.gz$/, '')}.ndjson`,
    );
  }

  /**
   * ec2 logs: app-logs/ec2-shortterm/{env}.{app}/java/{YYYY}/{MM}/{DD}/{epochSeconds}-{uuid}.log.gz
   * Content: JSON array of filebeat entries (UTC `@timestamp`).
   *
   * Same filename/partition scheme as k8s (epoch batch-end, UTC date dirs); the
   * only differences are the `ec2-shortterm` prefix, the `/java/` segment, and
   * the `@timestamp` field name (handled by the shared JSON filter). The legacy
   * `ec2/` prefix (plain-text `ls.s3.*.txt.gz`) is no longer used.
   */
  private async extractEc2Logs(
    env: string,
    date: string,
    apps: string[],
    startMs: number,
    endMs: number,
    pack: tar.Pack,
    tsTracker: { minMs: number; maxMs: number },
    onAppDone?: (done: number) => void,
  ): Promise<number> {
    let fileCount = 0;
    let appsProcessed = 0;

    // ec2 directory uses UTC dates; scan with buffer
    // Date dirs are UTC; a KST request window can span two UTC dates, so scan
    // with a 1h buffer on each side.
    const scanStartUtc = new Date(startMs - 60 * 60 * 1000);
    const scanEndUtc = new Date(endMs + 60 * 60 * 1000);
    const datesToScan = this.getUtcDateRange(scanStartUtc, scanEndUtc);

    // Gather candidate keys, pre-filtered by the filename epoch (batch end, UTC).
    const work: Array<{ app: string; key: string }> = [];
    let scanned = 0;
    for (const app of apps) {
      for (const scanDate of datesToScan) {
        const [sy, sm, sd] = scanDate.split('-');
        // Only the java/ log stream (exclude json/, nginx/, system/).
        const prefixPath = `${this.prefix}/ec2-shortterm/${env}.${app}/java/${sy}/${sm}/${sd}/`;
        const keys = await this.listAllKeys(prefixPath);
        scanned += keys.length;
        for (const key of keys) {
          if (this.keyInRange(key, startMs, endMs)) work.push({ app, key });
        }
      }
      appsProcessed++;
      onAppDone?.(appsProcessed);
    }
    this.logger.info(
      `ec2 extract: ${work.length}/${scanned} objects in range, downloading with concurrency ${S3LogService.DOWNLOAD_CONCURRENCY}`,
    );

    return this.downloadFilterPack(
      work,
      pack,
      tsTracker,
      content => this.filterJsonLogEntries(content, startMs, endMs),
      (app, key) =>
        `${app}/${(key.split('/').pop() ?? 'unknown').replace(/\.gz$/, '')}.ndjson`,
    );
  }

  /**
   * Filter a JSON-array log file by timestamp. Shared by k8s and ec2-shortterm.
   *
   * Both store a JSON array of entries with a UTC ISO timestamp; the field is
   * `timestamp` for k8s and `@timestamp` for ec2-shortterm (filebeat):
   *   k8s : [{"timestamp":  "2026-03-05T00:48:50.536Z", "message": "...", ...}]
   *   ec2 : [{"@timestamp": "2026-06-27T00:00:01.496Z", "message": "...", ...}]
   *
   * Returns NDJSON (newline-delimited JSON) of matching entries.
   */
  private filterJsonLogEntries(
    content: string,
    startMs: number,
    endMs: number,
  ): { text: string; minTs: number; maxTs: number } | null {
    let entries: Array<{
      timestamp?: string;
      '@timestamp'?: string;
      [key: string]: unknown;
    }>;
    try {
      entries = JSON.parse(content);
    } catch {
      // Not valid JSON; skip
      return null;
    }

    if (!Array.isArray(entries)) return null;

    let minTs = Infinity;
    let maxTs = -Infinity;

    const filtered = entries.filter(entry => {
      const tsRaw = entry.timestamp ?? entry['@timestamp'];
      if (!tsRaw) return false;
      const ts = new Date(tsRaw).getTime();
      if (isNaN(ts) || ts < startMs || ts > endMs) return false;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
      return true;
    });

    if (filtered.length === 0) return null;

    return {
      text: filtered.map(e => JSON.stringify(e)).join('\n') + '\n',
      minTs,
      maxTs,
    };
  }

  /** Returns all UTC dates between two Date objects inclusive. */
  private getUtcDateRange(start: Date, end: Date): string[] {
    const dates: string[] = [];
    const current = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      ),
    );
    const endDay = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
    );
    while (current <= endDay) {
      const y = current.getUTCFullYear();
      const m = String(current.getUTCMonth() + 1).padStart(2, '0');
      const d = String(current.getUTCDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${d}`);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  /**
   * Keep a key only if its filename epoch (batch end, UTC) could overlap the
   * requested window. Drops keys outside [start, end] (± buffer) so we download
   * a small slice of the day instead of every object. Shared by k8s and
   * ec2-shortterm (identical `{epoch}-{uuid}.log.gz` naming). Unparseable keys
   * are kept so nothing is silently lost.
   */
  private keyInRange(key: string, startMs: number, endMs: number): boolean {
    const m = key.match(S3LogService.KEY_TS_RE);
    if (!m) return true;
    const fileMs = parseInt(m[1], 10) * 1000;
    if (isNaN(fileMs)) return true;
    return (
      fileMs >= startMs - S3LogService.KEY_BUFFER_MS &&
      fileMs <= endMs + S3LogService.KEY_BUFFER_MS
    );
  }

  /** Promisified tar pack.entry — resolves once the entry has been written. */
  private packEntry(pack: tar.Pack, name: string, buf: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      pack.entry({ name, size: buf.length }, buf, err =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /**
   * Download, decompress, and time-filter the work items with bounded
   * concurrency, streaming each surviving result into the tar pack as soon as
   * it is ready. The pack is a single stream, so writes are serialized through
   * a promise chain while decompression/filtering still run in parallel.
   *
   * Critically we do NOT hold every decompressed file in memory at once: each
   * worker waits for its packed entry to flush before fetching the next object,
   * so peak memory is bounded to ~DOWNLOAD_CONCURRENCY in-flight files. This is
   * what keeps large extractions (thousands of objects, e.g. high-traffic prd
   * apps) from exhausting the Node heap.
   */
  private async downloadFilterPack(
    work: Array<{ app: string; key: string }>,
    pack: tar.Pack,
    tsTracker: { minMs: number; maxMs: number },
    filterContent: (
      content: string,
    ) => { text: string; minTs: number; maxTs: number } | null,
    buildName: (app: string, key: string) => string,
  ): Promise<number> {
    let fileCount = 0;
    let next = 0;
    // Serializes tar writes (the pack is one stream); workers append here and
    // await it so they don't outrun the packer and accumulate buffers.
    let packChain: Promise<void> = Promise.resolve();

    const workerCount = Math.max(
      1,
      Math.min(S3LogService.DOWNLOAD_CONCURRENCY, work.length),
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = next++;
        if (i >= work.length) break;
        const { app, key } = work[i];

        let result: { text: string; minTs: number; maxTs: number } | null;
        try {
          const gzData = await this.downloadObject(key);
          const textData = await gunzipAsync(gzData);
          result = filterContent(textData.toString('utf-8'));
        } catch (err) {
          this.logger.warn(`Failed to process ${key}: ${err}`);
          continue;
        }
        if (!result) continue;

        const { text, minTs, maxTs } = result;
        if (minTs < tsTracker.minMs) tsTracker.minMs = minTs;
        if (maxTs > tsTracker.maxMs) tsTracker.maxMs = maxTs;
        fileCount++;

        const buf = Buffer.from(text, 'utf-8');
        const name = buildName(app, key);
        // Queue this entry behind any pending writes, then wait for the pack to
        // drain it before this worker downloads its next object (backpressure).
        packChain = packChain.then(() => this.packEntry(pack, name, buf));
        await packChain;
      }
    });

    await Promise.all(workers);
    await packChain;
    return fileCount;
  }

  /** List all S3 keys under a prefix. */
  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  private async downloadObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
