import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Alert,
  Box,
  ButtonIcon,
  Card,
  CardBody,
  CardFooter,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Button,
  Flex,
  Grid,
  Link,
  SearchField,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import {
  RiEditLine,
  RiHistoryLine,
  RiInformationLine,
  RiNotificationLine,
  RiNotificationOffLine,
} from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { argocdAppsetApiRef, ApplicationSetResponse, MUTE_ANNOTATION } from '../../api';
import { HighlightText } from '../HighlightText';
import './ApplicationSetTable.css';

export const ApplicationSetTable = () => {
  const api = useApi(argocdAppsetApiRef);

  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);
  const isAdmin = adminStatus?.isAdmin ?? false;

  const [searchQuery, setSearchQuery] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState<string>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [revisionFilter, setRevisionFilter] = useState<string>('all');
  const [overviewFilter, setOverviewFilter] = useState<'all' | 'notHead' | 'muted'>('all');

  const [mutingKey, setMutingKey] = useState<string | null>(null);
  const [localAppSets, setLocalAppSets] = useState<ApplicationSetResponse[] | undefined>(undefined);

  const {
    value: appSetsRaw,
    loading,
    error: loadError,
  } = useAsyncRetry(async () => {
    return api.listApplicationSets();
  }, []);

  const appSets = localAppSets ?? appSetsRaw;

  const { value: status } = useAsyncRetry(async () => {
    return api.getStatus();
  }, []);

  const totalCount = appSets?.length ?? 0;
  const nonHeadCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => !a.isHeadRevision).length;
  }, [appSets]);
  const totalApps = useMemo(() => {
    if (!appSets) return 0;
    return appSets.reduce((sum, a) => sum + a.applicationCount, 0);
  }, [appSets]);
  const mutedCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => a.muted).length;
  }, [appSets]);

  const uniqueNamespaces = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.map(a => a.namespace))].sort();
  }, [appSets]);

  const uniqueRepos = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.map(a => a.repoName).filter(Boolean))].sort();
  }, [appSets]);

  const uniqueRevisions = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.flatMap(a => a.targetRevisions))].sort();
  }, [appSets]);

  const filteredAppSets = useMemo(() => {
    if (!appSets) return [];
    return appSets
      .filter(a => {
        const matchesSearch =
          searchQuery === '' ||
          a.name.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesNamespace =
          namespaceFilter === 'all' || a.namespace === namespaceFilter;
        const matchesRepo =
          repoFilter === 'all' || a.repoName === repoFilter;
        const matchesRevision =
          revisionFilter === 'all' || a.targetRevisions.includes(revisionFilter);
        const matchesOverview =
          overviewFilter === 'all' ||
          (overviewFilter === 'notHead' && !a.isHeadRevision) ||
          (overviewFilter === 'muted' && a.muted);
        return matchesSearch && matchesNamespace && matchesRepo && matchesRevision && matchesOverview;
      })
      .sort((a, b) => Number(a.isHeadRevision) - Number(b.isHeadRevision));
  }, [appSets, searchQuery, namespaceFilter, repoFilter, revisionFilter, overviewFilter]);

  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const handleToggleMute = useCallback(async (namespace: string, name: string, muted: boolean) => {
    const key = `${namespace}/${name}`;
    setMutingKey(key);
    try {
      if (muted) {
        await api.unmute(namespace, name);
      } else {
        await api.mute(namespace, name);
      }
      setLocalAppSets(prev => {
        const source = prev ?? appSetsRaw;
        if (!source) return source;
        return source.map(a =>
          a.namespace === namespace && a.name === name
            ? { ...a, muted: !muted }
            : a,
        );
      });
    } catch {
      // silently fail — next fetch cycle will reflect actual state
    } finally {
      setMutingKey(null);
    }
  }, [api, appSetsRaw]);

  const [editRevisionKey, setEditRevisionKey] = useState<string | null>(null);
  const [editRevisionValue, setEditRevisionValue] = useState('');
  const [savingRevisionKey, setSavingRevisionKey] = useState<string | null>(null);

  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);

  useEffect(() => {
    if (!editRevisionKey || !appSets) return;
    const appSet = appSets.find(a => `${a.namespace}/${a.name}` === editRevisionKey);
    if (!appSet?.repoUrl) {
      setBranchesFailed(true);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesFailed(false);
    setBranches([]);
    setDefaultBranch(null);
    api.listBranches(appSet.repoUrl).then(
      result => {
        if (!cancelled) {
          setBranches(result.branches);
          setDefaultBranch(result.defaultBranch);
          setBranchesLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setBranchesFailed(true);
          setBranchesLoading(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [editRevisionKey, appSets, api]);

  const handleSaveTargetRevision = useCallback(async (namespace: string, name: string) => {
    const key = `${namespace}/${name}`;
    const trimmed = editRevisionValue.trim();
    if (!trimmed) return;
    setSavingRevisionKey(key);
    try {
      await api.setTargetRevision(namespace, name, trimmed);
      setLocalAppSets(prev => {
        const source = prev ?? appSetsRaw;
        if (!source) return source;
        const isDynamic = (rev: string) => /\{\{.*\}\}/.test(rev);
        const isHead = trimmed === 'HEAD' || trimmed === '' || isDynamic(trimmed);
        return source.map(a =>
          a.namespace === namespace && a.name === name
            ? { ...a, targetRevisions: [trimmed], isHeadRevision: isHead }
            : a,
        );
      });
      setEditRevisionKey(null);
    } catch {
      // silently fail — next fetch cycle will reflect actual state
    } finally {
      setSavingRevisionKey(null);
    }
  }, [api, appSetsRaw, editRevisionValue]);

  if (loading) {
    return (
      <Flex direction="column" gap="3" mt="4">
        <Skeleton width="100%" height={60} />
        <Skeleton width="100%" height={40} />
        <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
          {[1, 2, 3, 4].map(i => (
            <Grid.Item key={i}>
              <Skeleton width="100%" height={200} />
            </Grid.Item>
          ))}
        </Grid.Root>
      </Flex>
    );
  }

  if (loadError) {
    return (
      <Flex direction="column" gap="2" mt="4">
        <Alert status="danger" title="Failed to load ApplicationSets" />
        <Text variant="body-small" color="secondary">
          {loadError.message}
        </Text>
      </Flex>
    );
  }

  if (!appSets || appSets.length === 0) {
    return (
      <Flex direction="column" align="center" gap="2" className="appset-empty-state">
        <Text variant="body-large" color="secondary">
          No ApplicationSets found
        </Text>
        <Text variant="body-small" color="secondary">
          Ensure the backend has access to the Kubernetes cluster with ArgoCD ApplicationSets
        </Text>
      </Flex>
    );
  }

  const namespaceOptions = [
    { value: 'all', label: 'All' },
    ...uniqueNamespaces.map(ns => ({ value: ns, label: ns })),
  ];

  const repoOptions = [
    { value: 'all', label: 'All' },
    ...uniqueRepos.map(repo => ({ value: repo, label: repo })),
  ];

  const revisionOptions = [
    { value: 'all', label: 'All' },
    ...uniqueRevisions.map(rev => ({ value: rev, label: rev })),
  ];

  return (
    <>
      {/* Overview Section */}
      <Box mt="4" p="3" className="appset-section-box">
        <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
          <Text variant="body-medium" weight="bold">
            Overview
          </Text>
          {status && (
            <TooltipTrigger delay={200}>
              <Button
                variant="tertiary"
                size="small"
                className={`appset-integration-badge ${status.slackConfigured ? 'appset-integration-connected' : 'appset-integration-disconnected'}`}
              >
                Webhook {status.slackConfigured ? 'Connected' : 'Not configured'}
              </Button>
              <Tooltip style={{ maxWidth: 280 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700 }}>Slack Incoming Webhook</div>
                  <div>Status: {status.slackConfigured ? 'Configured' : 'Not configured'}</div>
                  <div>Usage: Sends non-HEAD revision alerts to Slack channel</div>
                  <div style={{ opacity: 0.7 }}>Last checked: {new Date().toLocaleString()}</div>
                </div>
              </Tooltip>
            </TooltipTrigger>
          )}
        </Flex>
        <div className="appset-summary-bar">
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalCount}</Text>
            <Text variant="body-x-small" color="secondary">ApplicationSets</Text>
          </div>
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalApps}</Text>
            <Text variant="body-x-small" color="secondary">Total Apps</Text>
          </div>
          <div
            className={`appset-summary-card appset-summary-clickable ${overviewFilter === 'notHead' ? 'appset-summary-active' : ''}`}
            onClick={() => setOverviewFilter(prev => prev === 'notHead' ? 'all' : 'notHead')}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOverviewFilter(prev => prev === 'notHead' ? 'all' : 'notHead'); }}
          >
            <Text weight="bold" color={nonHeadCount > 0 ? 'warning' : undefined} className="appset-summary-value">
              {nonHeadCount}
            </Text>
            <Text variant="body-x-small" color="secondary">Not HEAD</Text>
          </div>
          <div
            className={`appset-summary-card appset-summary-clickable ${overviewFilter === 'muted' ? 'appset-summary-active' : ''}`}
            onClick={() => setOverviewFilter(prev => prev === 'muted' ? 'all' : 'muted')}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOverviewFilter(prev => prev === 'muted' ? 'all' : 'muted'); }}
          >
            <Text weight="bold" className="appset-summary-value">{mutedCount}</Text>
            <Text variant="body-x-small" color="secondary">Muted</Text>
            <TooltipTrigger delay={200}>
              <ButtonIcon
                size="small"
                variant="tertiary"
                icon={<RiInformationLine size={14} />}
                aria-label="Muted info"
                className="appset-muted-info-btn"
              />
              <Tooltip>{`ApplicationSets with ${MUTE_ANNOTATION} annotation are excluded from Slack notifications.`}</Tooltip>
            </TooltipTrigger>
          </div>
          {status && (
            <div className="appset-summary-card">
              <Text variant="body-x-small" weight="bold" className="appset-cron-badge">
                {status.cron}
              </Text>
              <Text variant="body-x-small" color="secondary">
                Schedule (UTC)
              </Text>
            </div>
          )}
          {status?.lastFetchedAt && (
            <div className="appset-summary-card">
              <Text variant="body-x-small" color="secondary">
                Last fetched {new Date(status.lastFetchedAt).toLocaleString()}
              </Text>
            </div>
          )}
        </div>
      </Box>

      {/* Filters Section */}
      <Box mt="3" p="3" className="appset-section-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <div className="appset-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by name..."
            size="small"
            value={searchQuery}
            onChange={setSearchQuery}
          />
          <Select
            label="Namespace"
            size="small"
            options={namespaceOptions}
            selectedKey={namespaceFilter}
            onSelectionChange={key => setNamespaceFilter(key as string)}
          />
          <Select
            label="Repository"
            size="small"
            options={repoOptions}
            selectedKey={repoFilter}
            onSelectionChange={key => setRepoFilter(key as string)}
          />
          <Select
            label="Target Revision"
            size="small"
            options={revisionOptions}
            selectedKey={revisionFilter}
            onSelectionChange={key => setRevisionFilter(key as string)}
          />
        </div>
      </Box>

      {/* ApplicationSets Section */}
      <Box mt="3" p="3" className="appset-section-box">
        <Flex justify="between" align="center" mb="3">
          <Text variant="body-medium" weight="bold">
            ApplicationSets
          </Text>
          <Flex align="center" gap="2">
            <span className="appset-count-badge">
              {filteredAppSets.length !== totalCount
                ? `${filteredAppSets.length} / ${totalCount}`
                : totalCount}
            </span>
            <Text variant="body-small" color="secondary">results</Text>
          </Flex>
        </Flex>

        {filteredAppSets.length === 0 ? (
          <div className="appset-empty-state">
            <Text variant="body-medium" color="secondary">
              No ApplicationSets match the current filters
            </Text>
          </div>
        ) : (
          <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
            {filteredAppSets.map(appSet => {
              const cardKey = `${appSet.namespace}/${appSet.name}`;
              const isMuting = mutingKey === cardKey;

              return (
                <Grid.Item key={cardKey} className="appset-grid-item">
                  <Card className={`${appSet.isHeadRevision ? 'appset-card' : 'appset-card-warning'}${appSet.muted ? ' appset-card-muted' : ''}`}>
                    <CardBody className="appset-card-body">
                      <div>
                        <Text variant="body-medium" className="appset-card-name">
                          <Text as="span" variant="body-medium" color="secondary">{appSet.namespace}</Text>
                          {' / '}
                          <HighlightText text={appSet.name} query={searchQuery} />
                        </Text>
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Generators
                        </Text>
                        <TagGroup>
                          {appSet.generators.map((gen, i) => (
                            <Tag key={i} id={`gen-${i}`} size="small">{gen}</Tag>
                          ))}
                        </TagGroup>
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Repository
                        </Text>
                        {appSet.repoName ? (
                          appSet.repoUrl ? (
                            <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                              <Text variant="body-small">{appSet.repoName}</Text>
                            </Link>
                          ) : (
                            <Text variant="body-small">{appSet.repoName}</Text>
                          )
                        ) : (
                          <Text variant="body-small" color="secondary">-</Text>
                        )}
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Target Revision
                        </Text>
                        <div className="appset-revision-row">
                          <TagGroup>
                            {appSet.targetRevisions.map((rev, i) => (
                              <Tag key={i} id={`rev-${i}`} size="small">{rev}</Tag>
                            ))}
                          </TagGroup>
                          {isAdmin && (
                            <DialogTrigger
                              isOpen={editRevisionKey === cardKey}
                              onOpenChange={open => {
                                if (open) {
                                  setEditRevisionKey(cardKey);
                                  setEditRevisionValue(appSet.targetRevisions[0] ?? 'HEAD');
                                } else {
                                  setEditRevisionKey(null);
                                }
                              }}
                            >
                              <ButtonIcon
                                size="small"
                                variant="tertiary"
                                icon={<RiEditLine size={14} />}
                                aria-label="Edit target revision"
                                className="appset-edit-revision-btn"
                              />
                              <Dialog>
                                <DialogHeader>Edit Target Revision</DialogHeader>
                                <DialogBody>
                                  <Flex direction="column" gap="3">
                                    <Flex direction="column" gap="1">
                                      <Text variant="body-x-small" color="secondary" weight="bold">ApplicationSet</Text>
                                      <Text variant="body-medium">{appSet.name}</Text>
                                    </Flex>
                                    <Flex direction="column" gap="1">
                                      <Text variant="body-x-small" color="secondary" weight="bold">Repository</Text>
                                      {appSet.repoUrl ? (
                                        <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                                          <Text variant="body-medium">{appSet.repoName}</Text>
                                        </Link>
                                      ) : (
                                        <Text variant="body-medium">{appSet.repoName || '-'}</Text>
                                      )}
                                    </Flex>
                                    <Flex direction="column" gap="1">
                                      <Flex align="center" gap="2">
                                        <Text variant="body-x-small" color="secondary" weight="bold">Target Revision <Text as="span" variant="body-x-small" color="danger">*</Text></Text>
                                        {branchesLoading ? (
                                          <Skeleton width={24} height={18} rounded />
                                        ) : !branchesFailed && (
                                          <span style={{
                                            fontSize: 11,
                                            lineHeight: '18px',
                                            padding: '0 6px',
                                            borderRadius: 9,
                                            backgroundColor: 'var(--bui-color-background-neutral)',
                                            color: 'var(--bui-color-text-secondary)',
                                          }}>
                                            {branches.length} branches
                                          </span>
                                        )}
                                      </Flex>
                                      {branchesLoading ? (
                                        <Skeleton width="100%" height={40} />
                                      ) : branchesFailed ? (
                                        <TextField
                                          aria-label="Target Revision"
                                          value={editRevisionValue}
                                          onChange={setEditRevisionValue}
                                          autoFocus
                                        />
                                      ) : (
                                        <Select
                                          aria-label="Target Revision"
                                          searchable
                                          options={[
                                            { value: 'HEAD', label: 'HEAD' },
                                            ...branches.map(b => ({
                                              value: b,
                                              label: b === defaultBranch ? `${b} (default)` : b,
                                            })),
                                          ]}
                                          selectedKey={editRevisionValue}
                                          onSelectionChange={key => setEditRevisionValue(key as string)}
                                        />
                                      )}
                                    </Flex>
                                  </Flex>
                                </DialogBody>
                                <DialogFooter>
                                  <Flex gap="2" justify="end">
                                    <Button
                                      variant="secondary"
                                      onPress={() => setEditRevisionKey(null)}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      variant="primary"
                                      onPress={() => handleSaveTargetRevision(appSet.namespace, appSet.name)}
                                      isDisabled={savingRevisionKey === cardKey || editRevisionValue.trim() === ''}
                                    >
                                      {savingRevisionKey === cardKey ? 'Saving...' : 'Save'}
                                    </Button>
                                  </Flex>
                                </DialogFooter>
                              </Dialog>
                            </DialogTrigger>
                          )}
                        </div>
                        {!appSet.isHeadRevision && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f59e0b', fontSize: 12, marginTop: 4 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                            </svg>
                            Not HEAD
                          </span>
                        )}
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Applications ({appSet.syncedCount} / {appSet.applicationCount} Synced)
                        </Text>
                        {appSet.applications.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {appSet.applications.map(app => {
                              const status = appSet.applicationStatuses?.[app] ?? 'Unknown';
                              const badgeClass =
                                status === 'Synced' ? 'appset-app-synced'
                                : status === 'OutOfSync' ? 'appset-app-outofsync'
                                : 'appset-app-unknown';
                              return (
                                <TooltipTrigger key={app} delay={200}>
                                  <ButtonIcon
                                    size="small"
                                    variant="tertiary"
                                    className={`appset-app-badge ${badgeClass}`}
                                    icon={<span>{app.charAt(0).toUpperCase()}</span>}
                                    aria-label={`${app} (${status})`}
                                  />
                                  <Tooltip className="appset-apps-tooltip">
                                    {app} — {status}
                                  </Tooltip>
                                </TooltipTrigger>
                              );
                            })}
                          </div>
                        ) : (
                          <Text variant="body-small" color="secondary">-</Text>
                        )}
                      </div>
                    </CardBody>

                    <CardFooter className="appset-card-footer">
                      <Text variant="body-x-small" color="secondary">
                        Created {formatDate(appSet.createdAt)}
                      </Text>
                      <Flex align="center" gap="0">
                        <TooltipTrigger>
                          <Link href={`/argocd-appset/audit-logs/${encodeURIComponent(appSet.namespace)}/${encodeURIComponent(appSet.name)}`}>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={<RiHistoryLine size={18} />}
                              aria-label="View change history"
                            />
                          </Link>
                          <Tooltip>View change history</Tooltip>
                        </TooltipTrigger>
                        {isAdmin && (
                          <TooltipTrigger>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={
                                isMuting
                                  ? <Skeleton width={18} height={18} rounded />
                                  : appSet.muted
                                    ? <RiNotificationOffLine size={18} />
                                    : <RiNotificationLine size={18} />
                              }
                              onPress={() => handleToggleMute(appSet.namespace, appSet.name, appSet.muted)}
                              isDisabled={isMuting}
                              aria-label={appSet.muted ? 'Unmute notifications' : 'Mute notifications'}
                            />
                            <Tooltip>{appSet.muted ? 'Unmute notifications' : 'Mute notifications'}</Tooltip>
                          </TooltipTrigger>
                        )}
                      </Flex>
                    </CardFooter>
                  </Card>
                </Grid.Item>
              );
            })}
          </Grid.Root>
        )}
      </Box>

    </>
  );
};
