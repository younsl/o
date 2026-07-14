import { LoggerService } from '@backstage/backend-plugin-api';
import { RequestStore } from './RequestStore';
import { S3LogService } from './S3LogService';
import { encryptArchive, generateArchivePassword } from './ArchiveEncryptor';
import { LogExtractRequest } from './types';

export interface ExtractionQueueOptions {
  store: RequestStore;
  s3LogService: S3LogService;
  logger: LoggerService;
}

/**
 * Runs approved extraction requests one at a time, in approval (FIFO) order.
 *
 * A single extraction already downloads DOWNLOAD_CONCURRENCY objects in
 * parallel; running two at once can exhaust the pod's memory, so extraction
 * must be serialized. The queue itself is the database: every request with
 * status 'approved' is waiting to run, and pump() drains that set
 * sequentially. Because the queue is DB-backed, approvals accepted before a
 * restart resume automatically when pump() is called at startup.
 *
 * The in-process `draining` flag is a sufficient mutex because archives are
 * written to and served from local disk, which already pins this plugin to a
 * single replica.
 */
export class ExtractionQueue {
  private draining = false;

  constructor(private readonly options: ExtractionQueueOptions) {}

  /**
   * Drain the queue in the background. Safe to call at any time, from
   * anywhere — while a drain is running, further calls are no-ops (the
   * check-and-set below is synchronous, hence atomic on the event loop).
   */
  pump(): void {
    if (this.draining) return;
    this.draining = true;
    this.drain()
      .catch(err => {
        // Store errors abort the drain; the periodic pump retries later.
        this.options.logger.error(`Extraction queue drain aborted: ${err}`);
      })
      .finally(() => {
        this.draining = false;
      });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = await this.options.store.getOldestApproved();
      if (!next) return;
      await this.runOne(next);
    }
  }

  /**
   * Run a single extraction and record its outcome. Extraction failures are
   * recorded on the request and do not stop the queue; store failures
   * propagate and abort the drain (to be retried by the next pump) so a
   * request that cannot leave 'approved' is never retried in a tight loop.
   */
  private async runOne(request: LogExtractRequest): Promise<void> {
    const { store, s3LogService, logger } = this.options;

    await store.updateStatus(request.id, 'extracting', {
      progressCurrent: 0,
      progressTotal: request.apps.length,
    });
    logger.info(
      `Extraction started [${request.id}]: ${request.env} ${request.date} ${request.apps.join(',')}`,
    );

    try {
      const result = await s3LogService.extractLogs(
        request.source,
        request.logType ?? 'java',
        request.env,
        request.date,
        request.apps,
        request.startTime,
        request.endTime,
        {
          onProgress: (current, total) => {
            store.updateProgress(request.id, current, total).catch(err => {
              logger.warn(
                `Failed to update progress [${request.id}]: ${err}`,
              );
            });
          },
        },
      );

      // Leak protection: re-wrap the tar.gz into an AES-256 encrypted zip and
      // delete the plaintext archive, so from completion on Backstage only
      // holds the password-protected file.
      const password = generateArchivePassword();
      const { zipPath, zipSize } = await encryptArchive(
        result.archivePath,
        password,
      );

      await store.updateStatus(request.id, 'completed', {
        fileCount: result.fileCount,
        archiveSize: zipSize,
        archivePath: zipPath,
        archivePassword: password,
        firstTimestamp: result.firstTimestamp ?? undefined,
        lastTimestamp: result.lastTimestamp ?? undefined,
      });
      logger.info(
        `Extraction completed [${request.id}]: ${result.fileCount} files, ${zipSize} bytes (AES-256 encrypted zip)`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await store.updateStatus(request.id, 'failed', { errorMessage: errMsg });
      logger.error(`Extraction failed [${request.id}]: ${errMsg}`);
    }
  }
}
