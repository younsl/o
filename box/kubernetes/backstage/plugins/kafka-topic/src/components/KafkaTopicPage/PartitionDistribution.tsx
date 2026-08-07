import React, { useState, useEffect, useMemo } from 'react';
import {
  Card,
  CardBody,
  Flex,
  Grid,
  Text,
} from '@backstage/ui';
import './PartitionDistribution.css';

interface PartitionDistributionProps {
  numPartitions: number;
  replicationFactor: number;
  brokerCount: number;
}

interface BrokerAllocation {
  leaders: number[];
  followers: number[];
}

function simulateDistribution(
  numPartitions: number,
  replicationFactor: number,
  brokerCount: number,
): BrokerAllocation[] {
  const brokers: BrokerAllocation[] = Array.from({ length: brokerCount }, () => ({
    leaders: [],
    followers: [],
  }));

  const effectiveRF = Math.min(replicationFactor, brokerCount);

  for (let p = 0; p < numPartitions; p++) {
    const leaderIdx = p % brokerCount;
    brokers[leaderIdx].leaders.push(p);

    for (let r = 1; r < effectiveRF; r++) {
      const followerIdx = (leaderIdx + r) % brokerCount;
      brokers[followerIdx].followers.push(p);
    }
  }

  return brokers;
}

export const PartitionDistribution = ({
  numPartitions,
  replicationFactor,
  brokerCount,
}: PartitionDistributionProps) => {
  const [mode, setMode] = useState<'normal' | 'failure'>('normal');
  const [failedBrokers, setFailedBrokers] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFailedBrokers(new Set());
    setMode('normal');
  }, [numPartitions, replicationFactor, brokerCount]);

  const effectiveRF = brokerCount > 0 ? Math.min(replicationFactor, brokerCount) : 0;
  const distribution = useMemo(
    () => brokerCount > 0 && numPartitions > 0
      ? simulateDistribution(numPartitions, replicationFactor, brokerCount)
      : [],
    [numPartitions, replicationFactor, brokerCount],
  );
  const totalReplicas = numPartitions * effectiveRF;
  const tolerableBrokerFailures = effectiveRF - 1;
  const isSimulating = mode === 'failure';

  const toggleBroker = (idx: number) => {
    if (!isSimulating) return;
    setFailedBrokers(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleModeChange = (newMode: 'normal' | 'failure') => {
    setMode(newMode);
    if (newMode === 'normal') setFailedBrokers(new Set());
  };

  const { unavailable, degraded } = useMemo(() => {
    if (failedBrokers.size === 0 || distribution.length === 0) return { unavailable: [] as number[], degraded: [] as number[] };

    const unavail: number[] = [];
    const degrad: number[] = [];

    for (let p = 0; p < numPartitions; p++) {
      let aliveCount = 0;
      let totalCount = 0;
      for (let b = 0; b < brokerCount; b++) {
        if (distribution[b].leaders.includes(p) || distribution[b].followers.includes(p)) {
          totalCount++;
          if (!failedBrokers.has(b)) aliveCount++;
        }
      }
      if (aliveCount === 0) unavail.push(p);
      else if (aliveCount < totalCount) degrad.push(p);
    }

    return { unavailable: unavail, degraded: degrad };
  }, [distribution, failedBrokers, numPartitions, brokerCount]);

  if (brokerCount === 0 || numPartitions === 0) return null;

  return (
    <Card>
      <CardBody>
        <Flex direction="column" gap="3">
          <Flex direction="column" gap="1">
            <Text variant="body-small" weight="bold">Partition Distribution</Text>
            <Text variant="body-x-small" color="secondary">
              {numPartitions} partitions × RF {replicationFactor} = {totalReplicas} replicas across {brokerCount} brokers
            </Text>
          </Flex>

          <Flex align="center" gap="0">
            <button
              type="button"
              className={`kafka-dist-toggle kafka-dist-toggle-left ${mode === 'normal' ? 'kafka-dist-toggle-active' : ''}`}
              onClick={() => handleModeChange('normal')}
            >
              Normal
            </button>
            <button
              type="button"
              className={`kafka-dist-toggle kafka-dist-toggle-right ${mode === 'failure' ? 'kafka-dist-toggle-active' : ''}`}
              onClick={() => handleModeChange('failure')}
            >
              Failure Simulation
            </button>
          </Flex>

          {isSimulating && (
            <Text variant="body-x-small" color="secondary">
              Click a broker to toggle its failure state.
            </Text>
          )}

          <Grid.Root
            columns={{ initial: '1', sm: '2', md: '3' }}
            gap="3"
          >
            {distribution.map((broker, idx) => {
              const isFailed = failedBrokers.has(idx);
              const total = broker.leaders.length + broker.followers.length;

              const partitions = [
                ...broker.leaders.map(p => ({ id: p, role: 'L' as const })),
                ...broker.followers.map(p => ({ id: p, role: 'F' as const })),
              ].sort((a, b) => a.id - b.id);

              return (
                <Grid.Item key={idx}>
                  <div
                    className={`kafka-dist-broker ${isFailed ? 'kafka-dist-broker-failed' : ''} ${isSimulating ? 'kafka-dist-broker-clickable' : ''}`}
                    role={isSimulating ? 'button' : undefined}
                    tabIndex={isSimulating ? 0 : undefined}
                    onClick={() => toggleBroker(idx)}
                    onKeyDown={e => { if (isSimulating && (e.key === 'Enter' || e.key === ' ')) toggleBroker(idx); }}
                  >
                    <Flex justify="between" align="center">
                      <Flex align="center" gap="2">
                        <span className={`kafka-dist-status-dot ${isFailed ? 'kafka-dist-status-critical' : 'kafka-dist-status-ok'}`} />
                        <Text variant="body-x-small" weight="bold">Broker {idx + 1}</Text>
                        {isFailed && (
                          <span className="kafka-dist-offline-badge">OFFLINE</span>
                        )}
                      </Flex>
                      <Text variant="body-x-small" color="secondary">{total} replicas</Text>
                    </Flex>
                    <div className="kafka-dist-partitions">
                      {partitions.map(p => (
                        <span
                          key={`${p.id}-${p.role}`}
                          className={`kafka-dist-box ${p.role === 'L' ? 'kafka-dist-box-leader' : 'kafka-dist-box-follower'} ${isFailed ? 'kafka-dist-box-dead' : ''}`}
                        >
                          P{p.id} <span className="kafka-dist-role">{p.role}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </Grid.Item>
              );
            })}
          </Grid.Root>

          {isSimulating && failedBrokers.size > 0 ? (
            <div className="kafka-dist-result">
              <Flex direction="column" gap="1">
                {unavailable.length === 0 ? (
                  <Flex align="center" gap="2">
                    <span className="kafka-dist-status-dot kafka-dist-status-ok" />
                    <Text variant="body-x-small">
                      All {numPartitions} partitions available — {failedBrokers.size} broker(s) offline
                    </Text>
                  </Flex>
                ) : (
                  <Flex align="center" gap="2">
                    <span className="kafka-dist-status-dot kafka-dist-status-critical" />
                    <Text variant="body-x-small">
                      {unavailable.length}/{numPartitions} partitions unavailable: {unavailable.map(p => `P${p}`).join(', ')}
                    </Text>
                  </Flex>
                )}
                {degraded.length > 0 && (
                  <Flex align="center" gap="2">
                    <span className="kafka-dist-status-dot kafka-dist-status-warning" />
                    <Text variant="body-x-small" color="secondary">
                      {degraded.length} partition(s) running on reduced replicas
                    </Text>
                  </Flex>
                )}
              </Flex>
            </div>
          ) : (
            <Text variant="body-x-small" color="secondary">
              {isSimulating
                ? 'Select brokers to simulate failure.'
                : tolerableBrokerFailures > 0
                  ? `Tolerates ${tolerableBrokerFailures} broker failure(s) without data loss`
                  : 'RF=1: no fault tolerance — data loss if any broker fails'}
            </Text>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
};
