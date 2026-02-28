import React, { useState, useMemo, useCallback } from 'react';
import {
  Alert,
  Box,
  Container,
  Flex,
  PluginHeader,
  SearchField,
  Select,
  Skeleton,
  Text,
} from '@backstage/ui';
import { Link } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useAsync } from 'react-use';
import { Entity } from '@backstage/catalog-model';

interface ApiRow {
  id: string;
  name: string;
  title: string;
  system: string;
  owner: string;
  type: string;
  lifecycle: string;
  description: string;
  tags: string[];
  namespace: string;
  createdAt: string;
}

function toApiRow(entity: Entity): ApiRow {
  const name = entity.metadata.name;
  const namespace = entity.metadata.namespace ?? 'default';
  const annotations = entity.metadata.annotations ?? {};
  const createdAt = annotations['backstage.io/created-at'] ?? '';
  return {
    id: `${namespace}/${name}`,
    name,
    title: entity.metadata.title ?? '',
    namespace,
    system: (entity.spec as any)?.system ?? '-',
    owner: (entity.spec as any)?.owner ?? '-',
    type: (entity.spec as any)?.type ?? '-',
    lifecycle: (entity.spec as any)?.lifecycle ?? '-',
    description: entity.metadata.description ?? '',
    tags: entity.metadata.tags ?? [],
    createdAt,
  };
}

function formatDate(dateString: string): string {
  if (!dateString) return '-';
  try {
    return new Date(dateString).toLocaleDateString();
  } catch {
    return dateString;
  }
}

const COLUMN_COUNT = 8;

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 14,
  borderBottom: '1px solid var(--bui-color-border-default, #444)',
  color: 'var(--bui-color-text-secondary, #aaa)',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 14,
  borderBottom: '1px solid var(--bui-color-border-default, #333)',
};

const chevronStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'inherit',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 4,
  opacity: 0.6,
};

const tagStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 13,
  backgroundColor: 'var(--bui-color-bg-elevated, #2a2a2a)',
  border: '1px solid var(--bui-color-border-default, #444)',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--bui-color-text-secondary, #aaa)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const detailValueStyle: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--bui-color-text-secondary, #ccc)',
  marginTop: 2,
};

