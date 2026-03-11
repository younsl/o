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
import { useAsyncRetry } from 'react-use';
import { kafkaTopicApiRef } from '../../api/KafkaTopicApi';
import { CreateTopicResponse } from '../../api/types';
import { ClusterInfo } from './ClusterInfo';
import { TopicTable } from './TopicTable';
import { PartitionDistribution } from './PartitionDistribution';
import './CreateTopicPage.css';

const TOPIC_NAME_PATTERN = /^[a-zA-Z0-9._-]*$/;
const hasInvalidChars = (value: string) => value !== '' && !TOPIC_NAME_PATTERN.test(value);

const STEPS = [
  { key: 'cluster', label: 'Cluster Info', title: 'Select Cluster', description: 'Choose a Kafka cluster and review its broker architecture.' },
  { key: 'topics', label: 'Topics', title: 'Review Existing Topics', description: 'Check the current topics in this cluster to avoid duplicates.' },
  { key: 'config', label: 'Config', title: 'Configure Topic', description: 'Set the topic name, config preset, and cleanup policy.' },
  { key: 'create', label: 'Simulate & Create', title: 'Simulate & Create', description: 'Review partition distribution, simulate broker failures, and create the topic.' },
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

  // Data: clusters
  const {
    value: clusters,
    loading,
    error: clustersError,
  } = useAsyncRetry(async () => api.getClusters(), [api]);

  // Step 1: cluster selection
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const currentClusterName = selectedCluster ?? clusters?.[0]?.name;
  const currentCluster = clusters?.find(c => c.name === currentClusterName);

  // Data: topics for selected cluster
  const {
    value: topics,
    loading: topicsLoading,
  } = useAsyncRetry(async () => {
    if (!currentClusterName) return [];
    return api.listTopics(currentClusterName);
  }, [api, currentClusterName]);

  // Step 3: config
  const [appName, setAppName] = useState('');
  const [eventName, setEventName] = useState('');
  const [action, setAction] = useState('');
  const configKeys = useMemo(
    () => Object.keys(currentCluster?.topicConfig ?? {}),
    [currentCluster],
  );
  const [trafficLevel, setTrafficLevel] = useState('');
  const [cleanupPolicy, setCleanupPolicy] = useState('delete');

  // Step 5: create
  const [isCreating, setIsCreating] = useState(false);
  const [result, setResult] = useState<CreateTopicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Validation
  const hasInvalidInput = hasInvalidChars(appName) || hasInvalidChars(eventName) || hasInvalidChars(action);

  // Derived
  const selectedConfig = currentCluster?.topicConfig?.[trafficLevel];
  const topicPreview = useMemo(() => {
    const parts = [appName.trim(), eventName.trim()].filter(Boolean);
    if (action.trim()) parts.push(action.trim());
    return parts.length >= 2 ? parts.join('-') : '';
  }, [appName, eventName, action]);
  const isDuplicate = topicPreview !== '' && (topics?.some(t => t.name === topicPreview) ?? false);
  const isCompleted = result !== null;

  // Reset form when cluster changes
  useEffect(() => {
    const keys = Object.keys(
      clusters?.find(c => c.name === currentClusterName)?.topicConfig ?? {},
    );
    setTrafficLevel(keys[0] ?? 'default');
    setAppName('');
    setEventName('');
    setAction('');
    setCleanupPolicy('delete');
    setResult(null);
    setError(null);
  }, [currentClusterName, clusters]);

  // Step validation
  const canProceed = useMemo(() => {
    switch (step) {
      case 0: return !!currentClusterName;
      case 1: return true;
      case 2: return appName.trim() !== '' && eventName.trim() !== '' && !isDuplicate && !hasInvalidInput;
      default: return false;
    }
  }, [step, currentClusterName, appName, eventName, isDuplicate, hasInvalidInput]);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.createTopic(currentClusterName!, {
        appName: appName.trim(),
        eventName: eventName.trim(),
        action: action.trim() || undefined,
        trafficLevel: configKeys.length > 0 ? trafficLevel : undefined,
        cleanupPolicy,
      });
      setResult(response);
    } catch (e: any) {
      const msg = e.body?.error ?? e.message ?? 'Failed to create topic';
      setError(typeof msg === 'string' ? msg : String(msg.message ?? msg));
    } finally {
      setIsCreating(false);
    }
  }, [api, currentClusterName, appName, eventName, action, trafficLevel, configKeys, cleanupPolicy]);

  const handleCreateAnother = useCallback(() => {
    setStep(0);
    setAppName('');
    setEventName('');
    setAction('');
    setCleanupPolicy('delete');
    setResult(null);
    setError(null);
  }, []);

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
          {/* Stepper */}
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

          {/* Step header */}
          {!isCompleted && (
            <Flex direction="column" gap="1">
              <Text variant="body-medium" weight="bold">{STEPS[step].title}</Text>
              <Text variant="body-small" color="secondary">{STEPS[step].description}</Text>
            </Flex>
          )}

          {/* Step 1: Cluster */}
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

          {/* Step 2: Topics */}
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

          {/* Step 3: Config */}
          {step === 2 && (
            <Flex direction="column" gap="3">
              <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
                <Box style={{ flex: 1 }}>
                  <TextField
                    label="App Name"
                    placeholder="e.g. money"
                    value={appName}
                    onChange={setAppName}
                    isRequired
                    isInvalid={hasInvalidChars(appName)}
                  />
                </Box>
                <Box style={{ flex: 1 }}>
                  <TextField
                    label="Event Name"
                    placeholder="e.g. charge"
                    value={eventName}
                    onChange={setEventName}
                    isRequired
                    isInvalid={hasInvalidChars(eventName)}
                  />
                </Box>
                <Box style={{ flex: 1 }}>
                  <TextField
                    label="Action (optional)"
                    placeholder="e.g. approval"
                    value={action}
                    onChange={setAction}
                    isInvalid={hasInvalidChars(action)}
                  />
                </Box>
              </Flex>

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

              {topicPreview && (
                <Flex direction="column" gap="1">
                  <Text variant="body-small" color="secondary">Topic name preview</Text>
                  <Flex gap="2" align="center">
                    <Text variant="body-medium" weight="bold" color={isDuplicate || hasInvalidInput ? 'danger' : undefined}>
                      {topicPreview}
                    </Text>
                    {hasInvalidInput && (
                      <Text variant="body-small" color="danger">
                        — Topic name only allows letters, digits, periods, hyphens, and underscores
                      </Text>
                    )}
                  </Flex>
                  {isDuplicate && (
                    <Text variant="body-small" color="danger">
                      This topic already exists in {currentClusterName}.
                    </Text>
                  )}
                </Flex>
              )}
            </Flex>
          )}

          {/* Step 4: Simulate & Create */}
          {step === 3 && (
            <Flex direction="column" gap="3">
              {!result ? (
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
                          <Flex direction="column" gap="1">
                            <Text variant="body-x-small" color="secondary">Topic Name</Text>
                            <Text variant="body-small" weight="bold">{topicPreview}</Text>
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
                  {selectedConfig && (
                    <PartitionDistribution
                      numPartitions={selectedConfig.numPartitions}
                      replicationFactor={selectedConfig.replicationFactor}
                      brokerCount={currentCluster?.brokers.length ?? 0}
                    />
                  )}
                  <Button variant="primary" size="small" loading={isCreating} onPress={handleCreate}>
                    {currentCluster?.requiresApproval ? 'Submit for Approval' : 'Create Topic'}
                  </Button>
                  {error && <Alert status="danger" title={error} />}
                </>
              ) : (
                <>
                  <Alert
                    status={result.status === 'pending' ? 'info' : 'success'}
                    title={
                      result.status === 'pending'
                        ? `Topic "${result.topicName}" submitted for approval (Partitions: ${result.partitions}, RF: ${result.replicationFactor})`
                        : `Topic "${result.topicName}" created (Partitions: ${result.partitions}, RF: ${result.replicationFactor})`
                    }
                  />
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

          {/* Navigation */}
          {!(step === 3 && result) && (
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
