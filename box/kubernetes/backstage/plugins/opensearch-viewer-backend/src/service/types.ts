export type ScanStatus = 'success' | 'failed' | 'never_scanned';

export type ConflictSeverity = 'high' | 'medium' | 'low';

export interface OpenSearchViewerTarget {
  id: string;
  name: string;
  indexPattern: string;
}

export interface IndexSummary {
  index: string;
  documentCount: number | null;
  storeSize: string | null;
  health: string | null;
  status: string | null;
}

export interface ConflictTypeGroup {
  type: string;
  indexCount: number;
  indices: string[];
  documentCount: number | null;
  searchable: boolean;
  aggregatable: boolean;
  nonSearchableIndices: string[];
  nonAggregatableIndices: string[];
}

export interface ConflictAnalysis {
  severity: ConflictSeverity;
  primaryCause: string;
  evidence: string[];
  recommendedActions: string[];
}

export interface FieldConflict {
  field: string;
  typeCount: number;
  indexCount: number;
  documentCount: number | null;
  groups: ConflictTypeGroup[];
  analysis: ConflictAnalysis;
}

export interface ConflictSummary {
  totalFields: number;
  conflictFields: number;
  scannedIndices: number;
  affectedIndices: number;
  affectedDocuments: number | null;
}

export interface OpenSearchConflictSnapshot {
  target: OpenSearchViewerTarget;
  status: ScanStatus;
  errorMessage: string | null;
  scannedAt: string | null;
  lastAttemptAt: string | null;
  scanDurationMs: number | null;
  summary: ConflictSummary;
  conflicts: FieldConflict[];
}
