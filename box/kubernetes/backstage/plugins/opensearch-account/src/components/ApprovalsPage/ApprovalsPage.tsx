import React, { useCallback, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsync, useAsyncRetry } from 'react-use';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PluginHeader,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiCheckboxCircleLine } from '@remixicon/react';
import { opensearchAccountPlugin } from '../../plugin';
import { opensearchAccountApiRef } from '../../api';
import { Loading, Modal, RoleChips, STATUS_LABEL } from '../common';
import { OpenSearchNav } from '../OpenSearchNav';

export const ApprovalsPage = () => {
  const api = useApi(opensearchAccountApiRef);

  const userRole = useAsync(() => api.getUserRole(), [api]);
  const isAdmin = userRole.value?.isAdmin ?? false;

  // Everyone can view requests; the backend returns only the caller's own
  // requests for non-admins, and all requests for admins.
  const requests = useAsyncRetry(() => api.listRequests(), [api]);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState<{ user: string; value: string } | null>(null);
  const [modal, setModal] = useState<{ mode: 'approve' | 'reject'; id: string } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const clearFeedback = () => {
    setError(null);
    setNotice(null);
  };

  const submitReason = useCallback(async () => {
    if (!modal) return;
    clearFeedback();
    setPassword(null);
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setBusy(true);
    try {
      if (modal.mode === 'approve') {
        const result = await api.approveRequest(modal.id, reason.trim());
        if (result.generatedPassword) {
          setPassword({ user: result.username, value: result.generatedPassword });
        }
        setNotice('Request approved and executed.');
      } else {
        await api.rejectRequest(modal.id, reason.trim());
        setNotice('Request rejected.');
      }
      requests.retry();
      setModal(null);
      setReason('');
    } catch (e: any) {
      setError(e?.message ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [api, modal, reason, requests]);

  const reqs = requests.value ?? [];

  return (
    <>
      <PluginHeader
        icon={<RiCheckboxCircleLine />}
        title="OpenSearch Account Requests"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {opensearchAccountPlugin.getId()}
            </Tag>
          </TagGroup>
        }
      />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <OpenSearchNav current="approvals" isAdmin={isAdmin} />

          <Text variant="body-small" color="secondary">
            View account creation, deletion, and modification requests and
            approvals.
          </Text>

          {!userRole.loading && !isAdmin && (
            <Text variant="body-small" color="secondary">
              Showing your own requests. Approvals are handled by admins.
            </Text>
          )}

          {userRole.loading ? (
            <Loading />
          ) : (
            <>
              {error && <Alert status="danger" title={error} />}
              {notice && <Alert status="success" title={notice} />}
              {password && (
                <Box className="osa-password">
                  <Text variant="body-medium" weight="bold">
                    Password for {password.user} (shown once, copy now)
                  </Text>
                  <code className="osa-password-value">{password.value}</code>
                </Box>
              )}

              {requests.loading ? (
                <Loading />
              ) : requests.error ? (
                <Alert status="danger" title={requests.error.message} />
              ) : reqs.length === 0 ? (
                <Text variant="body-medium" color="secondary">
                  No requests yet.
                </Text>
              ) : (
                <Box className="osa-section">
                  <div className="osa-table-wrap">
                    <table className="osa-table">
                      <thead>
                        <tr>
                          <th>Request ID</th>
                          <th>Action</th>
                          <th>Username</th>
                          <th>Roles</th>
                          <th>Status</th>
                          <th>Reason</th>
                          <th>Requester</th>
                          <th>Reviewer</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {reqs.map(r => (
                          <tr key={r.id}>
                            <td className="osa-mono osa-small osa-reqid" title={r.id}>
                              {r.id}
                            </td>
                            <td>
                              <span className={`osa-action osa-action-${r.action}`}>
                                {r.action}
                              </span>
                            </td>
                            <td className="osa-mono">{r.username}</td>
                            <td>
                              <RoleChips roles={[...r.securityRoles, ...r.backendRoles]} />
                            </td>
                            <td>
                              <span className={`osa-status osa-status-${r.status}`}>
                                {STATUS_LABEL[r.status]}
                              </span>
                              {r.status === 'failed' && r.errorMessage && (
                                <div className="osa-error-msg">{r.errorMessage}</div>
                              )}
                            </td>
                            <td className="osa-small">{r.reason ?? '-'}</td>
                            <td className="osa-mono osa-small">{r.requester}</td>
                            <td className="osa-mono osa-small">{r.reviewer ?? '-'}</td>
                            <td className="osa-actions">
                              {r.status === 'pending' && isAdmin && (
                                <Flex gap="1">
                                  <Button
                                    variant="primary"
                                    size="small"
                                    onClick={() => {
                                      clearFeedback();
                                      setReason('');
                                      setModal({ mode: 'approve', id: r.id });
                                    }}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="small"
                                    onClick={() => {
                                      clearFeedback();
                                      setReason('');
                                      setModal({ mode: 'reject', id: r.id });
                                    }}
                                  >
                                    Reject
                                  </Button>
                                </Flex>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Box>
              )}
            </>
          )}
        </Flex>
      </Container>

      {modal && (
        <Modal
          title={modal.mode === 'approve' ? 'Approve request' : 'Reject request'}
          confirmLabel={modal.mode === 'approve' ? 'Approve' : 'Reject'}
          danger={modal.mode === 'reject'}
          busy={busy}
          confirmDisabled={!reason.trim()}
          onCancel={() => setModal(null)}
          onConfirm={submitReason}
        >
          <label className="osa-label">Reason</label>
          <textarea
            className="osa-textarea"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why are you approving/rejecting this request?"
            rows={3}
          />
        </Modal>
      )}
    </>
  );
};
