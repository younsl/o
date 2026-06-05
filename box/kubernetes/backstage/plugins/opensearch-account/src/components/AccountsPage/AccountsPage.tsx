import React, { useCallback, useEffect, useState } from 'react';
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
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiShieldUserLine } from '@remixicon/react';
import { opensearchAccountPlugin } from '../../plugin';
import { createAccountRouteRef } from '../../routes';
import { opensearchAccountApiRef } from '../../api';
import { InternalUser } from '../../api/types';
import {
  Loading,
  Modal,
  RoleCheckboxGrid,
  RoleChips,
} from '../common';
import { OpenSearchNav } from '../OpenSearchNav';

export const AccountsPage = () => {
  const api = useApi(opensearchAccountApiRef);
  const navigate = useNavigate();
  const createLink = useRouteRef(createAccountRouteRef);

  const config = useAsync(() => api.getConfig(), [api]);
  const userRole = useAsync(() => api.getUserRole(), [api]);
  const isAdmin = userRole.value?.isAdmin ?? false;

  // Admin-only data; gated so non-admins never hit the endpoints.
  const accounts = useAsyncRetry(
    async () => (isAdmin ? api.listAccounts() : []),
    [api, isAdmin],
  );
  const roles = useAsync(async () => (isAdmin ? api.listRoles() : []), [api, isAdmin]);
  const backendRoleOptions = useAsync(
    async () => (isAdmin ? api.listBackendRoles() : []),
    [api, isAdmin],
  );

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState<{ user: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const [modifyTarget, setModifyTarget] = useState<InternalUser | null>(null);
  const [modBackend, setModBackend] = useState<Set<string>>(new Set());
  const [modSecurity, setModSecurity] = useState<Set<string>>(new Set());
  const [modReset, setModReset] = useState(false);

  const clearFeedback = () => {
    setError(null);
    setNotice(null);
  };

  const toggleIn =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (role: string) =>
      setter(prev => {
        const next = new Set(prev);
        if (next.has(role)) next.delete(role);
        else next.add(role);
        return next;
      });
  const toggleModBackend = toggleIn(setModBackend);
  const toggleModSecurity = toggleIn(setModSecurity);

  // Regular users may only create; redirect them to the Create page.
  useEffect(() => {
    if (!userRole.loading && !isAdmin) {
      navigate(createLink(), { replace: true });
    }
  }, [userRole.loading, isAdmin, navigate, createLink]);

  const submitDelete = useCallback(
    async (name: string) => {
      clearFeedback();
      setConfirmDelete(null);
      setDeleteConfirmText('');
      setBusy(true);
      try {
        const result = await api.createRequest({ action: 'delete', username: name });
        setNotice(
          result.status === 'executed'
            ? `Account '${name}' deleted.`
            : `Delete request for '${name}' recorded.`,
        );
        accounts.retry();
      } catch (e: any) {
        setError(e?.message ?? 'Failed to submit delete request');
      } finally {
        setBusy(false);
      }
    },
    [api, accounts],
  );

  const openModify = useCallback((u: InternalUser) => {
    clearFeedback();
    setModifyTarget(u);
    setModBackend(new Set(u.backendRoles));
    setModSecurity(new Set(u.securityRoles));
    setModReset(false);
  }, []);

  const submitModify = useCallback(async () => {
    if (!modifyTarget) return;
    clearFeedback();
    setPassword(null);
    setBusy(true);
    try {
      const result = await api.createRequest({
        action: 'modify',
        username: modifyTarget.username,
        backendRoles: Array.from(modBackend),
        securityRoles: Array.from(modSecurity),
        resetPassword: modReset,
      });
      if (result.generatedPassword) {
        setPassword({ user: modifyTarget.username, value: result.generatedPassword });
      }
      setNotice(`Account '${modifyTarget.username}' updated.`);
      setModifyTarget(null);
      accounts.retry();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to modify account');
    } finally {
      setBusy(false);
    }
  }, [api, modifyTarget, modBackend, modSecurity, modReset, accounts]);

  const masterUsername = config.value?.masterUsername ?? '';
  const users = accounts.value ?? [];

  return (
    <>
      <PluginHeader
        icon={<RiShieldUserLine />}
        title="OpenSearch Accounts"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {opensearchAccountPlugin.getId()}
            </Tag>
            {config.value?.requiresApproval && (
              <Tag id="approval" size="small">
                approval required
              </Tag>
            )}
          </TagGroup>
        }
      />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <OpenSearchNav current="accounts" isAdmin={isAdmin} />

          <Text variant="body-small" color="secondary">
            View and manage OpenSearch internal user accounts and their roles.
          </Text>

          {userRole.loading || !isAdmin ? (
            <Loading />
          ) : (
            <>
              {config.value && !config.value.configured && (
                <Alert
                  status="warning"
                  title="OpenSearch is not configured"
                  description="Set opensearchAccount.endpoint/username/password in app-config."
                />
              )}
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

              {accounts.loading ? (
                <Loading />
              ) : accounts.error ? (
                <Alert status="danger" title={accounts.error.message} />
              ) : users.length === 0 ? (
                <Text variant="body-medium" color="secondary">
                  No internal users found.
                </Text>
              ) : (
                <Box className="osa-section">
                  <div className="osa-table-wrap">
                    <table className="osa-table">
                      <thead>
                        <tr>
                          <th>Username</th>
                          <th>Type</th>
                          <th>Backend roles</th>
                          <th>Security roles</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {users.map(u => {
                          const isMaster =
                            masterUsername !== '' && u.username === masterUsername;
                          // Reflect the OpenSearch API flags as-is.
                          const isSystem = u.reserved || u.hidden || u.static;
                          return (
                            <tr key={u.username}>
                              <td className="osa-mono">
                                {u.username}
                                {isMaster && <span className="osa-reserved">master</span>}
                              </td>
                              <td>
                                <span
                                  className={`osa-type osa-type-${isSystem ? 'system' : 'user'}`}
                                >
                                  {isSystem ? 'System' : 'User'}
                                </span>
                              </td>
                              <td>
                                <RoleChips roles={u.backendRoles} />
                              </td>
                              <td>
                                <RoleChips roles={u.securityRoles} />
                              </td>
                              <td className="osa-actions">
                                <Flex gap="1" justify="end">
                                  {!u.reserved && (
                                    <Button
                                      variant="secondary"
                                      size="small"
                                      onClick={() => openModify(u)}
                                    >
                                      Modify
                                    </Button>
                                  )}
                                  {!u.reserved && (
                                    <Button
                                      variant="secondary"
                                      size="small"
                                      isDisabled={isMaster}
                                      onClick={() => {
                                        clearFeedback();
                                        setDeleteConfirmText('');
                                        setConfirmDelete(u.username);
                                      }}
                                    >
                                      Delete
                                    </Button>
                                  )}
                                </Flex>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Box>
              )}
            </>
          )}
        </Flex>
      </Container>

      {confirmDelete && (
        <Modal
          title={`Delete '${confirmDelete}'?`}
          confirmLabel="Delete"
          danger
          busy={busy}
          confirmDisabled={deleteConfirmText.trim() !== confirmDelete}
          onCancel={() => {
            setConfirmDelete(null);
            setDeleteConfirmText('');
          }}
          onConfirm={() => submitDelete(confirmDelete)}
        >
          <Text variant="body-medium" color="secondary">
            This permanently deletes the OpenSearch account and is recorded in
            the request log. To confirm, type the username{' '}
            <span className="osa-mono">{confirmDelete}</span> below.
          </Text>
          <input
            className="osa-input osa-mt"
            value={deleteConfirmText}
            onChange={e => setDeleteConfirmText(e.target.value)}
            placeholder={confirmDelete}
            aria-label="Type the username to confirm deletion"
          />
        </Modal>
      )}

      {modifyTarget && (
        <Modal
          title={`Modify '${modifyTarget.username}'`}
          confirmLabel="Save changes"
          busy={busy}
          onCancel={() => setModifyTarget(null)}
          onConfirm={submitModify}
        >
          <label className="osa-label">Backend roles</label>
          <RoleCheckboxGrid
            options={Array.from(
              new Set([...(backendRoleOptions.value ?? []), ...modifyTarget.backendRoles]),
            )}
            loading={false}
            selected={modBackend}
            toggle={toggleModBackend}
            emptyText="No backend roles."
          />
          <label className="osa-label osa-mt">Security roles</label>
          <RoleCheckboxGrid
            options={Array.from(
              new Set([...(roles.value ?? []), ...modifyTarget.securityRoles]),
            )}
            loading={false}
            selected={modSecurity}
            toggle={toggleModSecurity}
            emptyText="No roles available."
          />
          <label className="osa-role-option osa-mt">
            <input
              type="checkbox"
              checked={modReset}
              onChange={() => setModReset(v => !v)}
            />
            <span>Reset password (generate a new one, shown once)</span>
          </label>
        </Modal>
      )}
    </>
  );
};
