import { LoggerService } from '@backstage/backend-plugin-api';
import { OpenSearchDataClient } from './OpenSearchDataClient';
import {
  ConflictAnalysis,
  ConflictTypeGroup,
  FieldConflict,
  IndexSummary,
  OpenSearchConflictSnapshot,
  OpenSearchViewerTarget,
} from './types';

const MAX_INDEX_EXPRESSION_ITEMS = 200;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function indexFamily(index: string): string {
  return index
    .replace(/[-_.]?\d{4}[-_.]\d{2}[-_.]\d{2}$/, '-*')
    .replace(/[-_.]?\d{4}[-_.]\d{2}$/, '-*')
    .replace(/[-_.]?\d{6,}$/, '-*')
    .replace(/[-_.]?\d{5,6}$/, '-*');
}

function formatDocs(value: number | null): string {
  return value === null ? 'unknown docs' : `${value.toLocaleString()} docs`;
}

function sumKnownDocuments(
  indices: string[],
  docsByIndex: Map<string, number | null>,
): number | null {
  let sum = 0;
  let hasUnknown = false;
  for (const index of indices) {
    const docs = docsByIndex.get(index);
    if (typeof docs === 'number') sum += docs;
    else hasUnknown = true;
  }
  return hasUnknown && sum === 0 ? null : sum;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function inferTypeCause(types: string[]): string | undefined {
  const set = new Set(types);
  const scalar = ['keyword', 'text', 'long', 'integer', 'short', 'byte', 'float', 'half_float', 'scaled_float', 'double', 'boolean', 'date', 'ip'];
  const hasObject = set.has('object') || set.has('nested');
  const hasScalar = scalar.some(t => set.has(t));
  const numericCount = types.filter(t =>
    ['long', 'integer', 'short', 'byte', 'float', 'half_float', 'scaled_float', 'double'].includes(t),
  ).length;

  if (hasObject && hasScalar) {
    return 'Some indices receive an object for this field while others receive a scalar value.';
  }
  if (set.has('date') && (set.has('keyword') || set.has('text'))) {
    return 'Some timestamp-like values were mapped as strings instead of date values.';
  }
  if (numericCount > 1) {
    return 'Numeric values are being inferred with different numeric widths or decimal handling.';
  }
  if ((set.has('keyword') || set.has('text')) && hasScalar) {
    return 'Dynamic mapping is seeing mixed string and typed values for the same field name.';
  }
  return undefined;
}

function analyzeConflict(
  field: string,
  groups: ConflictTypeGroup[],
  affectedIndices: string[],
  documentCount: number | null,
): ConflictAnalysis {
  const families = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const index of group.indices) {
      const family = indexFamily(index);
      if (!families.has(family)) families.set(family, new Set());
      families.get(family)!.add(group.type);
    }
  }
  const conflictingFamilies = Array.from(families.entries())
    .filter(([, types]) => types.size > 1)
    .map(([family, types]) => `${family} (${Array.from(types).join(', ')})`);

  const types = groups.map(g => g.type);
  const typeCause = inferTypeCause(types);
  const severity =
    groups.length >= 3 ||
    affectedIndices.length >= 50 ||
    (documentCount !== null && documentCount >= 1_000_000)
      ? 'high'
      : affectedIndices.length >= 10 ||
          (documentCount !== null && documentCount >= 100_000)
        ? 'medium'
        : 'low';

  let primaryCause: string;
  if (conflictingFamilies.length > 0) {
    primaryCause =
      'A rollover, template, or dynamic mapping change is producing different mappings inside the same index family.';
  } else {
    primaryCause =
      'The selected index pattern spans indices that reuse this field name with different meanings or mappings.';
  }
  if (typeCause) primaryCause = `${primaryCause} ${typeCause}`;

  const evidence = [
    `${field} has ${groups.length} mapped types across ${affectedIndices.length} indices.`,
    ...groups.map(
      group =>
        `${group.type}: ${group.indexCount} indices, ${formatDocs(group.documentCount)}`,
    ),
  ];
  if (conflictingFamilies.length > 0) {
    evidence.push(`Conflicting index families: ${conflictingFamilies.slice(0, 5).join('; ')}`);
  }

  const preferredType =
    groups
      .slice()
      .sort((a, b) => b.indexCount - a.indexCount)[0]?.type ?? types[0];

  return {
    severity,
    primaryCause,
    evidence,
    recommendedActions: [
      `Align the index template or component template so ${field} is always mapped as ${preferredType}.`,
      'Normalize ingest pipeline output before the next rollover so new indices do not inherit the conflict.',
      'Reindex older affected indices or split the data view/index pattern when the field represents different concepts.',
    ],
  };
}

