import { createApiRef } from '@backstage/core-plugin-api';
import {
  OpenSearchConflictSnapshot,
  OpenSearchViewerConfig,
} from './types';

export interface OpenSearchViewerApi {
  getConfig(): Promise<OpenSearchViewerConfig>;
  listSnapshots(): Promise<OpenSearchConflictSnapshot[]>;
  getSnapshot(targetId: string): Promise<OpenSearchConflictSnapshot>;
  scanTarget(targetId: string): Promise<OpenSearchConflictSnapshot>;
  scanAll(): Promise<OpenSearchConflictSnapshot[]>;
}

export const opensearchViewerApiRef = createApiRef<OpenSearchViewerApi>({
  id: 'plugin.opensearch-viewer.api',
});
