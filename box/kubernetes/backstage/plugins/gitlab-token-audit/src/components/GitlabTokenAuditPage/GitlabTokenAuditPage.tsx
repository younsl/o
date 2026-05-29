import React, { useCallback, useMemo, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  ButtonIcon,
  Cell,
  CellText,
  Container,
  Flex,
  Link,
  PluginHeader,
  SearchField,
  Select,
  Table,
  Tag,
  TagGroup,
  Text,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { RiKeyLine } from '@remixicon/react';
import { gitlabTokenAuditPlugin } from '../../plugin';
import { TokenCalendarView } from '../TokenCalendarView';

const ExternalLinkIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

import { TokenDetailPage } from '../TokenDetailPage';
import type { TextColorStatus, TextColors } from '@backstage/ui';
import type { ColumnConfig, SortDescriptor } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { gitlabTokenAuditApiRef } from '../../api';
import { GitlabToken, GitlabTokenState, WebhookConfig } from '../../api/types';
import './GitlabTokenAuditPage.css';

interface TokenRow extends GitlabToken {
  id: number;
  rowKey: string;
}

const STATE_COLORS: Record<GitlabTokenState, TextColorStatus | TextColors> = {
  active: 'success',
  expired: 'danger',
  revoked: 'secondary',
  inactive: 'secondary',
};

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : '—';

const formatRelativeDaysAgo = (iso: string | null): string | undefined => {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  const days = Math.floor(ms / 86_400_000);
  if (days < 0) return 'in the future';
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
};

const formatDaysLeft = (days: number | null) => {
  if (days === null) return 'No expiry';
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days === 0) return 'Today';
  return `${days} days`;
};

const expiryTextColor = (
  days: number | null,
  state: GitlabTokenState,
): 'danger' | 'warning' | 'primary' | 'secondary' => {
  if (state !== 'active') return 'secondary';
  if (days === null) return 'secondary';
  if (days < 0) return 'danger';
  if (days <= 7) return 'danger';
  if (days <= 30) return 'warning';
  return 'primary';
};

interface RemainLabelProps {
  days: number | null;
  state: GitlabTokenState;
}

const RemainLabel = ({ days, state }: RemainLabelProps) => {
  if (days === null) {
    return (
      <Text variant="body-x-small" color="secondary">
        No expiry
      </Text>
    );
  }
  const label = days < 0 ? `-${Math.abs(days)}d` : `${days}d`;
  return (
    <Text
      variant="body-small"
      weight="bold"
      color={expiryTextColor(days, state)}
    >
      {label}
    </Text>
  );
};

