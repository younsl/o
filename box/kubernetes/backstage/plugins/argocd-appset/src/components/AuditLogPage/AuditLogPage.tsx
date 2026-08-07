import React, { useMemo } from 'react';
import {
  Alert,
  Box,
  Container,
  Flex,
  Link,
  HeaderPage,
  Skeleton,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiArrowLeftLine } from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useParams } from 'react-router-dom';
import { useAsyncRetry } from 'react-use';
import { argocdAppsetApiRef } from '../../api';
import './AuditLogPage.css';

export const AuditLogPage = () => {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  const api = useApi(argocdAppsetApiRef);

  const { value: appSets } = useAsyncRetry(async () => {
    return api.listApplicationSets();
  }, []);

  const appSet = useMemo(() => {
    if (!appSets || !namespace || !name) return undefined;
    return appSets.find(a => a.namespace === namespace && a.name === name);
  }, [appSets, namespace, name]);

  const {
    value: auditLogs,
    loading,
    error,
  } = useAsyncRetry(async () => {
    if (!namespace || !name) return [];
    return api.listAuditLogs(namespace, name);
  }, [namespace, name]);

  return (
    <>
      <HeaderPage
        title="Change History"
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'ArgoCD', href: '/argocd-appset' },
        ]}
      />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Track who changed what and when for this ApplicationSet
        </Text>
        <Flex align="center" gap="2" mb="4" mt="3">
          <Link href="/argocd-appset">
            <Flex align="center" gap="1">
              <RiArrowLeftLine size={16} />
              <Text variant="body-small">Back to ApplicationSets</Text>
            </Flex>
          </Link>
        </Flex>

        {/* ApplicationSet Info */}
        <Box p="3" mb="3" className="audit-page-section-box">
          <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
            ApplicationSet Info
          </Text>
          {!appSet ? (
            <Flex direction="column" gap="2">
              <Skeleton width="60%" height={20} />
              <Skeleton width="40%" height={20} />
            </Flex>
          ) : (
            <div className="audit-page-info-grid">
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Namespace</Text>
                <Text variant="body-small">{appSet.namespace}</Text>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Name</Text>
                <Text variant="body-small">{appSet.name}</Text>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Repository</Text>
                {appSet.repoUrl ? (
                  <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                    <Text variant="body-small">{appSet.repoName}</Text>
                  </Link>
                ) : (
                  <Text variant="body-small">{appSet.repoName || '-'}</Text>
                )}
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Target Revision</Text>
                <TagGroup>
                  {appSet.targetRevisions.map((rev, i) => (
                    <Tag key={i} id={`rev-${i}`} size="small">{rev}</Tag>
                  ))}
                </TagGroup>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Generators</Text>
                <TagGroup>
                  {appSet.generators.map((gen, i) => (
                    <Tag key={i} id={`gen-${i}`} size="small">{gen}</Tag>
                  ))}
                </TagGroup>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Applications</Text>
                <Text variant="body-small">{appSet.syncedCount} / {appSet.applicationCount} Synced</Text>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Muted</Text>
                <Text variant="body-small">{appSet.muted ? 'Yes' : 'No'}</Text>
              </div>
              <div className="audit-page-info-item">
                <Text variant="body-x-small" color="secondary" className="audit-page-info-label">Created</Text>
                <Text variant="body-small">{new Date(appSet.createdAt).toLocaleString()}</Text>
              </div>
            </div>
          )}
        </Box>

        {/* Change History */}
        <Box p="3" className="audit-page-section-box">
          <Flex justify="between" align="center" mb="3">
            <Text variant="body-medium" weight="bold">
              Change History
            </Text>
            {!loading && auditLogs && (
              <Flex align="center" gap="2">
                <span className="audit-page-count-badge">{auditLogs.length}</span>
                <Text variant="body-small" color="secondary">events</Text>
              </Flex>
            )}
          </Flex>

          {loading && (
            <Flex direction="column" gap="2">
              {[1, 2, 3, 4, 5].map(i => (
                <Skeleton key={i} width="100%" height={40} />
              ))}
            </Flex>
          )}

          {error && (
            <Alert status="danger" title="Failed to load audit logs" />
          )}

          {!loading && !error && auditLogs && auditLogs.length === 0 && (
            <div className="audit-page-empty">
              <Text variant="body-medium" color="secondary">No change history</Text>
            </div>
          )}

          {!loading && auditLogs && auditLogs.length > 0 && (
            <table className="audit-page-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map(log => (
                  <tr key={log.id}>
                    <td>{log.seq}</td>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>{log.userRef.replace(/^user:default\//, '')}</td>
                    <td>
                      <span className={`audit-page-action audit-page-action-${log.action}`}>
                        {log.action === 'set_target_revision' ? 'set target revision' : log.action}
                      </span>
                    </td>
                    <td>
                      {log.oldValue !== null || log.newValue !== null ? (
                        <span>
                          {log.oldValue && <span className="audit-page-old">{log.oldValue}</span>}
                          {log.oldValue && log.newValue && ' → '}
                          {log.newValue && <span className="audit-page-new">{log.newValue}</span>}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Box>
      </Container>
    </>
  );
};
