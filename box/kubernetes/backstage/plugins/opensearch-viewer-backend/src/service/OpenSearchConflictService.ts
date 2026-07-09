import { LoggerService } from '@backstage/backend-plugin-api';
import { OpenSearchDataClient } from './OpenSearchDataClient';
import { OpenSearchConflictStore } from './OpenSearchConflictStore';
import {
  OpenSearchConflictSnapshot,
  OpenSearchViewerTarget,
} from './types';
import { scanTargetForConflicts } from './ConflictScanner';

const emptySummary = {
  totalFields: 0,
  conflictFields: 0,
  scannedIndices: 0,
  affectedIndices: 0,
  affectedDocuments: 0,
};

export class OpenSearchConflictService {
  private readonly runningTargets = new Set<string>();

  constructor(
    private readonly options: {
      logger: LoggerService;
      client: OpenSearchDataClient | undefined;
      store: OpenSearchConflictStore;
      targets: OpenSearchViewerTarget[];
      ignoredIndexPatterns: string[];
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.options.client);
  }

  getTargets(): OpenSearchViewerTarget[] {
    return this.options.targets;
  }

  async listSnapshots(): Promise<OpenSearchConflictSnapshot[]> {
    const stored = new Map(
      (await this.options.store.listSnapshots()).map(snapshot => [
        snapshot.target.id,
        snapshot,
      ]),
    );

    return this.options.targets.map(target => {
      const existing = stored.get(target.id);
      if (existing) {
        return {
          ...existing,
          target,
        };
      }
      return {
        target,
        status: 'never_scanned',
        errorMessage: null,
        scannedAt: null,
        lastAttemptAt: null,
        scanDurationMs: null,
        summary: emptySummary,
        conflicts: [],
      } as OpenSearchConflictSnapshot;
    });
  }

  async getSnapshot(targetId: string): Promise<OpenSearchConflictSnapshot | undefined> {
    return (await this.listSnapshots()).find(snapshot => snapshot.target.id === targetId);
  }

  async scanAll(): Promise<OpenSearchConflictSnapshot[]> {
    const results: OpenSearchConflictSnapshot[] = [];
    for (const target of this.options.targets) {
      results.push(await this.scanTarget(target.id));
    }
    return results;
  }

  async scanTarget(targetId: string): Promise<OpenSearchConflictSnapshot> {
    const target = this.options.targets.find(t => t.id === targetId);
    if (!target) {
      throw new Error(`Unknown OpenSearch viewer target '${targetId}'`);
    }
    if (!this.options.client) {
      throw new Error('OpenSearch Viewer is not configured with an endpoint');
    }
    if (this.runningTargets.has(targetId)) {
      throw new Error(`Conflict scan already running for '${target.name}'`);
    }

    this.runningTargets.add(targetId);
    const startedAt = Date.now();
    try {
      const snapshot = await scanTargetForConflicts({
        client: this.options.client,
        logger: this.options.logger,
        target,
        ignoredIndexPatterns: this.options.ignoredIndexPatterns,
      });
      await this.options.store.recordSuccess(snapshot);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        `OpenSearch field conflict scan failed for '${target.name}': ${message}`,
      );
      return this.options.store.recordFailure(
        target,
        message,
        Date.now() - startedAt,
      );
    } finally {
      this.runningTargets.delete(targetId);
    }
  }
}