const TokenListPage = () => {
  const api = useApi(gitlabTokenAuditApiRef);

  const { value: adminStatus, loading: adminLoading } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: status,
    retry: refetchStatus,
  } = useAsyncRetry(async () => {
    if (!isAdmin) return undefined;
    return api.getStatus();
  }, [isAdmin]);

  // Health-check GitLab every 60s by re-polling /status (backend caches the
  // /version probe for 60s, so this acts as a 1-minute latency probe).
  React.useEffect(() => {
    if (!isAdmin) return undefined;
    const id = setInterval(() => {
      refetchStatus();
    }, 60_000);
    return () => clearInterval(id);
  }, [isAdmin, refetchStatus]);

  const {
    value: tokens,
    loading: tokensLoading,
    error: tokensError,
    retry: refetchTokens,
  } = useAsyncRetry(async () => {
    if (!isAdmin) return [] as GitlabToken[];
    return api.listTokens();
  }, [isAdmin]);

  const [webhook, setWebhook] = useState<WebhookConfig | null | undefined>(undefined);

  const loadWebhook = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const w = await api.getWebhook();
      setWebhook(w);
    } catch {
      setWebhook(null);
    }
  }, [api, isAdmin]);

  React.useEffect(() => {
    loadWebhook();
  }, [loadWebhook]);

  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<
    'all' | GitlabTokenState | 'expiringSoon'
  >('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'personal' | 'project' | 'group'>(
    'all',
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  // Default: tokens with the shortest time-to-expiry on top of Remaining.
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'remaining',
    direction: 'ascending',
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await api.refresh();
      refetchTokens();
      refetchStatus();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const filtered: TokenRow[] = useMemo(() => {
    const lower = search.toLowerCase();
    return (tokens ?? [])
      .filter(t => {
        if (stateFilter === 'all') return true;
        if (stateFilter === 'expiringSoon') {
          return (
            t.state === 'active' &&
            t.daysUntilExpiry !== null &&
            t.daysUntilExpiry >= 0 &&
            t.daysUntilExpiry <= 30
          );
        }
        return t.state === stateFilter;
      })
      .filter(t => kindFilter === 'all' || t.kind === kindFilter)
      .filter(
        t =>
          !lower ||
          t.name.toLowerCase().includes(lower) ||
          (t.userName ?? '').toLowerCase().includes(lower) ||
          (t.ownerScope ?? '').toLowerCase().includes(lower),
      )
      .map(t => ({
        ...t,
        rowKey: `${t.kind}:${t.ownerScope ?? 'pat'}:${t.id}`,
      }));
  }, [tokens, search, stateFilter, kindFilter]);

  const sorted: TokenRow[] = useMemo(() => {
    const dir = sortDescriptor.direction === 'descending' ? -1 : 1;
    const col = String(sortDescriptor.column ?? 'expires');
    const compare = (a: TokenRow, b: TokenRow): number => {
      switch (col) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'owner': {
          const ao =
            a.kind === 'personal'
              ? a.userName ?? String(a.userId ?? '')
              : a.ownerScope ?? '';
          const bo =
            b.kind === 'personal'
              ? b.userName ?? String(b.userId ?? '')
              : b.ownerScope ?? '';
          return ao.localeCompare(bo);
        }
        case 'state':
          return a.state.localeCompare(b.state);
        case 'expires':
        case 'remaining': {
          // Order by "imminence": active tokens about to expire come first,
          // then already-expired tokens, then tokens with no expiry.
          // Within each group: smaller absolute remaining wins.
          const rank = (t: TokenRow): { group: number; value: number } => {
            const d = t.daysUntilExpiry;
            if (d === null) return { group: 3, value: 0 };
            if (d < 0) return { group: 2, value: -d };
            return { group: 1, value: d };
          };
          const ra = rank(a);
          const rb = rank(b);
          if (ra.group !== rb.group) return ra.group - rb.group;
          if (ra.value === rb.value) return 0;
          return ra.value < rb.value ? -1 : 1;
        }
        case 'lastUsed': {
          const at = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
          const bt = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
          return at - bt;
        }
        case 'created': {
          const at = new Date(a.createdAt).getTime();
          const bt = new Date(b.createdAt).getTime();
          return at - bt;
        }
        default:
          return 0;
      }
    };
    return [...filtered].sort((a, b) => compare(a, b) * dir);
  }, [filtered, sortDescriptor]);

  const totals = useMemo(() => {
    const list = tokens ?? [];
    return {
      total: list.length,
      active: list.filter(t => t.state === 'active').length,
      expired: list.filter(t => t.state === 'expired').length,
      expiringSoon: list.filter(
        t =>
          t.state === 'active' &&
          t.daysUntilExpiry !== null &&
          t.daysUntilExpiry <= 30,
      ).length,
    };
  }, [tokens]);

  const columns: ColumnConfig<TokenRow>[] = useMemo(
    () => [
      {
        id: 'name',
        label: 'Name',
        isRowHeader: true,
        isSortable: true,
        defaultWidth: '2fr',
        minWidth: 140,
        cell: row => {
          const description =
            row.kind === 'personal'
              ? 'Personal Access Token'
              : row.kind === 'project'
              ? 'Project Access Token'
              : 'Group Access Token';
          return (
            <Cell>
              <Flex direction="column" gap="0.5">
                <Flex align="center" gap="1">
                  <Text variant="body-small" weight="bold" truncate>
                    {row.name}
                  </Text>
                  {row.webUrl && (
                    <TooltipTrigger delay={200}>
                      <Link
                        href={row.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${row.name} in GitLab`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          opacity: 0.7,
                        }}
                      >
                        <ExternalLinkIcon />
                      </Link>
                      <Tooltip>Open in GitLab</Tooltip>
                    </TooltipTrigger>
                  )}
                </Flex>
                <Text variant="body-x-small" color="secondary">
                  {description}
                </Text>
              </Flex>
            </Cell>
          );
        },
      },
      {
        id: 'owner',
        label: 'Owner',
        isSortable: true,
        defaultWidth: '1.5fr',
        minWidth: 130,
        cell: row => {
          if (row.kind === 'personal') {
            const label = row.userName
              ? `@${row.userName}`
              : row.userId
              ? `user #${row.userId}`
              : '—';
            return <CellText title={label} description="user" />;
          }
          return (
            <CellText
              title={row.ownerScope ?? '—'}
              description={row.kind === 'project' ? 'project' : 'group'}
            />
          );
        },
      },
      {
        id: 'state',
        label: 'State',
        isSortable: true,
        defaultWidth: 90,
        minWidth: 80,
        maxWidth: 120,
        cell: row => (
          <Cell>
            <Text
              variant="body-x-small"
              weight="bold"
              color={STATE_COLORS[row.state]}
            >
              {row.state.toUpperCase()}
            </Text>
          </Cell>
        ),
      },
      {
        id: 'expires',
        label: 'Expires',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 100,
        cell: row => <CellText title={formatDate(row.expiresAt)} />,
      },
      {
        id: 'remaining',
        label: 'Remain',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 90,
        cell: row => (
          <Cell>
            <RemainLabel days={row.daysUntilExpiry} state={row.state} />
          </Cell>
        ),
      },
      {
        id: 'lastUsed',
        label: 'Last used',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 110,
        cell: row => (
          <CellText
            title={row.lastUsedAt ? formatDate(row.lastUsedAt) : 'Never used'}
            description={formatRelativeDaysAgo(row.lastUsedAt)}
          />
        ),
      },
      {
        id: 'created',
        label: 'Created',
        isSortable: true,
        defaultWidth: '1fr',
        minWidth: 110,
        cell: row => (
          <CellText
            title={formatDate(row.createdAt)}
            description={formatRelativeDaysAgo(row.createdAt)}
          />
        ),
      },
      {
        id: 'scopes',
        label: 'Scopes',
        defaultWidth: '1.5fr',
        minWidth: 130,
        cell: row => (
          <Cell>
            {row.scopes.length === 0 ? (
              <Text variant="body-small" color="secondary">—</Text>
            ) : (
              <TagGroup>
                {row.scopes.map(s => (
                  <Tag key={s}>{s}</Tag>
                ))}
              </TagGroup>
            )}
          </Cell>
        ),
      },
    ],
    [],
  );

  if (adminLoading) {
    return (
      <>
        <PluginHeader
          icon={<RiKeyLine />}
          title="GitLab Token Audit"
          customActions={
            <TagGroup>
              <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
            </TagGroup>
          }
        />
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PluginHeader
          icon={<RiKeyLine />}
          title="GitLab Token Audit"
          customActions={
            <TagGroup>
              <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
            </TagGroup>
          }
        />
        <Container my="4">
          <Alert
            status="warning"
            title="Administrator access required"
            description="This page shows GitLab token audit data and is restricted to administrators. To request access, contact your DevOps team and ask to be added to the Backstage admin list."
          />
        </Container>
      </>
    );
  }

  return (
    <>
      <PluginHeader
          icon={<RiKeyLine />}
          title="GitLab Token Audit"
          customActions={
            <TagGroup>
              <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
            </TagGroup>
          }
        />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Track GitLab personal, project, and group access token expirations.
          Webhook notifications are sent when tokens approach configured thresholds.
        </Text>

        <Box mt="4" p="3" style={{ background: 'var(--bui-color-bg-elevated, #1a1a1a)', borderRadius: 8 }}>
          <Flex justify="between" align="center" mb="3" style={{ flexWrap: 'wrap' }} gap="2">
            <Text variant="body-medium" weight="bold">Overview</Text>
            <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
              {status?.lastFetchedAt && (
                <Text variant="body-x-small" color="secondary">
                  Last fetched {new Date(status.lastFetchedAt).toLocaleString()}
                </Text>
              )}
              <TooltipTrigger delay={200}>
                <Button
                  variant="tertiary"
                  size="small"
                  className={`gta-integration-badge ${
                    webhook?.enabled
                      ? 'gta-integration-connected'
                      : webhook
                      ? 'gta-integration-disabled'
                      : 'gta-integration-disconnected'
                  }`}
                >
                  Webhook{' '}
                  {webhook?.enabled
                    ? 'Connected'
                    : webhook
                    ? 'Disabled'
                    : 'Not configured'}
                </Button>
                <Tooltip style={{ maxWidth: 280 }}>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>Webhook</div>
                    <div>
                      Status:{' '}
                      {webhook?.enabled
                        ? 'Connected'
                        : webhook
                        ? 'Saved but disabled'
                        : 'Not configured'}
                    </div>
                    {webhook && (
                      <div style={{ wordBreak: 'break-all' }}>
                        URL: {webhook.url}
                      </div>
                    )}
                    {webhook && (
                      <div>
                        Thresholds: {webhook.daysBefore.join(', ')} days
                      </div>
                    )}
                    <div>Usage: Sends GitLab token expiry alerts</div>
                  </div>
                </Tooltip>
              </TooltipTrigger>
            </Flex>
          </Flex>

          <Flex gap="3" style={{ flexWrap: 'wrap' }}>
            {status?.server?.host && (
              <Box
                p="3"
                style={{
                  background: 'var(--bui-bg-neutral-2, rgba(255,255,255,0.04))',
                  border: '1px solid var(--bui-border-1, rgba(255,255,255,0.08))',
                  borderRadius: 'var(--bui-radius-3, 6px)',
                  minWidth: 200,
                }}
              >
                <Flex direction="column" gap="1">
                  <Text as="div" variant="body-x-small" color="secondary">
                    GitLab Server
                    {typeof status.server.latencyMs === 'number' && (
                      <>
                        {' · '}
                        <span
                          style={{
                            color: status.server.healthy
                              ? '#22c55e'
                              : '#ef4444',
                            fontWeight: 700,
                          }}
                        >
                          {status.server.latencyMs}ms
                        </span>
                      </>
                    )}
                  </Text>
                  <Text as="div" variant="body-small" weight="bold">
                    <Link
                      href={status.server.webBaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {status.server.host}
                    </Link>
                  </Text>
                  {status.server.version && (
                    <Text
                      as="div"
                      variant="body-x-small"
                      color="secondary"
                    >
                      v{status.server.version}
                      {status.server.enterprise ? ' (EE)' : ''}
                    </Text>
                  )}
                </Flex>
              </Box>
            )}
            {(
              [
                { key: 'all', label: 'Total', value: totals.total, accent: undefined },
                { key: 'active', label: 'Active', value: totals.active, accent: undefined },
                {
                  key: 'expiringSoon',
                  label: 'Expiring ≤30d',
                  value: totals.expiringSoon,
                  accent: totals.expiringSoon > 0 ? ('warning' as const) : undefined,
                },
                {
                  key: 'expired',
                  label: 'Expired',
                  value: totals.expired,
                  accent: totals.expired > 0 ? ('danger' as const) : undefined,
                },
              ] as const
            ).map(card => {
              const selected = stateFilter === card.key;
              return (
                <Box
                  key={card.key}
                  p="3"
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() =>
                    setStateFilter(prev =>
                      prev === card.key ? 'all' : (card.key as any),
                    )
                  }
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setStateFilter(prev =>
                        prev === card.key ? 'all' : (card.key as any),
                      );
                    }
                  }}
                  style={{
                    background: selected
                      ? 'var(--bui-bg-neutral-3, rgba(255,255,255,0.10))'
                      : 'var(--bui-bg-neutral-2, rgba(255,255,255,0.04))',
                    border: selected
                      ? '1px solid var(--bui-border-accent, #3b82f6)'
                      : '1px solid var(--bui-border-1, rgba(255,255,255,0.08))',
                    borderRadius: 'var(--bui-radius-3, 6px)',
                    minWidth: 120,
                    cursor: 'pointer',
                    transition:
                      'background-color 0.12s, border-color 0.12s',
                    outline: 'none',
                  }}
                >
                  <Flex direction="column" gap="1">
                    <Text
                      as="div"
                      weight="bold"
                      variant="title-medium"
                      color={card.accent}
                    >
                      {card.value}
                    </Text>
                    <Text as="div" variant="body-x-small" color="secondary">
                      {card.label}
                    </Text>
                  </Flex>
                </Box>
              );
            })}
          </Flex>
        </Box>

        <Box
          mt="4"
          p="3"
          style={{
            border: '1px solid var(--bui-color-border-default)',
            borderRadius: 6,
          }}
        >
          <Flex justify="between" align="center" mb="3" style={{ flexWrap: 'wrap' }} gap="2">
            <Text variant="body-medium" weight="bold">
              GitLab Tokens
            </Text>
            <Flex gap="2" align="center">
              <ToggleButtonGroup
                aria-label="View mode"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={new Set([viewMode])}
                onSelectionChange={keys => {
                  const first = Array.from(keys as Set<string>)[0];
                  if (first === 'list' || first === 'calendar') {
                    setViewMode(first);
                  }
                }}
              >
                <ToggleButton
                  id="list"
                  size="small"
                  className="gta-view-toggle-btn"
                >
                  List
                </ToggleButton>
                <ToggleButton
                  id="calendar"
                  size="small"
                  className="gta-view-toggle-btn"
                >
                  Calendar
                </ToggleButton>
              </ToggleButtonGroup>
              {(() => {
                const total = tokens?.length ?? 0;
                const hasActiveFilters =
                  !!search || stateFilter !== 'all' || kindFilter !== 'all';
                return (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
                        color: hasActiveFilters ? '#fff' : 'rgba(255,255,255,0.7)',
                      }}
                    >
                      {hasActiveFilters ? `${sorted.length} / ${total}` : total}
                    </span>
                    <Text variant="body-small" color="secondary">
                      tokens
                    </Text>
                  </span>
                );
              })()}
            </Flex>
          </Flex>

          <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }} mb="3">
            <Box style={{ flex: '1 1 240px', minWidth: 200 }}>
              <SearchField
                placeholder="Search name, user, or scope"
                value={search}
                onChange={setSearch}
              />
            </Box>
            <Select
              aria-label="State filter"
              selectedKey={stateFilter}
              onSelectionChange={key => setStateFilter(key as any)}
              options={[
                { value: 'all', label: 'All states' },
                { value: 'active', label: 'Active' },
                { value: 'expiringSoon', label: 'Expiring ≤30d' },
                { value: 'expired', label: 'Expired' },
                { value: 'revoked', label: 'Revoked' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
            <Select
              aria-label="Kind filter"
              selectedKey={kindFilter}
              onSelectionChange={key => setKindFilter(key as any)}
              options={[
                { value: 'all', label: 'All kinds' },
                { value: 'personal', label: 'Personal' },
                { value: 'project', label: 'Project' },
                { value: 'group', label: 'Group' },
              ]}
            />
            <Button
              variant="secondary"
              onPress={handleRefresh}
              isDisabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </Flex>

          {refreshError && (
            <Box mb="2">
              <Alert status="danger" title={refreshError} />
            </Box>
          )}

          {viewMode === 'list' ? (
            <Box
              style={{ overflowX: 'auto', width: '100%' }}
              className="gta-table-wrapper"
            >
              <Table<TokenRow>
                data={sorted}
                loading={tokensLoading}
                error={tokensError ?? undefined}
                columnConfig={columns}
                sort={{
                  descriptor: sortDescriptor,
                  onSortChange: setSortDescriptor,
                }}
                rowConfig={{
                  onClick: row =>
                    navigate(`tokens/${encodeURIComponent(row.rowKey)}`),
                }}
                pagination={{ type: 'none' }}
                emptyState={
                  <Box p="4">
                    <Text color="secondary">No tokens match the current filters.</Text>
                  </Box>
                }
              />
            </Box>
          ) : (
            <TokenCalendarView tokens={sorted} />
          )}
        </Box>

      </Container>
    </>
  );
};


export const GitlabTokenAuditPage = () => (
  <Routes>
    <Route path="/" element={<TokenListPage />} />
    <Route path="/tokens/:tokenKey" element={<TokenDetailPage />} />
  </Routes>
);
