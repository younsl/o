import React, { useMemo, useState } from 'react';
import {
  Box,
  ButtonIcon,
  Card,
  CardBody,
  Flex,
  SearchField,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { RiErrorWarningLine } from '@remixicon/react';
import { KafkaTopic } from '../../api/types';
import './TopicTable.css';

interface TopicTableProps {
  topics: KafkaTopic[];
  loading: boolean;
}

function HighlightMatch({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="kafka-search-highlight">{text.slice(idx, idx + search.length)}</mark>
      {text.slice(idx + search.length)}
    </>
  );
}

function getWarnings(topic: KafkaTopic): string[] {
  const warnings: string[] = [];
  const rf = topic.replicationFactor;
  const isr = topic.minInsyncReplicas ? Number(topic.minInsyncReplicas) : null;

  if (rf === 1) {
    warnings.push('RF=1: no replication, single point of failure');
  }

  if (isr !== null) {
    if (isr >= rf) {
      warnings.push(`ISR(${isr}) >= RF(${rf}): writes will fail if any replica is unavailable`);
    } else if (rf >= 2 && isr < rf - 1) {
      warnings.push(`ISR(${isr}) < RF-1(${rf - 1}): weaker durability than recommended`);
    }
  }

  return warnings;
}

export const TopicTable = ({ topics, loading }: TopicTableProps) => {
  const [search, setSearch] = useState('');
  const [partitionFilter, setPartitionFilter] = useState('all');
  const [rfFilter, setRfFilter] = useState('all');
  const [warningFilter, setWarningFilter] = useState('all');

  const partitionOptions = useMemo(() => {
    const values = [...new Set(topics.map(t => t.partitions))].sort((a, b) => a - b);
    return [
      { label: 'All', value: 'all' },
      ...values.map(v => ({ label: String(v), value: String(v) })),
    ];
  }, [topics]);

  const rfOptions = useMemo(() => {
    const values = [...new Set(topics.map(t => t.replicationFactor))].sort((a, b) => a - b);
    return [
      { label: 'All', value: 'all' },
      ...values.map(v => ({ label: String(v), value: String(v) })),
    ];
  }, [topics]);

  const warningOptions = [
    { label: 'All', value: 'all' },
    { label: 'With warnings', value: 'warn' },
    { label: 'No warnings', value: 'ok' },
  ];

  const filtered = useMemo(() => {
    return topics.filter(t => {
      if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (partitionFilter !== 'all' && t.partitions !== Number(partitionFilter)) return false;
      if (rfFilter !== 'all' && t.replicationFactor !== Number(rfFilter)) return false;
      if (warningFilter === 'warn' && getWarnings(t).length === 0) return false;
      if (warningFilter === 'ok' && getWarnings(t).length > 0) return false;
      return true;
    });
  }, [topics, search, partitionFilter, rfFilter, warningFilter]);

  if (loading) {
    return (
      <Box mt="4">
        <Flex direction="column" gap="3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} style={{ height: 48, borderRadius: 8 }} />
          ))}
        </Flex>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="3">
      {/* Filters */}
      <Box p="3" className="kafka-filter-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <div className="kafka-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by name..."
            size="small"
            value={search}
            onChange={setSearch}
          />
          <Select
            label="Partitions"
            size="small"
            options={partitionOptions}
            selectedKey={partitionFilter}
            onSelectionChange={key => setPartitionFilter(key as string)}
          />
          <Select
            label="Replication Factor"
            size="small"
            options={rfOptions}
            selectedKey={rfFilter}
            onSelectionChange={key => setRfFilter(key as string)}
          />
          <Select
            label="Warnings"
            size="small"
            options={warningOptions}
            selectedKey={warningFilter}
            onSelectionChange={key => setWarningFilter(key as string)}
          />
        </div>
      </Box>

      {/* Topics */}
      <Flex justify="between" align="center">
        <Text variant="body-medium" weight="bold">
          Topics
        </Text>
        <Flex align="center" gap="2">
          <span className="kafka-count-badge">
            {filtered.length !== topics.length
              ? `${filtered.length} / ${topics.length}`
              : topics.length}
          </span>
          <Text variant="body-small" color="secondary">results</Text>
        </Flex>
      </Flex>

      {filtered.length === 0 ? (
        <Card>
          <CardBody>
            <Text variant="body-medium" color="secondary">
              {topics.length === 0
                ? 'No topics found in this cluster.'
                : 'No topics match the current filters.'}
            </Text>
          </CardBody>
        </Card>
      ) : (
        filtered.map(topic => {
          const warnings = getWarnings(topic);
          return (
            <Card key={topic.name}>
              <CardBody>
                <Flex justify="between" align="center">
                  <Flex gap="2" align="center">
                    {warnings.length > 0 && (
                      <TooltipTrigger delay={200}>
                        <ButtonIcon
                          size="small"
                          variant="tertiary"
                          icon={<RiErrorWarningLine size={16} color="#ff9800" />}
                          aria-label="Best practice warning"
                          className="kafka-warning-btn"
                        />
                        <Tooltip className="kafka-warning-tooltip">
                          {warnings.map(w => (
                            <div key={w}>{w}</div>
                          ))}
                        </Tooltip>
                      </TooltipTrigger>
                    )}
                    <Text variant="body-medium" weight="bold">
                      <HighlightMatch text={topic.name} search={search} />
                    </Text>
                  </Flex>
                  <TagGroup>
                    <Tag>Partitions: {topic.partitions}</Tag>
                    <Tag>RF: {topic.replicationFactor}</Tag>
                    {topic.minInsyncReplicas && (
                      <Tag>ISR: {topic.minInsyncReplicas}</Tag>
                    )}
                  </TagGroup>
                </Flex>
              </CardBody>
            </Card>
          );
        })
      )}
    </Flex>
  );
};
