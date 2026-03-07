import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  HeaderPage,
  Link,
  SearchField,
  Select,
  Skeleton,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useAsyncRetry } from 'react-use';
import { catalogHealthApiRef } from '../../api';
import { CoverageResponse, CoverageSnapshot, GroupCoverage } from '../../api/types';
import { RiAddLine, RiEyeOffLine, RiEyeLine, RiRefreshLine } from '@remixicon/react';
import { highlightYamlLine } from '../../utils/yamlHighlight';
import { HighlightText } from '../HighlightText';
import { CoverageTrendChart } from '../CoverageTrendChart';
import './CatalogHealthPage.css';

interface CatalogMetrics {
  totalComponents: number;
  missingOwner: number;
  missingSonarQube: number;
  missingGitlab: number;
  componentsWithApi: number;
  componentsWithoutApiEntity: number;
  teamBreakdown: Array<{
    team: string;
    count: number;
  }>;
}

const ProgressBar = ({ covered, total, ignored }: { percent?: number; color?: string; covered: number; total: number; ignored?: number }) => {
  const ignoredCount = ignored ?? 0;
  const uncovered = total - covered - ignoredCount;
  const coveredPct = total > 0 ? (covered / total) * 100 : 0;
  const ignoredPct = total > 0 ? (ignoredCount / total) * 100 : 0;
  const uncoveredPct = total > 0 ? (uncovered / total) * 100 : 0;
  return (
    <div className="coverage-progress-bar">
      {covered > 0 && (
        <div
          className="coverage-progress-fill"
          style={{ width: `${coveredPct}%`, backgroundColor: '#10b981' }}
        >
          <span className="coverage-progress-label">{covered}</span>
        </div>
      )}
      {ignoredCount > 0 && (
        <div className="coverage-progress-fill" style={{ width: `${ignoredPct}%`, backgroundColor: '#f59e0b', borderRadius: 0 }}>
          <span className="coverage-progress-label">{ignoredCount}</span>
        </div>
      )}
      {uncovered > 0 && (
        <div className="coverage-progress-unfilled" style={{ width: `${uncoveredPct}%` }}>
          <span className="coverage-progress-label-remaining">{uncovered}</span>
        </div>
      )}
    </div>
  );
};

