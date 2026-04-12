import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
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
  Tooltip,
  TooltipTrigger,
  ButtonIcon,
  Link,
} from '@backstage/ui';
import { RiInformationLine } from '@remixicon/react';
import { useApi, attachComponentData } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { catalogPlugin } from '@backstage/plugin-catalog';
import { useAsync } from 'react-use';
import { Entity } from '@backstage/catalog-model';

interface CatalogRow {
  id: string;
  name: string;
  title: string;
  kind: string;
  system: string;
  owner: string;
  type: string;
  lifecycle: string;
  description: string;
  tags: string[];
  namespace: string;
  createdAt: string;
}

function toCatalogRow(entity: Entity): CatalogRow {
  const name = entity.metadata.name;
  const namespace = entity.metadata.namespace ?? 'default';
  const kind = entity.kind;
  const annotations = entity.metadata.annotations ?? {};
  const createdAt = annotations['backstage.io/created-at'] ?? '';
  return {
    id: `${namespace}/${kind}/${name}`,
    name,
    title: entity.metadata.title ?? '',
    kind,
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

const COLUMN_COUNT = 9;

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

export const CatalogPage = () => {
  const catalogApi = useApi(catalogApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tagDropdownRef.current &&
        !tagDropdownRef.current.contains(e.target as Node)
      ) {
        setTagDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
      fields: [
        'metadata.name',
        'metadata.title',
        'metadata.namespace',
        'metadata.description',
        'metadata.tags',
        'metadata.annotations',
        'kind',
        'spec.type',
        'spec.lifecycle',
        'spec.owner',
        'spec.system',
      ],
    });
    return response.items.map(toCatalogRow);
  }, []);

  const allRows = entities ?? [];

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of allRows) {
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    return counts;
  }, [allRows]);

  const uniqueKinds = useMemo(
    () => [...kindCounts.keys()].sort(),
    [kindCounts],
  );
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

  const kindOptions = [
    { value: 'all', label: `All (${allRows.length})` },
    ...uniqueKinds.map(k => ({
      value: k,
      label: `${k} (${kindCounts.get(k) ?? 0})`,
    })),
  ];
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
      const matchesKind = kindFilter === 'all' || row.kind === kindFilter;
      const matchesType = typeFilter === 'all' || row.type === typeFilter;
      const matchesLifecycle =
        lifecycleFilter === 'all' || row.lifecycle === lifecycleFilter;
      const matchesOwner = ownerFilter === 'all' || row.owner === ownerFilter;
      const matchesTag =
        selectedTags.size === 0 || [...selectedTags].every(t => row.tags.includes(t));
      return (
        matchesSearch &&
        matchesKind &&
        matchesType &&
        matchesLifecycle &&
        matchesOwner &&
        matchesTag
      );
    });
  }, [
    allRows,
    searchQuery,
    kindFilter,
    typeFilter,
    lifecycleFilter,
    ownerFilter,
    selectedTags,
  ]);

  const hasActiveFilters =
    searchQuery !== '' ||
    kindFilter !== 'all' ||
    typeFilter !== 'all' ||
    lifecycleFilter !== 'all' ||
    ownerFilter !== 'all' ||
    selectedTags.size > 0;

  return (
    <>
      <PluginHeader title="Catalog" />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Flex align="center" gap="2">
            <Text variant="body-medium" color="secondary">
              Browse and discover all entities registered in the Backstage
              Catalog
            </Text>
            <Link href="/catalog-health" style={{ whiteSpace: 'nowrap', textDecoration: 'underline', fontSize: 'var(--bui-font-size-2, 0.875rem)' }}>
              Catalog Health
            </Link>
          </Flex>

          <Box
            mt="3"
            p="3"
            style={{
              backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
              borderRadius: 4,
            }}
          >
            <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
              Filters
            </Text>
            <Flex
              gap="2"
              align="end"
              direction={{ initial: 'column', sm: 'row' }}
            >
              <Box style={{ minWidth: 380 }}>
                <SearchField
                  label="Search"
                  placeholder="Search by name, description, or owner..."
                  size="small"
                  value={searchQuery}
                  onChange={setSearchQuery}
                />
              </Box>
              <Box style={{ minWidth: 160 }}>
                <Select
                  label="Kind"
                  options={kindOptions}
                  selectedKey={kindFilter}
                  onSelectionChange={key => setKindFilter(key as string)}
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
              {/* Tags Multi-Select */}
              {uniqueTags.length > 0 && (
                <Box style={{ minWidth: 160, position: 'relative' }} ref={tagDropdownRef}>
                  <div style={{ fontSize: 'var(--bui-font-size-2, 0.75rem)', fontWeight: 400, marginBottom: 'var(--bui-space-3, 12px)', color: 'var(--bui-fg-primary, #fff)' }}>
                    Tags ({uniqueTags.length})
                  </div>
                  <button
                    type="button"
                    onClick={() => setTagDropdownOpen(prev => !prev)}
                    style={{
                      width: '100%',
                      height: '2rem',
                      padding: '0 var(--bui-space-3, 12px)',
                      fontSize: 'var(--bui-font-size-3, 0.875rem)',
                      fontWeight: 400,
                      fontFamily: 'var(--bui-font-regular, system-ui)',
                      background: 'var(--bui-bg-neutral-1, rgba(255,255,255,0.1))',
                      border: '1px solid var(--bui-border-2, #585858)',
                      borderRadius: 'var(--bui-radius-3, 8px)',
                      color: 'var(--bui-fg-primary, #fff)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--bui-space-2, 8px)',
                      boxSizing: 'border-box',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selectedTags.size === 0
                        ? 'All'
                        : `${selectedTags.size} selected`}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5, transition: 'transform 0.15s', transform: tagDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                      <path d="M7 10l5 5 5-5z" />
                    </svg>
                  </button>
                  {tagDropdownOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 100,
                        marginTop: 4,
                        minWidth: '100%',
                        maxHeight: 280,
                        overflowY: 'auto',
                        background: 'var(--bui-bg-popover, #1a1a1a)',
                        border: '1px solid var(--bui-border-1, #434343)',
                        borderRadius: 'var(--bui-radius-3, 8px)',
                        boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
                      }}
                    >
                      {selectedTags.size > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedTags(new Set())}
                          style={{
                            width: '100%',
                            padding: '0 var(--bui-space-3, 12px)',
                            height: '2rem',
                            fontSize: 'var(--bui-font-size-3, 0.875rem)',
                            background: 'none',
                            border: 'none',
                            borderBottom: '1px solid var(--bui-border-2, #585858)',
                            color: 'var(--bui-fg-secondary, rgba(255,255,255,0.5))',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          Clear all
                        </button>
                      )}
                      {uniqueTags.map(tag => (
                        <label
                          key={tag}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--bui-space-2, 8px)',
                            padding: '0 var(--bui-space-3, 12px)',
                            minHeight: '2rem',
                            fontSize: 'var(--bui-font-size-3, 0.875rem)',
                            cursor: 'pointer',
                            borderRadius: 'var(--bui-radius-2, 4px)',
                            backgroundColor: selectedTags.has(tag) ? 'var(--bui-bg-neutral-2, rgba(255,255,255,0.06))' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedTags.has(tag)}
                            onChange={() => toggleTag(tag)}
                            style={{ accentColor: '#3b82f6' }}
                          />
                          {tag}
                        </label>
                      ))}
                    </div>
                  )}
                </Box>
              )}
            </Flex>
          </Box>

          <Box
            p="3"
            style={{
              backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
              borderRadius: 4,
            }}
          >
            <Flex justify="between" align="center" mb="3">
              <Text variant="body-medium" weight="bold">
                Entities
              </Text>
              {!loading && !error && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 24,
                      height: 24,
                      padding: '0 8px',
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 700,
                      backgroundColor: hasActiveFilters
                        ? '#f59e0b'
                        : 'rgba(128,128,128,0.25)',
                      color: hasActiveFilters
                        ? '#fff'
                        : 'rgba(255,255,255,0.7)',
                    }}
                  >
                    {hasActiveFilters
                      ? `${filteredRows.length} / ${allRows.length}`
                      : allRows.length}
                  </span>
                  <Text variant="body-small" color="secondary">
                    Entities
                  </Text>
                </span>
              )}
            </Flex>
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
                title="Failed to load catalog entities"
                description={error.message}
              />
            ) : filteredRows.length === 0 ? (
              <Flex justify="center" p="4">
                <Text color="secondary">
                  No entities found matching the current filters
                </Text>
              </Flex>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          ...thStyle,
                          width: 28,
                          padding: '12px 4px',
                        }}
                      />
                      <th style={{ ...thStyle, paddingLeft: 4 }}>Name</th>
                      <th style={thStyle}>Title</th>
                      <th style={thStyle}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          Kind
                          <TooltipTrigger delay={200}>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={<RiInformationLine size={14} />}
                              aria-label="Kind descriptions"
                              style={{ padding: 0, minWidth: 'auto', minHeight: 'auto' }}
                            />
                            <Tooltip style={{ maxWidth: 380 }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, lineHeight: 1.5 }}>
                                <div style={{ marginBottom: 4, opacity: 0.8 }}>
                                  Kind is the entity classification in the Backstage Software Catalog.
                                </div>
                                {[
                                  ['Component', 'Service, library, or website'],
                                  ['API', 'Interface exposed by a component'],
                                  ['System', 'Collection of components and APIs'],
                                  ['Domain', 'Business domain grouping systems'],
                                  ['Resource', 'Infrastructure (DB, storage, etc.)'],
                                  ['Group', 'Team or organizational unit'],
                                  ['User', 'Individual user'],
                                  ['Template', 'Scaffolder template'],
                                  ['Location', 'Entity definition reference'],
                                ].map(([kind, desc]) => (
                                  <div key={kind} style={{ display: 'flex', gap: 8, whiteSpace: 'nowrap' }}>
                                    <span style={{ fontWeight: 700, minWidth: 86 }}>{kind}</span>
                                    <span style={{ opacity: 0.7 }}>{desc}</span>
                                  </div>
                                ))}
                              </div>
                            </Tooltip>
                          </TooltipTrigger>
                        </span>
                      </th>
                      <th style={thStyle}>Type</th>
                      <th style={thStyle}>Owner</th>
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
                            <td
                              style={{
                                ...tdStyle,
                                padding: '10px 4px',
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
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
                            <td
                              style={{
                                ...tdStyle,
                                paddingLeft: 4,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              <Link
                                href={`/catalog/${row.namespace}/${row.kind.toLowerCase()}/${row.name}`}
                              >
                                {row.name}
                              </Link>
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              {row.title || '-'}
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              {row.kind}
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              <span style={tagStyle}>{row.type}</span>
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              {row.owner}
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              <span style={tagStyle}>{row.lifecycle}</span>
                            </td>
                            <td
                              style={{
                                ...tdStyle,
                                ...(isExpanded
                                  ? { borderBottom: 'none' }
                                  : {}),
                              }}
                            >
                              <span
                                style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: 4,
                                  alignItems: 'center',
                                }}
                              >
                                {row.tags.length > 0
                                  ? row.tags.map(tag => (
                                      <span
                                        key={tag}
                                        style={
                                          selectedTags.has(tag)
                                            ? {
                                                ...tagStyle,
                                                backgroundColor:
                                                  'var(--bui-color-bg-accent, #1e40af)',
                                                border:
                                                  '1px solid var(--bui-color-border-accent, #3b82f6)',
                                                color: '#fff',
                                              }
                                            : tagStyle
                                        }
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
                                  padding: '0 16px 12px 36px',
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
                                    <div style={detailLabelStyle}>System</div>
                                    <div style={detailValueStyle}>
                                      {row.system}
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

attachComponentData(CatalogPage, 'core.mountPoint', catalogPlugin.routes.catalogIndex);
