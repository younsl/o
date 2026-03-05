import {
  S3Client,
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
import * as tar from 'tar-stream';
import { LogSource } from './types';

export class S3LogService {
  private client: S3Client;
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly bucket: string;
  private readonly prefix: string;
  private credentialExpiry: Date | null = null;

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

  private async listEc2Apps(env: string, date: string): Promise<string[]> {
    const [yyyy, mm, dd] = date.split('-');
    const prefixPath = `${this.prefix}/ec2/${yyyy}/${mm}/${dd}/`;
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

    if (source === 'k8s') {
      fileCount = await this.extractK8sLogs(
        env,
        date,
        apps,
        startMs,
        endMs,
        pack,
        tsTracker,
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
  ): Promise<number> {
    let fileCount = 0;

    // KST range can span multiple UTC dates; scan with buffer
    const scanStartUtc = new Date(startMs - 60 * 60 * 1000);
    const scanEndUtc = new Date(endMs + 60 * 60 * 1000);
    const datesToScan = this.getUtcDateRange(scanStartUtc, scanEndUtc);

    for (const app of apps) {
      const appDir = `${env}.${app}`;
      for (const scanDate of datesToScan) {
        const [sy, sm, sd] = scanDate.split('-');
        const prefixPath = `${this.prefix}/k8s/${appDir}/${sy}/${sm}/${sd}/`;

        const keys = await this.listAllKeys(prefixPath);

        for (const key of keys) {
          try {
            const gzData = await this.downloadObject(key);
            const textData = zlib.gunzipSync(gzData);
            const result = this.filterK8sLogEntries(
              textData.toString('utf-8'),
              startMs,
              endMs,
            );

            if (result) {
              const { text: filtered, minTs, maxTs } = result;
              if (minTs < tsTracker.minMs) tsTracker.minMs = minTs;
              if (maxTs > tsTracker.maxMs) tsTracker.maxMs = maxTs;
              const rawName =
                (key.split('/').pop() ?? 'unknown').replace(/\.gz$/, '') +
                '.ndjson';
              const fileName = `${app}/${rawName}`;
              const buf = Buffer.from(filtered, 'utf-8');
              pack.entry({ name: fileName, size: buf.length }, buf);
              fileCount++;
            }
          } catch (err) {
            this.logger.warn(`Failed to process ${key}: ${err}`);
          }
        }
      }
    }

    return fileCount;
  }

  /**
   * ec2 logs: app-logs/ec2/{YYYY}/{MM}/{DD}/{env}.{app}/logs/java/{app}/{app}.log/ls.s3.{uuid}.{date}T{HH}.{MM}.part{N}.txt.gz
   * Content: Plain text log lines with UTC timestamp prefix.
   */
  private async extractEc2Logs(
    env: string,
    date: string,
    apps: string[],
    startMs: number,
    endMs: number,
    pack: tar.Pack,
    tsTracker: { minMs: number; maxMs: number },
  ): Promise<number> {
    let fileCount = 0;

    // ec2 directory uses UTC dates; scan with buffer
    const scanStartUtc = new Date(startMs - 60 * 60 * 1000);
    const scanEndUtc = new Date(endMs + 60 * 60 * 1000);
    const datesToScan = this.getUtcDateRange(scanStartUtc, scanEndUtc);

    for (const app of apps) {
      for (const scanDate of datesToScan) {
        const [sy, sm, sd] = scanDate.split('-');
        // Only extract from logs/java/ (exclude var/log/)
        const prefixPath = `${this.prefix}/ec2/${sy}/${sm}/${sd}/${env}.${app}/logs/java/`;

        const keys = await this.listAllKeys(prefixPath);

        for (const key of keys) {
          try {
            const gzData = await this.downloadObject(key);
            const textData = zlib.gunzipSync(gzData);
            const result = this.filterEc2LogLines(
              textData.toString('utf-8'),
              startMs,
              endMs,
            );

            if (result) {
              const { text: filtered, minTs, maxTs } = result;
              if (minTs < tsTracker.minMs) tsTracker.minMs = minTs;
              if (maxTs > tsTracker.maxMs) tsTracker.maxMs = maxTs;
              const rawName = (key.split('/').pop() ?? 'unknown').replace(
                /\.gz$/,
                '',
              );
              const fileName = `${app}/${rawName}`;
              const buf = Buffer.from(filtered, 'utf-8');
              pack.entry({ name: fileName, size: buf.length }, buf);
              fileCount++;
            }
          } catch (err) {
            this.logger.warn(`Failed to process ${key}: ${err}`);
          }
        }
      }
    }

    return fileCount;
  }

  /**
   * Filter k8s JSON log entries by timestamp.
   *
   * k8s log files contain a JSON array of entries:
   *   [{"timestamp": "2026-03-05T00:48:50.536Z", "message": "...", ...}, ...]
   *
   * Timestamp is UTC. Returns NDJSON (newline-delimited JSON) of matching entries.
   */
  private filterK8sLogEntries(
    content: string,
    startMs: number,
    endMs: number,
  ): { text: string; minTs: number; maxTs: number } | null {
    let entries: Array<{ timestamp?: string; [key: string]: unknown }>;
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
      if (!entry.timestamp) return false;
      const ts = new Date(entry.timestamp).getTime();
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

  /**
   * Filter ec2 plain text log lines by timestamp.
   *
   * ec2 log line format:
   *   2026-03-05T00:00:54.943Z {name=...} 2026-03-05 09:00:52.184  INFO ...
   *
   * First timestamp is UTC (ISO 8601 with Z). Used for filtering.
   * Lines without a leading timestamp (stack traces) inherit previous state.
   */
  private filterEc2LogLines(
    content: string,
    startMs: number,
    endMs: number,
  ): { text: string; minTs: number; maxTs: number } | null {
    const lines = content.split('\n');
    const filtered: string[] = [];
    let inRange = false;
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (const line of lines) {
      const ts = this.parseEc2Timestamp(line);
      if (ts !== null) {
        inRange = ts >= startMs && ts <= endMs;
        if (inRange) {
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
      }
      if (inRange) {
        filtered.push(line);
      }
    }

    while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
      filtered.pop();
    }

    if (filtered.length === 0) return null;

    return {
      text: filtered.join('\n') + '\n',
      minTs,
      maxTs,
    };
  }

  /**
   * Parse UTC timestamp from ec2 log line prefix.
   * Format: "2026-03-05T00:00:54.943Z ..."
   */
  private static readonly EC2_TS_RE =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s/;

  private parseEc2Timestamp(line: string): number | null {
    const match = line.match(S3LogService.EC2_TS_RE);
    if (!match) return null;
    const d = new Date(match[1]);
    return isNaN(d.getTime()) ? null : d.getTime();
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