const StatCard = ({
  label,
  value,
  color,
  subtitle,
}: {
  label: string;
  value: number | string;
  color?: string;
  subtitle?: string;
}) => (
  <div className="coverage-stat-card">
    <Flex direction="column" gap="1">
      <Text variant="body-x-small" color="secondary" style={{ textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
        {label}
      </Text>
      <span className="coverage-stat-value" style={{ color }}>
        {typeof value === 'string' && value.endsWith('%') ? (
          <>{value.slice(0, -1)}<span style={{ fontSize: '1rem', fontWeight: 400, color: '#888' }}>%</span></>
        ) : value}
      </span>
      {subtitle && (
        <Text variant="body-x-small" color="secondary">{subtitle}</Text>
      )}
    </Flex>
  </div>
);

const getPercentColor = (percent: number): string => {
  if (percent >= 80) return '#10b981';
  if (percent >= 50) return '#f59e0b';
  return '#ef4444';
};


/* ---------- Catalog Coverage Tab ---------- */

const CatalogCoverageTab = ({
  coverage,
  groups,
  history,
  loading,
  error,
  onScan,
  onToggleIgnore,
  isAdmin,
}: {
  coverage: CoverageResponse | undefined;
  groups: GroupCoverage[] | undefined;
  history: CoverageSnapshot[] | undefined;
  loading: boolean;
  error: Error | undefined;
  onScan: () => void;
  onToggleIgnore: (projectId: number) => Promise<void>;
  isAdmin: boolean;
}) => {
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'covered' | 'uncovered'>('all');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!groupDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node)) {
        setGroupDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [groupDropdownOpen]);
  const [showIgnored, setShowIgnored] = useState(false);
  const [expandedProjectId, setExpandedProjectId] = useState<number | null>(null);
  const [copiedProjectId, setCopiedProjectId] = useState<number | null>(null);
  const [togglingIgnoreId, setTogglingIgnoreId] = useState<number | null>(null);

  const IGNORE_TOPIC = 'backstage-ignore';

  const allGroups = useMemo(() => {
    if (!coverage) return [];
    const set = new Set(coverage.projects.map(p => p.namespace || '(root)'));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [coverage]);

  const ignoredCount = useMemo(() => {
    if (!coverage) return 0;
    return coverage.projects.filter(p => p.topics.includes(IGNORE_TOPIC)).length;
  }, [coverage]);

  const toggleGroup = (group: string) => {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const filteredProjects = useMemo(() => {
    if (!coverage) return [];
    return coverage.projects.filter(p => {
      if (!showIgnored && p.topics.includes(IGNORE_TOPIC)) return false;
      const matchesText = !filter || p.pathWithNamespace.toLowerCase().includes(filter.toLowerCase());
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'covered' && p.hasCatalogInfo) ||
        (statusFilter === 'uncovered' && !p.hasCatalogInfo);
      const matchesGroup = selectedGroups.size === 0 || selectedGroups.has(p.namespace || '(root)');
      return matchesText && matchesStatus && matchesGroup;
    });
  }, [coverage, filter, statusFilter, showIgnored, selectedGroups]);

  const filteredStats = useMemo(() => {
    const total = filteredProjects.length;
    const registered = filteredProjects.filter(p => p.hasCatalogInfo && !p.topics.includes(IGNORE_TOPIC)).length;
    const ignored = filteredProjects.filter(p => p.topics.includes(IGNORE_TOPIC)).length;
    const done = showIgnored ? registered + ignored : registered;
    const uncovered = total - done;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, registered, uncovered, ignored: showIgnored ? ignored : 0, percent };
  }, [filteredProjects, showIgnored]);

  const filteredGroups = useMemo(() => {
    const groupMap = new Map<string, { total: number; hasCatalog: number; ignored: number }>();
    for (const p of filteredProjects) {
      const ns = p.namespace || '(root)';
      const entry = groupMap.get(ns) ?? { total: 0, hasCatalog: 0, ignored: 0 };
      entry.total++;
      if (p.topics.includes(IGNORE_TOPIC)) {
        entry.ignored++;
      } else if (p.hasCatalogInfo) {
        entry.hasCatalog++;
      }
      groupMap.set(ns, entry);
    }
    return Array.from(groupMap.entries())
      .map(([namespace, { total, hasCatalog, ignored }]) => {
        const done = showIgnored ? hasCatalog + ignored : hasCatalog;
        return {
          namespace,
          total,
          registered: hasCatalog,
          ignored: showIgnored ? ignored : 0,
          percent: total > 0 ? Math.round((done / total) * 100) : 0,
        };
      })
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }, [filteredProjects, showIgnored]);

  if (loading && !coverage) {
    return (
      <Flex direction="column" gap="3">
        <Skeleton width="100%" height={80} />
        <Skeleton width="100%" height={200} />
      </Flex>
    );
  }

  if (error && !coverage) {
    return <Alert status="danger" title="Failed to load catalog coverage data" />;
  }

  if (!coverage || coverage.total === 0) {
    return (
      <div className="coverage-empty">
        <Flex direction="column" gap="2" align="center">
          <Text variant="body-medium" color="secondary">No scan data available</Text>
          <Text variant="body-small" color="secondary">
            Click the Scan button to start analyzing your GitLab repositories.
          </Text>
          <button
            onClick={onScan}
            style={{
              marginTop: 8,
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid var(--bui-color-border-default, #444)',
              background: 'var(--bui-color-background-elevation-2, #2a2a2a)',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            Start Scan
          </button>
        </Flex>
      </div>
    );
  }

  const percentColor = getPercentColor(filteredStats.percent);

  return (
    <Flex direction="column" gap="4">
      {/* Filters */}
      <Box p="3" className="coverage-section-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <div className="coverage-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by name..."
            size="small"
            value={filter}
            onChange={setFilter}
          />
          <Select
            label="Status"
            size="small"
            value={statusFilter}
            onChange={v => setStatusFilter(v as 'all' | 'covered' | 'uncovered')}
            options={[
              { label: 'All', value: 'all' },
              { label: 'Registered', value: 'covered' },
              { label: 'Unregistered', value: 'uncovered' },
            ]}
          />
          {allGroups.length > 1 && (
            <Box style={{ minWidth: 160, position: 'relative' }} ref={groupDropdownRef}>
              <div style={{ fontSize: 'var(--bui-font-size-2, 0.75rem)', fontWeight: 400, marginBottom: 'var(--bui-space-3, 12px)', color: 'var(--bui-fg-primary, #fff)' }}>
                Group ({allGroups.length})
              </div>
              <button
                type="button"
                onClick={() => setGroupDropdownOpen(prev => !prev)}
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
                  {selectedGroups.size === 0 ? 'All' : `${selectedGroups.size} selected`}
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5, transition: 'transform 0.15s', transform: groupDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
              {groupDropdownOpen && (
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
                  {selectedGroups.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedGroups(new Set())}
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
                  {allGroups.map(g => (
                    <label
                      key={g}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--bui-space-2, 8px)',
                        padding: '0 var(--bui-space-3, 12px)',
                        minHeight: '2rem',
                        fontSize: 'var(--bui-font-size-3, 0.875rem)',
                        cursor: 'pointer',
                        borderRadius: 'var(--bui-radius-2, 4px)',
                        backgroundColor: selectedGroups.has(g) ? 'var(--bui-bg-neutral-2, rgba(255,255,255,0.06))' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedGroups.has(g)}
                        onChange={() => toggleGroup(g)}
                        style={{ accentColor: '#3b82f6' }}
                      />
                      {g}
                    </label>
                  ))}
                </div>
              )}
            </Box>
          )}
          {ignoredCount > 0 && (
            <button
              className={`coverage-ignored-toggle${showIgnored ? ' coverage-ignored-toggle-active' : ''}`}
              onClick={() => setShowIgnored(prev => !prev)}
            >
              {showIgnored ? 'Hide' : 'Show'} Ignored ({ignoredCount})
            </button>
          )}
        </div>
      </Box>

      {/* Overview Section */}
      <Box p="3" className="coverage-section-box">
        <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
          <Text variant="body-medium" weight="bold">Overview</Text>
          {coverage && (
            <TooltipTrigger delay={200}>
              <Button
                variant="tertiary"
                size="small"
                className={`coverage-integration-badge ${coverage.gitlabHost ? 'coverage-integration-connected' : 'coverage-integration-disconnected'}`}
              >
                GitLab {coverage.gitlabHost ? 'Connected' : 'Not configured'}
              </Button>
              <Tooltip style={{ maxWidth: 280 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700 }}>GitLab Integration</div>
                  <div>Status: {coverage.gitlabHost ? 'Connected' : 'Not configured'}</div>
                  {coverage.gitlabHost && <div>Host: {coverage.gitlabHost}</div>}
                  <div>Usage: Scans repositories for catalog-info.yaml coverage</div>
                  {coverage.lastScannedAt && (
                    <div style={{ opacity: 0.7 }}>Last scan: {new Date(coverage.lastScannedAt).toLocaleString()}</div>
                  )}
                </div>
              </Tooltip>
            </TooltipTrigger>
          )}
        </Flex>

        {/* 2x2 Grid: StatCard / ProgressBar / Trend Chart */}
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gridTemplateRows: 'auto auto', gap: 12, marginBottom: 12 }}>
          {/* Top-left: StatCard */}
          <div>
            <StatCard label="Catalog Coverage" value={`${filteredStats.percent}%`} color={percentColor} />
          </div>
          {/* Top-right: Progress Bar */}
          <Box p="3" className="coverage-section-box" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <Flex direction="column" gap="2">
              <Flex justify="between" align="center">
                <Flex align="center" gap="3">
                  <Text variant="body-x-small" color="secondary">
                    Total <span style={{ fontWeight: 700, color: 'var(--bui-color-text-default, #e0e0e0)' }}>{filteredStats.total}</span> repos
                  </Text>
                  <Text variant="body-x-small" color="secondary">
                    Registered <span style={{ fontWeight: 700, color: '#10b981' }}>{filteredStats.registered}</span> repos
                  </Text>
                  {filteredStats.ignored > 0 && (
                    <Text variant="body-x-small" color="secondary">
                      Ignored <span style={{ fontWeight: 700, color: '#f59e0b' }}>{filteredStats.ignored}</span> repos
                    </Text>
                  )}
                  <Text variant="body-x-small" color="secondary">
                    Unregistered <span style={{ fontWeight: 700, color: '#ef4444' }}>{filteredStats.uncovered}</span> repos
                  </Text>
                </Flex>
                <Text variant="body-small" color="secondary">
                  {filteredStats.registered + filteredStats.ignored} / {filteredStats.total}
                </Text>
              </Flex>
              <ProgressBar percent={filteredStats.percent} color={percentColor} covered={filteredStats.registered} total={filteredStats.total} ignored={filteredStats.ignored} />
            </Flex>
          </Box>
        </div>

        {/* Coverage Trend + Group Breakdown side by side */}
        <Flex gap="3" align="stretch">
          {/* Coverage Trend */}
          <Box p="3" className="coverage-section-box" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <Flex justify="between" align="center" style={{ marginBottom: 8 }}>
              <Text variant="body-small" weight="bold">Coverage Trend</Text>
              <Flex align="center" gap="3">
                {coverage?.lastScannedAt && (
                  <Text variant="body-x-small" color="secondary">
                    Last scan: {new Date(coverage.lastScannedAt).toLocaleString()}
                  </Text>
                )}
                <Text variant="body-x-small" color="secondary">
                  Retention: 90 days
                </Text>
              </Flex>
            </Flex>
            <CoverageTrendChart snapshots={history ?? []} />
          </Box>

          {/* Group Breakdown */}
          {filteredGroups.length > 0 && (
            <Box p="3" className="coverage-section-box" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <Flex justify="between" align="center" style={{ marginBottom: 8 }}>
                <Text variant="body-small" weight="bold">
                  Catalog Coverage by Group
                </Text>
                <Flex align="center" gap="2">
                  <span className="coverage-count-badge coverage-count-badge-muted">{filteredGroups.length}</span>
                  <Text variant="body-small" color="secondary">groups</Text>
                </Flex>
              </Flex>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <Flex direction="column" gap="2">
                  {filteredGroups.map(g => (
                    <div key={g.namespace} className="coverage-group-bar">
                      {coverage?.gitlabHost ? (
                        <Link
                          href={`https://${coverage.gitlabHost}/${g.namespace}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ width: 200, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
                        >
                          <Text variant="body-x-small">{g.namespace}</Text>
                        </Link>
                      ) : (
                        <Text variant="body-x-small" style={{ width: 200, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {g.namespace}
                        </Text>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ProgressBar percent={g.percent} color={getPercentColor(g.percent)} covered={g.registered} total={g.total} ignored={g.ignored} />
                      </div>
                      <Text variant="body-x-small" color="secondary" style={{ width: 80, textAlign: 'right', flexShrink: 0 }}>
                        {g.registered + g.ignored}/{g.total} ({g.percent}%)
                      </Text>
                    </div>
                  ))}
                </Flex>
              </div>
            </Box>
          )}
        </Flex>

      </Box>

      {/* Repositories Section */}
      <Box p="3" className="coverage-section-box">
        <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
          <Flex align="center" gap="2">
            <Text variant="body-medium" weight="bold">Repositories</Text>
            <span className="coverage-count-badge coverage-count-badge-muted">{filteredProjects.length}</span>
          </Flex>
        </Flex>
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          <table className="coverage-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Repository</th>
                <th>Owner</th>
                <th>Default Branch</th>
                <th>Catalog Count</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map(project => (
                <React.Fragment key={project.id}>
                <tr className={project.topics.includes(IGNORE_TOPIC) ? 'coverage-row-ignored' : ''}>
                  <td>
                    {coverage?.gitlabHost ? (
                      <Link href={`https://${coverage.gitlabHost}/${project.namespace}`} target="_blank" rel="noopener noreferrer">
                        <Text variant="body-x-small" color="secondary">{project.namespace}</Text>
                      </Link>
                    ) : (
                      <Text variant="body-x-small" color="secondary">{project.namespace}</Text>
                    )}
                  </td>
                  <td>
                    <Flex align="center" gap="1">
                      <Link href={project.webUrl} target="_blank" rel="noopener noreferrer">
                        <Text variant="body-small"><HighlightText text={project.pathWithNamespace} query={filter} /></Text>
                      </Link>
                      {project.topics.includes(IGNORE_TOPIC) && (
                        <span className="coverage-ignored-badge">ignored</span>
                      )}
                    </Flex>
                  </td>
                  <td>
                    <Text variant="body-x-small" color="secondary">
                      {project.owners.length > 0 ? project.owners.join(', ') : '-'}
                    </Text>
                  </td>
                  <td>
                    <Text variant="body-x-small" color="secondary">{project.defaultBranch ?? '-'}</Text>
                  </td>
                  <td>
                    <span
                      className="coverage-count-badge"
                      style={{
                        fontSize: '0.6rem',
                        height: 15,
                        minWidth: 15,
                        padding: '0 4px',
                        borderRadius: 8,
                        cursor: project.catalogInfoContent ? 'pointer' : 'default',
                        ...(project.hasCatalogInfo
                          ? expandedProjectId === project.id
                            ? { background: '#10b981', color: '#fff' }
                            : {}
                          : { background: '#6b728066', color: '#6b7280' }),
                      }}
                      onClick={() => {
                        if (project.catalogInfoContent) {
                          setExpandedProjectId(expandedProjectId === project.id ? null : project.id);
                        }
                      }}
                    >
                      {project.hasCatalogInfo ? 1 : 0}
                    </span>
                  </td>
                  <td>
                    <Flex gap="1" align="center">
                      {!project.archived && !project.hasCatalogInfo && (
                        <TooltipTrigger delay={200}>
                          <Link
                            href={`/catalog-health/generate?projectId=${project.id}&name=${encodeURIComponent(project.name)}&path=${encodeURIComponent(project.pathWithNamespace)}`}
                            className="coverage-action-icon"
                          >
                            <RiAddLine size={16} />
                          </Link>
                          <Tooltip>Generate catalog-info.yaml</Tooltip>
                        </TooltipTrigger>
                      )}
                      {isAdmin && (
                        <TooltipTrigger delay={200}>
                          <button
                            className={`coverage-action-icon${project.topics.includes(IGNORE_TOPIC) ? ' coverage-action-icon-active' : ''}`}
                            disabled={togglingIgnoreId === project.id || !coverage?.gitlabHost}
                            onClick={async () => {
                              setTogglingIgnoreId(project.id);
                              await onToggleIgnore(project.id);
                              setTogglingIgnoreId(null);
                            }}
                          >
                            {project.topics.includes(IGNORE_TOPIC)
                              ? <RiEyeLine size={16} />
                              : <RiEyeOffLine size={16} />}
                          </button>
                          <Tooltip>
                            {project.topics.includes(IGNORE_TOPIC) ? 'Unignore this project' : 'Ignore this project'}
                          </Tooltip>
                        </TooltipTrigger>
                      )}
                    </Flex>
                  </td>
                </tr>
                {expandedProjectId === project.id && project.catalogInfoContent && (
                  <tr>
                    <td colSpan={6} style={{ padding: 0 }}>
                      <div className="coverage-expand-row">
                        <button
                          className="coverage-copy-btn"
                          onClick={() => {
                            navigator.clipboard.writeText(project.catalogInfoContent!).then(() => {
                              setCopiedProjectId(project.id);
                              setTimeout(() => setCopiedProjectId(null), 2000);
                            });
                          }}
                        >
                          {copiedProjectId === project.id ? 'Copied' : 'Copy'}
                        </button>
                        <pre className="coverage-expand-pre">{project.catalogInfoContent.split('\n').map((line, i) => (
                          <span key={i} className="coverage-expand-line" data-line={i + 1}>{highlightYamlLine(line)}{'\n'}</span>
                        ))}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Box>

    </Flex>
  );
};

/* ---------- Annotation Tab ---------- */

const AnnotationTab = ({ metrics, loading }: { metrics: CatalogMetrics | undefined; loading: boolean }) => {
  if (loading || !metrics) {
    return (
      <Flex direction="column" gap="3">
        <Skeleton width="100%" height={80} />
        <Skeleton width="100%" height={200} />
      </Flex>
    );
  }

  const sonarQubePercent = metrics.totalComponents > 0
    ? Math.round(((metrics.totalComponents - metrics.missingSonarQube) / metrics.totalComponents) * 100)
    : 0;
  const gitlabPercent = metrics.totalComponents > 0
    ? Math.round(((metrics.totalComponents - metrics.missingGitlab) / metrics.totalComponents) * 100)
    : 0;

  return (
    <Flex direction="column" gap="4">
      <Flex gap="3" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Total Components"
            value={metrics.totalComponents}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="SonarQube Annotated"
            value={`${sonarQubePercent}%`}
            color={getPercentColor(sonarQubePercent)}
            subtitle={`${metrics.missingSonarQube} missing`}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="GitLab Annotated"
            value={`${gitlabPercent}%`}
            color={getPercentColor(gitlabPercent)}
            subtitle={`${metrics.missingGitlab} missing`}
          />
        </div>
      </Flex>

      <Box p="3" className="coverage-section-box">
        <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 12 }}>
          Annotation Completeness
        </Text>
        <Flex direction="column" gap="3">
          <Flex direction="column" gap="1">
            <Flex justify="between" align="center">
              <Text variant="body-small">sonarqube.org/project-key</Text>
              <Text variant="body-small" color="secondary">
                {metrics.totalComponents - metrics.missingSonarQube} / {metrics.totalComponents}
              </Text>
            </Flex>
            <ProgressBar percent={sonarQubePercent} color={getPercentColor(sonarQubePercent)} covered={metrics.totalComponents - metrics.missingSonarQube} total={metrics.totalComponents} />
          </Flex>
          <Flex direction="column" gap="1">
            <Flex justify="between" align="center">
              <Text variant="body-small">gitlab.com/project-slug</Text>
              <Text variant="body-small" color="secondary">
                {metrics.totalComponents - metrics.missingGitlab} / {metrics.totalComponents}
              </Text>
            </Flex>
            <ProgressBar percent={gitlabPercent} color={getPercentColor(gitlabPercent)} covered={metrics.totalComponents - metrics.missingGitlab} total={metrics.totalComponents} />
          </Flex>
        </Flex>
      </Box>
    </Flex>
  );
};

/* ---------- Ownership Tab ---------- */

const OwnershipTab = ({ metrics, loading }: { metrics: CatalogMetrics | undefined; loading: boolean }) => {
  if (loading || !metrics) {
    return (
      <Flex direction="column" gap="3">
        <Skeleton width="100%" height={80} />
        <Skeleton width="100%" height={200} />
      </Flex>
    );
  }

  const ownerAssignedPercent = metrics.totalComponents > 0
    ? Math.round(((metrics.totalComponents - metrics.missingOwner) / metrics.totalComponents) * 100)
    : 0;

  return (
    <Flex direction="column" gap="4">
      <Flex gap="3" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Owner Assigned"
            value={`${ownerAssignedPercent}%`}
            color={getPercentColor(ownerAssignedPercent)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Orphan Components"
            value={metrics.missingOwner}
            color={metrics.missingOwner > 0 ? '#ef4444' : '#10b981'}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Total Components"
            value={metrics.totalComponents}
          />
        </div>
      </Flex>

      <Box p="3" className="coverage-section-box">
        <Flex direction="column" gap="1">
          <Flex justify="between" align="center">
            <Text variant="body-small" weight="bold">Owner Assignment Rate</Text>
            <Text variant="body-small" color="secondary">
              {metrics.totalComponents - metrics.missingOwner} / {metrics.totalComponents} ({ownerAssignedPercent}%)
            </Text>
          </Flex>
          <ProgressBar percent={ownerAssignedPercent} color={getPercentColor(ownerAssignedPercent)} covered={metrics.totalComponents - metrics.missingOwner} total={metrics.totalComponents} />
        </Flex>
      </Box>

      {/* Team Breakdown */}
      {metrics.teamBreakdown.length > 0 && (
        <Box p="3" className="coverage-section-box">
          <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 12 }}>
            Team Adoption ({metrics.teamBreakdown.length} teams)
          </Text>
          <Flex direction="column" gap="2">
            {metrics.teamBreakdown.map(t => {
              const teamPercent = metrics.totalComponents > 0
                ? Math.round((t.count / metrics.totalComponents) * 100)
                : 0;
              return (
                <div key={t.team} className="coverage-group-bar">
                  <Text variant="body-x-small" style={{ width: 200, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.team}
                  </Text>
                  <div className="coverage-group-bar-track">
                    <div
                      className="coverage-group-bar-fill"
                      style={{
                        width: `${teamPercent}%`,
                        backgroundColor: 'var(--bui-color-text-accent, #90caf9)',
                      }}
                    />
                  </div>
                  <Text variant="body-x-small" color="secondary" style={{ width: 60, textAlign: 'right', flexShrink: 0 }}>
                    {t.count}
                  </Text>
                </div>
              );
            })}
          </Flex>
        </Box>
      )}
    </Flex>
  );
};

/* ---------- API Documentation Tab ---------- */

const ApiDocTab = ({ metrics, loading }: { metrics: CatalogMetrics | undefined; loading: boolean }) => {
  if (loading || !metrics) {
    return (
      <Flex direction="column" gap="3">
        <Skeleton width="100%" height={80} />
      </Flex>
    );
  }

  const apiDocPercent = metrics.componentsWithApi > 0
    ? Math.round(((metrics.componentsWithApi - metrics.componentsWithoutApiEntity) / metrics.componentsWithApi) * 100)
    : 100;

  return (
    <Flex direction="column" gap="4">
      <Flex gap="3" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="API Documentation"
            value={`${apiDocPercent}%`}
            color={getPercentColor(apiDocPercent)}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Components with API"
            value={metrics.componentsWithApi}
            subtitle="providesApis defined"
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <StatCard
            label="Missing API Entity"
            value={metrics.componentsWithoutApiEntity}
            color={metrics.componentsWithoutApiEntity > 0 ? '#f59e0b' : '#10b981'}
            subtitle="API entity not found"
          />
        </div>
      </Flex>

      <Box p="3" className="coverage-section-box">
        <Flex direction="column" gap="1">
          <Flex justify="between" align="center">
            <Text variant="body-small" weight="bold">API Documentation Rate</Text>
            <Text variant="body-small" color="secondary">
              Components that declare providesApis and have matching API entities
            </Text>
          </Flex>
          <div style={{ marginTop: 8 }}>
            <ProgressBar percent={apiDocPercent} color={getPercentColor(apiDocPercent)} covered={metrics.componentsWithApi - metrics.componentsWithoutApiEntity} total={metrics.componentsWithApi} />
          </div>
        </Flex>
      </Box>
    </Flex>
  );
};

/* ---------- Main Page ---------- */

const useCatalogMetrics = () => {
  const catalogApi = useApi(catalogApiRef);

  return useAsyncRetry(async (): Promise<CatalogMetrics> => {
    const { items: components } = await catalogApi.getEntities({
      filter: { kind: 'Component' },
      fields: [
        'kind',
        'metadata.name',
        'metadata.namespace',
        'metadata.annotations',
        'spec.type',
        'spec.owner',
        'relations',
      ],
    });

    const { items: apis } = await catalogApi.getEntities({
      filter: { kind: 'API' },
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    });

    const apiNames = new Set(apis.map(a => `${a.metadata.namespace ?? 'default'}/${a.metadata.name}`));

    let missingOwner = 0;
    let missingSonarQube = 0;
    let missingGitlab = 0;
    let componentsWithApi = 0;
    let componentsWithoutApiEntity = 0;
    const teamCounts = new Map<string, number>();

    for (const component of components) {
      const annotations = component.metadata.annotations ?? {};
      const owner = (component.spec as any)?.owner as string | undefined;

      if (!owner) {
        missingOwner++;
      } else {
        const teamName = owner.replace(/^(group|user):default\//, '');
        teamCounts.set(teamName, (teamCounts.get(teamName) ?? 0) + 1);
      }

      if (!annotations['sonarqube.org/project-key']) {
        missingSonarQube++;
      }

      if (!annotations['gitlab.com/project-slug']) {
        missingGitlab++;
      }

      const providesApis = (component.relations ?? []).filter(
        r => r.type === 'providesApi',
      );
      if (providesApis.length > 0) {
        componentsWithApi++;
        const hasAllApis = providesApis.every(r => {
          const ref = r.targetRef;
          const match = ref.match(/^api:(?:([^/]+)\/)?(.+)$/);
          if (!match) return false;
          const ns = match[1] ?? 'default';
          const name = match[2];
          return apiNames.has(`${ns}/${name}`);
        });
        if (!hasAllApis) {
          componentsWithoutApiEntity++;
        }
      }
    }

    const teamBreakdown = Array.from(teamCounts.entries())
      .map(([team, count]) => ({ team, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalComponents: components.length,
      missingOwner,
      missingSonarQube,
      missingGitlab,
      componentsWithApi,
      componentsWithoutApiEntity,
      teamBreakdown,
    };
  }, [catalogApi]);
};

export const CatalogHealthPage = () => {
  const coverageApi = useApi(catalogHealthApiRef);

  const {
    value: coverage,
    loading: coverageLoading,
    error: coverageError,
    retry: retryCoverage,
  } = useAsyncRetry(async () => coverageApi.getCoverage(), []);

  const { value: groups } = useAsyncRetry(async () => coverageApi.getGroupCoverage(), []);

  const {
    value: history,
    retry: retryHistory,
  } = useAsyncRetry(async () => coverageApi.getCoverageHistory(), []);

  const { value: adminStatus } = useAsyncRetry(async () => coverageApi.getAdminStatus(), []);
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: catalogMetrics,
    loading: catalogLoading,
  } = useCatalogMetrics();

  const handleToggleIgnore = async (projectId: number) => {
    await coverageApi.toggleIgnore(projectId);
    retryCoverage();
  };

  const handleScan = async () => {
    try {
      await coverageApi.triggerScan();
      retryCoverage();
      retryHistory();
    } catch {
      // error handled by retry
    }
  };

  return (
    <>
      <HeaderPage
        title="Catalog Health"
        breadcrumbs={[
          { label: 'Home', href: '/' },
        ]}
      />
      <Container my="4">
        <Flex justify="between" align="center" mb="4">
          <Flex align="center" gap="2">
            <Text variant="body-medium" color="secondary">
              Track catalog registration, annotations, and ownership health at a glance
            </Text>
            <Link href="/catalog" style={{ whiteSpace: 'nowrap', textDecoration: 'underline', fontSize: 'var(--bui-font-size-2, 0.875rem)' }}>
              Catalog
            </Link>
          </Flex>
          <Flex align="center" gap="2">
            {coverage?.lastScannedAt && (
              <Text variant="body-x-small" color="secondary">
                Last scan: {new Date(coverage.lastScannedAt).toLocaleString()}
              </Text>
            )}
            <button
              onClick={handleScan}
              disabled={coverage?.scanning}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid var(--bui-color-border-default, #444)',
                background: 'var(--bui-color-background-elevation-2, #2a2a2a)',
                color: 'inherit',
                cursor: coverage?.scanning ? 'not-allowed' : 'pointer',
                opacity: coverage?.scanning ? 0.5 : 1,
                fontSize: '0.85rem',
              }}
            >
              <RiRefreshLine size={14} />
              {coverage?.scanning ? 'Scanning...' : 'Scan'}
            </button>
          </Flex>
        </Flex>

        <Tabs>
          <TabList>
            <Tab id="coverage">Catalog Coverage</Tab>
            <Tab id="annotations">Annotations</Tab>
            <Tab id="ownership">Ownership</Tab>
            <Tab id="api-docs">API Docs</Tab>
          </TabList>
          <TabPanel id="coverage">
            <Box mt="3">
              <CatalogCoverageTab
                coverage={coverage}
                groups={groups}
                history={history}
                loading={coverageLoading}
                error={coverageError}
                onScan={handleScan}
                onToggleIgnore={handleToggleIgnore}
                isAdmin={isAdmin}
              />
            </Box>
          </TabPanel>
          <TabPanel id="annotations">
            <Box mt="3">
              <AnnotationTab metrics={catalogMetrics} loading={catalogLoading} />
            </Box>
          </TabPanel>
          <TabPanel id="ownership">
            <Box mt="3">
              <OwnershipTab metrics={catalogMetrics} loading={catalogLoading} />
            </Box>
          </TabPanel>
          <TabPanel id="api-docs">
            <Box mt="3">
              <ApiDocTab metrics={catalogMetrics} loading={catalogLoading} />
            </Box>
          </TabPanel>
        </Tabs>
      </Container>
    </>
  );
};
