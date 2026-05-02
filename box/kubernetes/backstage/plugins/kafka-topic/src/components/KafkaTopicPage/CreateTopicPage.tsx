import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardBody,
  Flex,
  Select,
  Skeleton,
  Text,
  TextField,
} from '@backstage/ui';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { useAsyncRetry, useDebounce } from 'react-use';
import { kafkaTopicApiRef } from '../../api/KafkaTopicApi';
import { BatchCreateTopicResponse } from '../../api/types';
import { ClusterInfo } from './ClusterInfo';
import { TopicTable } from './TopicTable';
import { PartitionDistribution } from './PartitionDistribution';
import './CreateTopicPage.css';

const TOPIC_NAME_PATTERN = /^[a-zA-Z0-9._-]*$/;
const hasInvalidChars = (value: string) => value !== '' && !TOPIC_NAME_PATTERN.test(value);
const MAX_TOPICS = 20;

interface TopicEntryState {
  id: string;
  topicName: string;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const STEPS = [
  { key: 'cluster', label: 'Cluster Info', title: 'Select Cluster', description: 'Choose a Kafka cluster and review its broker architecture.' },
  { key: 'topics', label: 'Topics', title: 'Review Existing Topics', description: 'Check the current topics in this cluster to avoid duplicates.' },
  { key: 'config', label: 'Config', title: 'Configure Topics', description: 'Set the topic names, config preset, and cleanup policy.' },
  { key: 'create', label: 'Simulate & Create', title: 'Simulate & Create', description: 'Review partition distribution, simulate broker failures, and create the topics.' },
];

export const CreateTopicContent = ({ onBack }: { onBack: () => void }) => {
  const api = useApi(kafkaTopicApiRef);
  const identityApi = useApi(identityApiRef);
  const [step, setStep] = useState(0);

  const { value: currentUserRef } = useAsyncRetry(async () => {
    const identity = await identityApi.getBackstageIdentity();
    return identity.userEntityRef;
  }, [identityApi]);

  const { value: userRole } = useAsyncRetry(async () => api.getUserRole(), [api]);
  const reviewerList = userRole?.admins ?? [];

  const {
    value: clusters,
    loading,
    error: clustersError,
  } = useAsyncRetry(async () => api.getClusters(), [api]);

  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const currentClusterName = selectedCluster ?? clusters?.[0]?.name;
  const currentCluster = clusters?.find(c => c.name === currentClusterName);

  const {
    value: topics,
    loading: topicsLoading,
  } = useAsyncRetry(async () => {
    if (!currentClusterName) return [];
    return api.listTopics(currentClusterName);
  }, [api, currentClusterName]);

  const [topicEntries, setTopicEntries] = useState<TopicEntryState[]>([
    { id: generateId(), topicName: '' },
  ]);

  const configKeys = useMemo(
    () => Object.keys(currentCluster?.topicConfig ?? {}),
    [currentCluster],
  );
  const [trafficLevel, setTrafficLevel] = useState('');
  const [cleanupPolicy, setCleanupPolicy] = useState('delete');

  const [isCreating, setIsCreating] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchCreateTopicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedConfig = currentCluster?.topicConfig?.[trafficLevel];
  const isCompleted = batchResult !== null;

  // Debounced entries for duplicate checking
  const [debouncedEntries, setDebouncedEntries] = useState(topicEntries);
  useDebounce(() => setDebouncedEntries(topicEntries), 300, [topicEntries]);

  const topicPreviews = useMemo(() =>
    debouncedEntries.map(entry => entry.topicName.trim()),
  [debouncedEntries]);

  const duplicateChecks = useMemo(() =>
    topicPreviews.map((name, idx) => ({
      existsInCluster: name !== '' && (topics?.some(t => t.name === name) ?? false),
      existsInBatch: name !== '' && topicPreviews.some((n, i) => i !== idx && n === name),
    })),
  [topicPreviews, topics]);

  const hasAnyInvalidInput = topicEntries.some(e => hasInvalidChars(e.topicName));
  const hasAnyDuplicate = duplicateChecks.some(d => d.existsInCluster || d.existsInBatch);

  useEffect(() => {
    const keys = Object.keys(
      clusters?.find(c => c.name === currentClusterName)?.topicConfig ?? {},
    );
    setTrafficLevel(keys[0] ?? 'default');
    setTopicEntries([{ id: generateId(), topicName: '' }]);
    setCleanupPolicy('delete');
    setBatchResult(null);
    setError(null);
  }, [currentClusterName, clusters]);

  const canProceed = useMemo(() => {
    switch (step) {
      case 0: return !!currentClusterName;
      case 1: return true;
      case 2:
        return topicEntries.length > 0 &&
          topicEntries.every(e => e.topicName.trim() !== '') &&
          !hasAnyDuplicate && !hasAnyInvalidInput;
      default: return false;
    }
  }, [step, currentClusterName, topicEntries, hasAnyDuplicate, hasAnyInvalidInput]);

  const updateEntry = useCallback((id: string, value: string) => {
    setTopicEntries(prev => prev.map(e => e.id === id ? { ...e, topicName: value } : e));
  }, []);

  const addEntry = useCallback(() => {
    setTopicEntries(prev => [...prev, { id: generateId(), topicName: '' }]);
  }, []);

  const removeEntry = useCallback((id: string) => {
    setTopicEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setBatchResult(null);
    try {
      const response = await api.createTopicsBatch(currentClusterName!, {
        topicNames: topicEntries.map(e => e.topicName.trim()),
        trafficLevel: configKeys.length > 0 ? trafficLevel : undefined,
        cleanupPolicy,
      });
      setBatchResult(response);
    } catch (e: any) {
      const msg = e.body?.error ?? e.message ?? 'Failed to create topics';
      setError(typeof msg === 'string' ? msg : String(msg.message ?? msg));
    } finally {
      setIsCreating(false);
    }
  }, [api, currentClusterName, topicEntries, trafficLevel, configKeys, cleanupPolicy]);

  const handleCreateAnother = useCallback(() => {
    setStep(0);
    setTopicEntries([{ id: generateId(), topicName: '' }]);
    setCleanupPolicy('delete');
    setBatchResult(null);
    setError(null);
  }, []);

  const liveTopicNames = useMemo(() =>
    topicEntries.map(entry => entry.topicName.trim()),
  [topicEntries]);

  if (loading) {
    return (
      <Flex direction="column" gap="3">
        <Skeleton style={{ height: 40, borderRadius: 8 }} />
        <Skeleton style={{ height: 200, borderRadius: 8 }} />
      </Flex>
    );
  }

  if (clustersError || !clusters || clusters.length === 0) {
    return (
      <Text variant="body-medium" color="danger">
        {clustersError ? `Failed to load clusters: ${clustersError.message}` : 'No Kafka clusters configured.'}
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="5">
          <div className="kafka-stepper">
            {STEPS.map((s, i) => (
              <React.Fragment key={s.key}>
                {i > 0 && (
                  <div className={`kafka-step-line ${i <= step || isCompleted ? 'kafka-step-line-active' : ''}`} />
                )}
                <div
                  className={`kafka-step ${i < step && !isCompleted ? 'kafka-step-clickable' : ''}`}
                  role={i < step && !isCompleted ? 'button' : undefined}
                  tabIndex={i < step && !isCompleted ? 0 : undefined}
                  onClick={() => i < step && !isCompleted && setStep(i)}
                  onKeyDown={e => { if (i < step && !isCompleted && (e.key === 'Enter' || e.key === ' ')) setStep(i); }}
                >
                  <div
                    className={`kafka-step-circle ${
                      i < step || isCompleted
                        ? 'kafka-step-completed'
                        : i === step
                          ? 'kafka-step-active'
                          : 'kafka-step-upcoming'
                    }`}
                  >
                    {i < step || isCompleted ? '✓' : i + 1}
                  </div>
                  <Text
                    variant="body-x-small"
                    weight={i === step && !isCompleted ? 'bold' : undefined}
                    color={i > step && !isCompleted ? 'secondary' : undefined}
                  >
                    {s.label}
                  </Text>
                </div>
              </React.Fragment>
            ))}
          </div>

          {!isCompleted && (
            <Flex direction="column" gap="1">
              <Text variant="body-medium" weight="bold">{STEPS[step].title}</Text>
              <Text variant="body-small" color="secondary">{STEPS[step].description}</Text>
            </Flex>
          )}

          {step === 0 && (
            <Flex direction="column" gap="3">
              <Box style={{ minWidth: 240, width: 'fit-content' }}>
                <Select
                  label="Cluster"
                  selectedKey={currentClusterName}
                  onSelectionChange={key => setSelectedCluster(key as string)}
                  options={clusters.map(c => ({
                    label: c.name,
                    value: c.name,
                  }))}
                />
              </Box>
              {currentClusterName && <ClusterInfo clusterName={currentClusterName} />}
            </Flex>
          )}

          {step === 1 && (
            <details className="kafka-topics-details" open>
              <summary className="kafka-topics-summary">
                <Text variant="body-small" weight="bold">
                  Existing Topics ({topics?.length ?? 0})
                </Text>
                <Text variant="body-x-small" color="secondary">
                  Click to collapse
                </Text>
              </summary>
              <div className="kafka-topics-content">
                <TopicTable topics={topics ?? []} loading={topicsLoading} />
              </div>
            </details>
          )}

          {step === 2 && (
            <Flex direction="column" gap="3">
              {/* Common settings */}
              <Flex gap="3" style={{ flexWrap: 'wrap' }}>
                {configKeys.length > 0 && (
                  <Box style={{ minWidth: 160 }}>
                    <Select
                      label="Topic Config"
                      selectedKey={trafficLevel}
                      onSelectionChange={key => setTrafficLevel(key as string)}
                      options={configKeys.map(key => ({
                        label: key,
                        value: key,
                      }))}
                    />
                  </Box>
                )}
                <Box style={{ minWidth: 160 }}>
                  <Select
                    label="Cleanup Policy"
                    selectedKey={cleanupPolicy}
                    onSelectionChange={key => setCleanupPolicy(key as string)}
                    options={[
                      { label: 'delete (default)', value: 'delete' },
                      { label: 'compact', value: 'compact' },
                      { label: 'compact,delete', value: 'compact,delete' },
                    ]}
                  />
                </Box>
              </Flex>

              {selectedConfig && (
                <Card>
                  <CardBody>
                    <Flex direction="column" gap="2">
                      <Text variant="body-small" weight="bold">{trafficLevel} config</Text>
                      <Flex gap="4" style={{ flexWrap: 'wrap' }}>
                        <Flex direction="column" gap="1">
                          <Text variant="body-x-small" color="secondary">Partitions</Text>
                          <Text variant="body-medium" weight="bold">{selectedConfig.numPartitions}</Text>
                        </Flex>
                        <Flex direction="column" gap="1">
                          <Text variant="body-x-small" color="secondary">Replication Factor</Text>
                          <Text variant="body-medium" weight="bold">{selectedConfig.replicationFactor}</Text>
                        </Flex>
                        {selectedConfig.configEntries['min.insync.replicas'] && (
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">Min ISR</Text>
                            <Text variant="body-medium" weight="bold">{selectedConfig.configEntries['min.insync.replicas']}</Text>
                          </Flex>
                        )}
                        {selectedConfig.configEntries['retention.ms'] && (
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">Retention</Text>
                            <Text variant="body-medium" weight="bold">
                              {Math.round(Number(selectedConfig.configEntries['retention.ms']) / 86400000)}d ({Number(selectedConfig.configEntries['retention.ms']).toLocaleString()} ms)
                            </Text>
                          </Flex>
                        )}
                      </Flex>
                    </Flex>
                  </CardBody>
                </Card>
              )}

              {/* Topic entries */}
              <Flex direction="column" gap="2">
                <Text variant="body-small" weight="bold">
                  Topics ({topicEntries.length}/{MAX_TOPICS})
                </Text>
                {topicEntries.map((entry, idx) => {
                  const dupCheck = duplicateChecks[idx];
                  const entryHasInvalid = hasInvalidChars(entry.topicName);
                  const isDup = dupCheck?.existsInCluster || dupCheck?.existsInBatch;

                  return (
                    <div key={entry.id} className="kafka-topic-entry-row">
                      <Flex gap="2" align="center">
                        <span className="kafka-topic-entry-index">{idx + 1}</span>
                        <Box style={{ width: 280 }}>
                          <TextField
                            placeholder="e.g. money-charge"
                            value={entry.topicName}
                            onChange={v => updateEntry(entry.id, v)}
                            isRequired
                            isInvalid={entryHasInvalid || isDup}
                            size="small"
                          />
                        </Box>
                        <button
                          type="button"
                          className="kafka-topic-remove-btn"
                          disabled={topicEntries.length <= 1}
                          onClick={() => removeEntry(entry.id)}
                          aria-label="Remove topic"
                        >
                          ✕
                        </button>
                        {(isDup || entryHasInvalid) && (
                          <Text variant="body-x-small" color="danger">
                            {entryHasInvalid
                              ? 'Only letters, digits, periods, hyphens, and underscores'
                              : dupCheck?.existsInCluster
                                ? `"${entry.topicName.trim()}" already exists in ${currentClusterName}`
                                : `"${entry.topicName.trim()}" is duplicated in this batch`}
                          </Text>
                        )}
                      </Flex>
                    </div>
                  );
                })}
                {topicEntries.length < MAX_TOPICS && (
                  <Button variant="secondary" size="small" onPress={addEntry}>
                    + Add Topic
                  </Button>
                )}
              </Flex>
            </Flex>
          )}

          {step === 3 && (
            <Flex direction="column" gap="3">
              {!batchResult ? (
                <>
                  <Card>
                    <CardBody>
                      <Flex direction="column" gap="2">
                        <Text variant="body-small" weight="bold">Summary</Text>
                        <Flex gap="4" style={{ flexWrap: 'wrap' }}>
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">Cluster</Text>
                            <Text variant="body-small" weight="bold">{currentClusterName}</Text>
                          </Flex>
                          {selectedConfig && (
                            <>
                              <Flex direction="column" gap="1">
                                <Text variant="body-x-small" color="secondary">Config</Text>
                                <Text variant="body-small" weight="bold">{trafficLevel}</Text>
                              </Flex>
                              <Flex direction="column" gap="1">
                                <Text variant="body-x-small" color="secondary">Partitions</Text>
                                <Text variant="body-small" weight="bold">{selectedConfig.numPartitions}</Text>
                              </Flex>
                              <Flex direction="column" gap="1">
                                <Text variant="body-x-small" color="secondary">Replication Factor</Text>
                                <Text variant="body-small" weight="bold">{selectedConfig.replicationFactor}</Text>
                              </Flex>
                            </>
                          )}
                          {selectedConfig?.configEntries['min.insync.replicas'] && (
                            <Flex direction="column" gap="1">
                              <Text variant="body-x-small" color="secondary">Min ISR</Text>
                              <Text variant="body-small" weight="bold">{selectedConfig.configEntries['min.insync.replicas']}</Text>
                            </Flex>
                          )}
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">Cleanup Policy</Text>
                            <Text variant="body-small" weight="bold">
                              {cleanupPolicy}
                              {cleanupPolicy === 'delete' && (
                                <span className="kafka-review-default-hint"> (default)</span>
                              )}
                            </Text>
                          </Flex>
                          {selectedConfig?.configEntries['retention.ms'] && (
                            <Flex direction="column" gap="1">
                              <Text variant="body-x-small" color="secondary">Retention</Text>
                              <Text variant="body-small" weight="bold">
                                {Math.round(Number(selectedConfig.configEntries['retention.ms']) / 86400000)}d ({Number(selectedConfig.configEntries['retention.ms']).toLocaleString()}ms)
                              </Text>
                            </Flex>
                          )}
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">
                              {currentCluster?.requiresApproval ? 'Requester → Reviewer' : 'Requester'}
                            </Text>
                            <Text variant="body-small" weight="bold">
                              {currentUserRef ?? 'unknown'}
                              {currentCluster?.requiresApproval && reviewerList.length > 0 && (
                                <> → {reviewerList.join(', ')}</>
                              )}
                            </Text>
                          </Flex>
                        </Flex>
                      </Flex>
                    </CardBody>
                  </Card>

                  {/* Topic list */}
                  <Card>
                    <CardBody>
                      <Flex direction="column" gap="2">
                        <Flex justify="between" align="center">
                          <Text variant="body-small" weight="bold">Topic Names</Text>
                          <Text variant="body-x-small" color="secondary">{topicEntries.length} topics</Text>
                        </Flex>
                        <Flex direction="column" gap="1">
                          {liveTopicNames.map((name, i) => (
                            <Flex key={topicEntries[i].id} gap="2" align="center">
                              <span className="kafka-topic-entry-index">{i + 1}</span>
                              <Text variant="body-small" style={{ fontFamily: 'var(--bui-font-family-mono, monospace)' }}>
                                {name}
                              </Text>
                            </Flex>
                          ))}
                        </Flex>
                      </Flex>
                    </CardBody>
                  </Card>

                  {selectedConfig && (
                    <PartitionDistribution
                      numPartitions={selectedConfig.numPartitions}
                      replicationFactor={selectedConfig.replicationFactor}
                      brokerCount={currentCluster?.brokers.length ?? 0}
                    />
                  )}
                  <Button variant="primary" size="small" loading={isCreating} onPress={handleCreate}>
                    {currentCluster?.requiresApproval
                      ? `Submit ${topicEntries.length} Topic${topicEntries.length > 1 ? 's' : ''} for Approval`
                      : `Create ${topicEntries.length} Topic${topicEntries.length > 1 ? 's' : ''}`}
                  </Button>
                  {error && <Alert status="danger" title={error} />}
                </>
              ) : (
                <>
                  {/* Batch result */}
                  {batchResult.results.every(r => r.status === 'pending') ? (
                    <Alert
                      status="info"
                      title={`${batchResult.results.length} topic${batchResult.results.length > 1 ? 's' : ''} submitted for approval in ${currentClusterName}`}
                    />
                  ) : batchResult.results.every(r => r.status === 'created') ? (
                    <Alert
                      status="success"
                      title={`${batchResult.results.length} topic${batchResult.results.length > 1 ? 's' : ''} created successfully in ${currentClusterName}`}
                    />
                  ) : (
                    <Alert
                      status="danger"
                      title={`${batchResult.results.filter(r => r.status !== 'failed').length} succeeded, ${batchResult.results.filter(r => r.status === 'failed').length} failed in ${currentClusterName}`}
                    />
                  )}

                  <div className="kafka-batch-results">
                    <table className="kafka-batch-results-table">
                      <thead>
                        <tr>
                          <th>Topic Name</th>
                          <th>Status</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchResult.results.map(r => (
                          <tr key={r.topicName}>
                            <td style={{ fontFamily: 'var(--bui-font-family-mono, monospace)', fontWeight: 600 }}>{r.topicName}</td>
                            <td>
                              <span className={`kafka-results-badge kafka-results-badge-${r.status === 'pending' ? 'pending' : r.status === 'created' ? 'created' : 'rejected'}`}>
                                {r.status === 'created' ? 'Created' : r.status === 'pending' ? 'Pending' : 'Failed'}
                              </span>
                            </td>
                            <td style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{r.error ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <Flex gap="2">
                    <Button variant="secondary" size="small" onPress={() => onBack()}>
                      Back to Requests
                    </Button>
                    <Button variant="primary" size="small" onPress={handleCreateAnother}>
                      Create Another
                    </Button>
                  </Flex>
                </>
              )}
            </Flex>
          )}

          {!(step === 3 && batchResult) && (
            <Flex gap="2">
              <Button
                variant="secondary"
                size="small"
                onPress={() => step === 0 ? onBack() : setStep(s => s - 1)}
              >
                Back
              </Button>
              {step < 3 && (
                <Button
                  variant="primary"
                  size="small"
                  isDisabled={!canProceed}
                  onPress={() => setStep(s => s + 1)}
                >
                  Next
                </Button>
              )}
            </Flex>
          )}
        </Flex>
  );
};
