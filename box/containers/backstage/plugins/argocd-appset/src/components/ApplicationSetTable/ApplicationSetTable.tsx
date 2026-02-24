import React, { useState, useMemo, useCallback } from 'react';
import {
  Alert,
  Box,
  ButtonIcon,
  Card,
  CardBody,
  CardFooter,
  Flex,
  Grid,
  Link,
  SearchField,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import {
  RiNotificationLine,
  RiNotificationOffLine,
} from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { argocdAppsetApiRef, ApplicationSetResponse } from '../../api';
import './ApplicationSetTable.css';

export const ApplicationSetTable = () => {
  const api = useApi(argocdAppsetApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [namespaceFilter, setNamespaceFilter] = useState<string>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [revisionFilter, setRevisionFilter] = useState<string>('all');

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
        return matchesSearch && matchesNamespace && matchesRepo && matchesRevision;
      })
      .sort((a, b) => Number(a.isHeadRevision) - Number(b.isHeadRevision));
  }, [appSets, searchQuery, namespaceFilter, repoFilter, revisionFilter]);

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
      <Box mt="4">
        <Alert status="danger" title={`Failed to load ApplicationSets: ${loadError.message}`} />
      </Box>
    );
  }

  if (!appSets || appSets.length === 0) {
    return (
      <div className="appset-empty-state">
        <Text variant="body-large" color="secondary">
          No ApplicationSets found
        </Text>
        <Text variant="body-small" color="secondary">
          Ensure the backend has access to the Kubernetes cluster with ArgoCD ApplicationSets
        </Text>
      </div>
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
      {/* Summary Section */}
      <Box mb="4" mt="4">
        <Text as="h3" variant="body-small" weight="bold" color="secondary" className="appset-section-title">
          Overview
        </Text>
        <div className="appset-summary-bar">
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalCount}</Text>
            <Text variant="body-x-small" color="secondary">ApplicationSets</Text>
          </div>
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalApps}</Text>
            <Text variant="body-x-small" color="secondary">Total Apps</Text>
          </div>
          <div className="appset-summary-card">
            <Text weight="bold" color={nonHeadCount > 0 ? 'warning' : undefined} className="appset-summary-value">
              {nonHeadCount}
            </Text>
            <Text variant="body-x-small" color="secondary">Not HEAD</Text>
          </div>
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{mutedCount}</Text>
            <Text variant="body-x-small" color="secondary">Muted</Text>
          </div>
          {status && (
            <div className="appset-summary-card">
              <Text variant="body-x-small" weight="bold" className="appset-cron-badge">
                {status.cron}
              </Text>
              <Text variant="body-x-small" color="secondary">
                Schedule {status.slackConfigured ? '(Slack ON)' : '(Slack OFF)'}
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

      {/* ApplicationSets Section */}
      <Box mt="4">
        <Text as="h3" variant="body-small" weight="bold" color="secondary" className="appset-section-title">
          ApplicationSets
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
                <Grid.Item key={cardKey}>
                  <Card className={`${appSet.isHeadRevision ? 'appset-card' : 'appset-card-warning'}${appSet.muted ? ' appset-card-muted' : ''}`}>
                    <CardBody className="appset-card-body">
                      <div className="appset-card-header">
                        <div>
                          <Text variant="body-medium" className="appset-card-name">
                            <Text as="span" variant="body-medium" color="secondary">{appSet.namespace}</Text>
                            {' / '}
                            {appSet.name}
                          </Text>
                        </div>
                        <div className="appset-app-count-badge">
                          <TooltipTrigger delay={200}>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              className="appset-app-count-trigger"
                              icon={<span>{appSet.applicationCount}</span>}
                              aria-label={`${appSet.applicationCount} applications`}
                            />
                            <Tooltip className="appset-apps-tooltip">
                              {appSet.applications.length > 0
                                ? appSet.applications.join(', ')
                                : 'No applications'}
                            </Tooltip>
                          </TooltipTrigger>
                          <Text variant="body-x-small" color="secondary" className="appset-app-count-label">
                            Apps
                          </Text>
                        </div>
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

                      {appSet.repoName && (
                        <div>
                          <Text variant="body-x-small" color="secondary" className="appset-field-label">
                            Repository
                          </Text>
                          <TagGroup>
                            <Tag id="repo" size="small">
                              {appSet.repoUrl ? (
                                <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                                  {appSet.repoName}
                                </Link>
                              ) : (
                                appSet.repoName
                              )}
                            </Tag>
                          </TagGroup>
                        </div>
                      )}

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Target Revision
                        </Text>
                        <TagGroup>
                          {appSet.targetRevisions.map((rev, i) => (
                            <Tag key={i} id={`rev-${i}`} size="small">{rev}</Tag>
                          ))}
                          {!appSet.isHeadRevision && (
                            <Tag id="not-head" size="small">Not HEAD</Tag>
                          )}
                        </TagGroup>
                      </div>
                    </CardBody>

                    <CardFooter className="appset-card-footer">
                      <Text variant="body-x-small" color="secondary">
                        Created {formatDate(appSet.createdAt)}
                      </Text>
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
