import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsync, useAsyncRetry } from 'react-use';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PluginHeader,
  Skeleton,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiAddLine, RiArrowUpCircleLine } from '@remixicon/react';
import { opensearchScalingPlugin } from '../../plugin';
import { createReservationRouteRef } from '../../routes';
import { opensearchScalingApiRef } from '../../api';
import { ScalingRequest } from '../../api/types';
import {
  ChangeSummary,
  StatusBadge,
  displayUser,
  formatCountdown,
} from '../common';
import { formatInZone } from '../time';
import '../opensearch-scaling.css';

type SortDir = 'asc' | 'desc';

// Sortable columns and the comparable value each one sorts by.
const COLUMNS: Array<{
  key: string;
  label: string;
  get: (r: ScalingRequest) => string | number;
}> = [
  { key: 'domain', label: 'Domain', get: r => r.domain.toLowerCase() },
  { key: 'change', label: 'Change', get: r => r.instanceCount },
  { key: 'scheduledAt', label: 'Runs at', get: r => Date.parse(r.scheduledAt) },
  { key: 'timeLeft', label: 'Time left', get: r => Date.parse(r.scheduledAt) },
  {
    key: 'requester',
    label: 'Requested by',
    get: r => displayUser(r.requester).toLowerCase(),
  },
  { key: 'createdAt', label: 'Requested at', get: r => Date.parse(r.createdAt) },
  { key: 'status', label: 'Status', get: r => r.status },
];

export const ReservationsPage = () => {
  const api = useApi(opensearchScalingApiRef);
  const navigate = useNavigate();
  const createLink = useRouteRef(createReservationRouteRef);

  const requests = useAsyncRetry(() => api.listRequests(), [api]);
  const userRole = useAsync(() => api.getUserRole(), [api]);
  const isAdmin = userRole.value?.isAdmin ?? false;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Tick once a minute so the countdown column stays current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const cancel = useCallback(
    async (id: string) => {
      setError(null);
      setNotice(null);
      try {
        await api.cancelRequest(id);
        setNotice('Reservation cancelled.');
        requests.retry();
      } catch (e: any) {
        setError(e?.message ?? 'Failed to cancel reservation');
      }
    },
    [api, requests],
  );

  // Default to newest-requested first (matches the backend's default order).
  const [sortKey, setSortKey] = useState('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleSort = (key: string) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const reqs = requests.value ?? [];
  const sorted = useMemo(() => {
    const col = COLUMNS.find(c => c.key === sortKey);
    if (!col) return reqs;
    const arr = [...reqs].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    return sortDir === 'desc' ? arr.reverse() : arr;
  }, [reqs, sortKey, sortDir]);

  return (
    <>
      <PluginHeader
        icon={<RiArrowUpCircleLine />}
        title="OpenSearch Scaling"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {opensearchScalingPlugin.getId()}
            </Tag>
            <Tag id="model" size="small">
              scheduled
            </Tag>
          </TagGroup>
        }
      />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Text variant="body-small" color="secondary">
            Reserved scaling changes for Amazon OpenSearch Service domains. A
            change runs at its reserved time and is blocked if the domain
            already has a change or upgrade in progress.
          </Text>

          {error && <Alert status="danger" title={error} />}
          {notice && <Alert status="success" title={notice} />}

          <Box className="osc-section">
            <Flex direction="column" gap="2">
              <Flex justify="between" align="center">
                <Text variant="title-small">Capacity reservation</Text>
                {isAdmin && (
                  <Button
                    variant="secondary"
                    size="small"
                    iconStart={<RiAddLine />}
                    onClick={() => navigate(createLink())}
                  >
                    New reservation
                  </Button>
                )}
              </Flex>

              {requests.loading ? (
                <Skeleton style={{ height: 80 }} />
              ) : requests.error ? (
                <Alert status="danger" title={requests.error.message} />
              ) : reqs.length === 0 ? (
                <Text variant="body-small" color="secondary">
                  No reservations yet.
                  {isAdmin && ' Use “New reservation” to create one.'}
                </Text>
              ) : (
                <div className="osc-table-wrap">
                  <table className="osc-table">
                    <thead>
                      <tr>
                        {COLUMNS.map(col => (
                          <th
                            key={col.key}
                            className="osc-th-sort"
                            aria-sort={
                              sortKey === col.key
                                ? sortDir === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                            onClick={() => toggleSort(col.key)}
                          >
                            {col.label}
                            <span className="osc-sort-ind">
                              {sortKey === col.key
                                ? sortDir === 'asc'
                                  ? ' ▲'
                                  : ' ▼'
                                : ' ↕'}
                            </span>
                          </th>
                        ))}
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(req => (
                        <tr key={req.id}>
                          <td>
                            <span className="osc-mono osc-domain">
                              {req.domain}
                            </span>
                          </td>
                          <td>
                            <ChangeSummary req={req} />
                          </td>
                          <td>
                            <div>{formatInZone(req.scheduledAt, req.timezone)}</div>
                            <div className="osc-muted osc-small osc-mono">
                              {req.scheduledAt} UTC
                            </div>
                          </td>
                          <td className="osc-mono">
                            {req.status === 'scheduled'
                              ? formatCountdown(Date.parse(req.scheduledAt) - now)
                              : '-'}
                          </td>
                          <td>{displayUser(req.requester)}</td>
                          <td>{formatInZone(req.createdAt, req.timezone)}</td>
                          <td>
                            <StatusBadge status={req.status} />
                            {req.errorMessage && (
                              <div className="osc-warn osc-small osc-error-msg">
                                {req.errorMessage}
                              </div>
                            )}
                          </td>
                          <td className="osc-actions">
                            {isAdmin && req.status === 'scheduled' && (
                              <Button
                                variant="secondary"
                                size="small"
                                onClick={() => cancel(req.id)}
                              >
                                Cancel
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Flex>
          </Box>
        </Flex>
      </Container>
    </>
  );
};