export const ApisPage = () => {
  const catalogApi = useApi(catalogApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const toggleRow = useCallback((id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const {
    value: entities,
    loading,
    error,
  } = useAsync(async () => {
    const response = await catalogApi.getEntities({
      filter: { kind: 'API' },
      fields: [
        'metadata.name',
        'metadata.title',
        'metadata.namespace',
        'metadata.description',
        'metadata.tags',
        'metadata.annotations',
        'spec.type',
        'spec.lifecycle',
        'spec.owner',
        'spec.system',
      ],
    });
    return response.items.map(toApiRow);
  }, []);

  const allRows = entities ?? [];

  const uniqueTypes = useMemo(
    () => [...new Set(allRows.map(r => r.type).filter(t => t !== '-'))].sort(),
    [allRows],
  );
  const uniqueLifecycles = useMemo(
    () =>
      [...new Set(allRows.map(r => r.lifecycle).filter(l => l !== '-'))].sort(),
    [allRows],
  );
  const uniqueOwners = useMemo(
    () => [...new Set(allRows.map(r => r.owner).filter(o => o !== '-'))].sort(),
    [allRows],
  );
  const uniqueTags = useMemo(
    () => [...new Set(allRows.flatMap(r => r.tags))].sort(),
    [allRows],
  );

  const typeOptions = [
    { value: 'all', label: 'All' },
    ...uniqueTypes.map(t => ({ value: t, label: t })),
  ];
  const lifecycleOptions = [
    { value: 'all', label: 'All' },
    ...uniqueLifecycles.map(l => ({ value: l, label: l })),
  ];
  const ownerOptions = [
    { value: 'all', label: 'All' },
    ...uniqueOwners.map(o => ({ value: o, label: o })),
  ];

  const filteredRows = useMemo(() => {
    return allRows.filter(row => {
      const matchesSearch =
        searchQuery === '' ||
        row.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        row.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        row.owner.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType = typeFilter === 'all' || row.type === typeFilter;
      const matchesLifecycle =
        lifecycleFilter === 'all' || row.lifecycle === lifecycleFilter;
      const matchesOwner = ownerFilter === 'all' || row.owner === ownerFilter;
      const matchesTag =
        selectedTags.size === 0 || row.tags.some(t => selectedTags.has(t));
      return (
        matchesSearch &&
        matchesType &&
        matchesLifecycle &&
        matchesOwner &&
        matchesTag
      );
    });
  }, [
    allRows,
    searchQuery,
    typeFilter,
    lifecycleFilter,
    ownerFilter,
    selectedTags,
  ]);

  const hasActiveFilters =
    searchQuery !== '' ||
    typeFilter !== 'all' ||
    lifecycleFilter !== 'all' ||
    ownerFilter !== 'all' ||
    selectedTags.size > 0;

  return (
    <>
      <PluginHeader title="APIs" />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Flex justify="between" align="center">
            <Text variant="body-medium" color="secondary">
              Browse and discover APIs registered in the Backstage Catalog
            </Text>
            {!loading && !error && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 24,
                  height: 24,
                  padding: '0 8px',
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 700,
                  backgroundColor: hasActiveFilters ? '#f59e0b' : 'rgba(128,128,128,0.25)',
                  color: hasActiveFilters ? '#fff' : 'rgba(255,255,255,0.7)',
                }}>
                  {hasActiveFilters
                    ? `${filteredRows.length} / ${allRows.length}`
                    : allRows.length}
                </span>
                <Text variant="body-medium" weight="bold" color="secondary">
                  APIs
                </Text>
              </span>
            )}
          </Flex>

          <Box
            mt="3"
            p="3"
            style={{
              backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
              borderRadius: 4,
            }}
          >
            {/* Filter Bar */}
            <Flex
              gap="2"
              mb="3"
              align="end"
              direction={{ initial: 'column', sm: 'row' }}
            >
              <Box style={{ minWidth: 300 }}>
                <SearchField
                  label="Search"
                  placeholder="Search by name, description, or owner..."
                  size="small"
                  value={searchQuery}
                  onChange={setSearchQuery}
                />
              </Box>
              <Box style={{ minWidth: 140 }}>
                <Select
                  label="Type"
                  options={typeOptions}
                  selectedKey={typeFilter}
                  onSelectionChange={key => setTypeFilter(key as string)}
                />
              </Box>
              <Box style={{ minWidth: 140 }}>
                <Select
                  label="Lifecycle"
                  options={lifecycleOptions}
                  selectedKey={lifecycleFilter}
                  onSelectionChange={key => setLifecycleFilter(key as string)}
                />
              </Box>
              <Box style={{ minWidth: 140 }}>
                <Select
                  label="Owner"
                  options={ownerOptions}
                  selectedKey={ownerFilter}
                  onSelectionChange={key => setOwnerFilter(key as string)}
                />
              </Box>
            </Flex>

            {/* Tag Chips */}
            {uniqueTags.length > 0 && (
              <Flex
                gap="1"
                mb="3"
                align="center"
                style={{ flexWrap: 'wrap' }}
              >
                <Text
                  variant="body-small"
                  color="secondary"
                  style={{ marginRight: 4 }}
                >
                  Tags:
                </Text>
                {uniqueTags.map(tag => (
                  <span
                    key={tag}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleTag(tag)}
                    onKeyDown={e => e.key === 'Enter' && toggleTag(tag)}
                    style={{
                      ...tagStyle,
                      cursor: 'pointer',
                      ...(selectedTags.has(tag)
                        ? {
                            backgroundColor:
                              'var(--bui-color-bg-accent, #1e40af)',
                            borderColor:
                              'var(--bui-color-border-accent, #3b82f6)',
                            color: '#fff',
                          }
                        : {}),
                    }}
                  >
                    {tag}
                  </span>
                ))}
                {selectedTags.size > 0 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedTags(new Set())}
                    onKeyDown={e =>
                      e.key === 'Enter' && setSelectedTags(new Set())
                    }
                    style={{
                      ...tagStyle,
                      cursor: 'pointer',
                      marginLeft: 4,
                      color: 'var(--bui-color-text-secondary, #aaa)',
                    }}
                  >
                    Clear
                  </span>
                )}
              </Flex>
            )}

            {/* Table */}
            {loading ? (
              <Flex direction="column" gap="3">
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
              </Flex>
            ) : error ? (
              <Alert
                status="danger"
                title="Failed to load APIs"
                description={error.message}
              />
            ) : filteredRows.length === 0 ? (
              <Flex justify="center" p="4">
                <Text color="secondary">
                  No APIs found matching the current filters
                </Text>
              </Flex>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: 48, padding: '12px 8px' }} />
                      <th style={thStyle}>Name</th>
                      <th style={thStyle}>Title</th>
                      <th style={thStyle}>System</th>
                      <th style={thStyle}>Owner</th>
                      <th style={thStyle}>Type</th>
                      <th style={thStyle}>Lifecycle</th>
                      <th style={thStyle}>Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(row => {
                      const isExpanded = expandedRows.has(row.id);
                      return (
                        <React.Fragment key={row.id}>
                          {/* Data Row */}
                          <tr
                            style={{ cursor: 'pointer' }}
                            onClick={() => toggleRow(row.id)}
                          >
                            <td style={{ ...tdStyle, padding: '10px 8px', ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              <button
                                style={chevronStyle}
                                aria-label={
                                  isExpanded ? 'Collapse row' : 'Expand row'
                                }
                                tabIndex={-1}
                              >
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  style={{
                                    transition: 'transform 0.15s',
                                    transform: isExpanded
                                      ? 'rotate(90deg)'
                                      : 'rotate(0deg)',
                                  }}
                                >
                                  <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                                </svg>
                              </button>
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              <Link to={`/catalog/${row.namespace}/api/${row.name}`}>
                                {row.name}
                              </Link>
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              {row.title || '-'}
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              {row.system}
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              {row.owner}
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              <span style={tagStyle}>{row.type}</span>
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              <span style={tagStyle}>{row.lifecycle}</span>
                            </td>
                            <td style={{ ...tdStyle, ...(isExpanded ? { borderBottom: 'none' } : {}) }}>
                              <span
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 4,
                                }}
                              >
                                {row.tags.length > 0
                                  ? row.tags.map(tag => (
                                      <span
                                        key={tag}
                                        role="button"
                                        tabIndex={0}
                                        onClick={e => {
                                          e.stopPropagation();
                                          toggleTag(tag);
                                        }}
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') {
                                            e.stopPropagation();
                                            toggleTag(tag);
                                          }
                                        }}
                                        style={{
                                          ...tagStyle,
                                          cursor: 'pointer',
                                          ...(selectedTags.has(tag)
                                            ? {
                                                backgroundColor:
                                                  'var(--bui-color-bg-accent, #1e40af)',
                                                borderColor:
                                                  'var(--bui-color-border-accent, #3b82f6)',
                                                color: '#fff',
                                              }
                                            : {}),
                                        }}
                                      >
                                        {tag}
                                      </span>
                                    ))
                                  : '-'}
                              </span>
                            </td>
                          </tr>

                          {/* Detail Row */}
                          {isExpanded && (
                            <tr>
                              <td
                                colSpan={COLUMN_COUNT}
                                style={{
                                  ...tdStyle,
                                  padding: '0 16px 12px 56px',
                                }}
                              >
                                <div
                                  style={{
                                    padding: '12px 16px',
                                    backgroundColor:
                                      'var(--bui-color-bg-default, #121212)',
                                    border:
                                      '1px solid var(--bui-color-border-default, #333)',
                                    borderRadius: 4,
                                    display: 'flex',
                                    gap: 32,
                                  }}
                                >
                                  <div style={{ flex: 1 }}>
                                    <div style={detailLabelStyle}>
                                      Description
                                    </div>
                                    <div style={detailValueStyle}>
                                      {row.description || '-'}
                                    </div>
                                  </div>
                                  <div style={{ minWidth: 120 }}>
                                    <div style={detailLabelStyle}>
                                      Created At
                                    </div>
                                    <div style={detailValueStyle}>
                                      {formatDate(row.createdAt)}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Box>
        </Flex>
      </Container>
    </>
  );
};