export interface ScanTargetOptions {
  client: OpenSearchDataClient;
  logger: LoggerService;
  target: OpenSearchViewerTarget;
  ignoredIndexPatterns: string[];
}

export async function scanTargetForConflicts(
  options: ScanTargetOptions,
): Promise<OpenSearchConflictSnapshot> {
  const startedAt = Date.now();
  const { client, logger, target } = options;
  const ignoreMatchers = options.ignoredIndexPatterns.map(globToRegExp);

  const allIndices = await client.listIndices(target.indexPattern);
  const indices = allIndices.filter(
    index => !ignoreMatchers.some(matcher => matcher.test(index.index)),
  );
  const indexNames = indices.map(index => index.index);
  const indexNameSet = new Set(indexNames);
  const docsByIndex = new Map<string, number | null>(
    indices.map(index => [index.index, index.documentCount]),
  );

  if (indices.length === 0) {
    const now = new Date().toISOString();
    return {
      target,
      status: 'success',
      errorMessage: null,
      scannedAt: now,
      lastAttemptAt: now,
      scanDurationMs: Date.now() - startedAt,
      summary: {
        totalFields: 0,
        conflictFields: 0,
        scannedIndices: 0,
        affectedIndices: 0,
        affectedDocuments: 0,
      },
      conflicts: [],
    };
  }

  const indexExpression =
    indexNames.length <= MAX_INDEX_EXPRESSION_ITEMS
      ? indexNames.join(',')
      : target.indexPattern;
  const fieldCaps = await client.getFieldCaps(indexExpression);
  const conflicts: FieldConflict[] = [];
  let totalFields = 0;

  for (const [field, capsByType] of Object.entries(fieldCaps.fields ?? {})) {
    const typeEntries = Object.entries(capsByType).filter(
      ([, value]) => value && typeof value === 'object',
    );
    if (typeEntries.length === 0) continue;
    totalFields += 1;
    if (typeEntries.length <= 1) continue;

    const groups = typeEntries
      .map(([type, caps]) => {
        const rawIndices = Array.isArray(caps.indices)
          ? (caps.indices as string[])
          : indexNames;
        const groupIndices = uniqueSorted(
          rawIndices.filter(index => indexNameSet.has(index)),
        );
        const nonSearchableIndices = Array.isArray(caps.non_searchable_indices)
          ? uniqueSorted(
              (caps.non_searchable_indices as string[]).filter(index =>
                indexNameSet.has(index),
              ),
            )
          : [];
        const nonAggregatableIndices = Array.isArray(caps.non_aggregatable_indices)
          ? uniqueSorted(
              (caps.non_aggregatable_indices as string[]).filter(index =>
                indexNameSet.has(index),
              ),
            )
          : [];

        return {
          type,
          indexCount: groupIndices.length,
          indices: groupIndices,
          documentCount: sumKnownDocuments(groupIndices, docsByIndex),
          searchable: Boolean(caps.searchable),
          aggregatable: Boolean(caps.aggregatable),
          nonSearchableIndices,
          nonAggregatableIndices,
        };
      })
      .filter(group => group.indexCount > 0);

    if (groups.length <= 1) continue;

    const affectedIndices = uniqueSorted(groups.flatMap(group => group.indices));
    const documentCount = sumKnownDocuments(affectedIndices, docsByIndex);
    conflicts.push({
      field,
      typeCount: groups.length,
      indexCount: affectedIndices.length,
      documentCount,
      groups,
      analysis: analyzeConflict(field, groups, affectedIndices, documentCount),
    });
  }

  conflicts.sort((a, b) => {
    const docA = a.documentCount ?? -1;
    const docB = b.documentCount ?? -1;
    if (docA !== docB) return docB - docA;
    if (a.indexCount !== b.indexCount) return b.indexCount - a.indexCount;
    return a.field.localeCompare(b.field);
  });

  const affectedIndices = uniqueSorted(
    conflicts.flatMap(conflict =>
      conflict.groups.flatMap(group => group.indices),
    ),
  );
  const affectedDocuments = sumKnownDocuments(affectedIndices, docsByIndex);
  const now = new Date().toISOString();
  logger.info(
    `OpenSearch field conflict scan '${target.name}' found ${conflicts.length} conflicts across ${indices.length} indices`,
  );

  return {
    target,
    status: 'success',
    errorMessage: null,
    scannedAt: now,
    lastAttemptAt: now,
    scanDurationMs: Date.now() - startedAt,
    summary: {
      totalFields,
      conflictFields: conflicts.length,
      scannedIndices: indices.length,
      affectedIndices: affectedIndices.length,
      affectedDocuments,
    },
    conflicts,
  };
}
