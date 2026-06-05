import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsync } from 'react-use';
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
import {
  RiUserAddLine,
  RiErrorWarningLine,
  RiEyeLine,
  RiEyeOffLine,
} from '@remixicon/react';
import { opensearchAccountPlugin } from '../../plugin';
import { approvalsRouteRef } from '../../routes';
import { opensearchAccountApiRef } from '../../api';
import { OpenSearchNav } from '../OpenSearchNav';
import '../opensearch-account.css';

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{2,64}$/;

type AttrRow = { key: string; value: string };

/** Dropdown checkbox list for multi-selecting roles. */
const RoleDropdown = ({
  placeholder,
  loading,
  options,
  selected,
  onToggle,
  emptyText,
}: {
  placeholder: string;
  loading: boolean;
  options: string[];
  selected: Set<string>;
  onToggle: (r: string) => void;
  emptyText: string;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const count = selected.size;
  return (
    <div className="osa-dropdown" ref={ref}>
      <button
        type="button"
        className="osa-dropdown-toggle"
        onClick={() => setOpen(o => !o)}
      >
        <span>{count > 0 ? `${count} selected` : placeholder}</span>
        <span className="osa-dropdown-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="osa-dropdown-panel">
          {loading ? (
            <Skeleton style={{ height: 60 }} />
          ) : options.length === 0 ? (
            <span className="osa-muted">{emptyText}</span>
          ) : (
            options.map(r => (
              <label key={r} className="osa-role-option">
                <input
                  type="checkbox"
                  checked={selected.has(r)}
                  onChange={() => onToggle(r)}
                />
                <span className="osa-mono">{r}</span>
              </label>
            ))
          )}
        </div>
      )}
      {count > 0 && (
        <div className="osa-chips osa-dropdown-chips">
          {Array.from(selected).map(r => (
            <span key={r} className="osa-chip">
              {r}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export const CreateAccountPage = () => {
  const api = useApi(opensearchAccountApiRef);
  const navigate = useNavigate();
  const requestsLink = useRouteRef(approvalsRouteRef);

  const config = useAsync(() => api.getConfig(), [api]);
  const userRole = useAsync(() => api.getUserRole(), [api]);
  const isAdmin = userRole.value?.isAdmin ?? false;
  const backendRoleOptions = useAsync(() => api.listBackendRoles(), [api]);
  const securityRoleOptions = useAsync(() => api.listRoles(), [api]);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [selectedBackend, setSelectedBackend] = useState<Set<string>>(new Set());
  const [backendExtra, setBackendExtra] = useState('');
  const [selectedSecurity, setSelectedSecurity] = useState<Set<string>>(new Set());
  const [attrs, setAttrs] = useState<AttrRow[]>([]);
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const passwordMismatch =
    passwordConfirm.length > 0 && password !== passwordConfirm;

  // All required fields valid: username, password (>=8 & matching), reason.
  const canSubmit =
    USERNAME_PATTERN.test(username.trim()) &&
    password.length >= 8 &&
    password === passwordConfirm &&
    reason.trim().length > 0;

  const toggleIn =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (role: string) =>
      setter(prev => {
        const next = new Set(prev);
        if (next.has(role)) next.delete(role);
        else next.add(role);
        return next;
      });
  const toggleBackend = toggleIn(setSelectedBackend);
  const toggleSecurity = toggleIn(setSelectedSecurity);

  const submit = useCallback(async () => {
    setError(null);
    if (!USERNAME_PATTERN.test(username.trim())) {
      setError('Username must be 2-64 chars (letters, digits, . _ @ -).');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!reason.trim()) {
      setError('Reason is required.');
      return;
    }
    setBusy(true);
    try {
      const backendRoles = Array.from(
        new Set([
          ...selectedBackend,
          ...backendExtra.split(',').map(s => s.trim()).filter(Boolean),
        ]),
      );
      const attributes: Record<string, string> = {};
      for (const { key, value } of attrs) {
        if (key.trim()) attributes[key.trim()] = value;
      }
      await api.createRequest({
        action: 'create',
        username: username.trim(),
        password,
        backendRoles,
        securityRoles: Array.from(selectedSecurity),
        attributes,
        reason: reason.trim(),
      });
      navigate(requestsLink());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to submit create request');
    } finally {
      setBusy(false);
    }
  }, [
    api,
    username,
    password,
    passwordConfirm,
    selectedBackend,
    backendExtra,
    selectedSecurity,
    attrs,
    reason,
    navigate,
    requestsLink,
  ]);

  return (
    <>
      <PluginHeader
        icon={<RiUserAddLine />}
        title="Create OpenSearch account"
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
          <OpenSearchNav current="create" isAdmin={isAdmin} />

          <Text variant="body-small" color="secondary">
            Request a new OpenSearch internal user account.
          </Text>

          {error && <Alert status="danger" title={error} />}

          <Box className="osa-section">
            <Flex direction="column" gap="3">
              <div>
                <label className="osa-label">
                  Username <span className="osa-required">*</span>
                </label>
                <input
                  className="osa-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="e.g. svc-reporting"
                />
              </div>
              <div>
                <label className="osa-label">
                  Password <span className="osa-required">*</span>
                </label>
                <div className="osa-input-wrap">
                  <input
                    className="osa-input osa-input-pw"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                  />
                  <button
                    type="button"
                    className="osa-pw-toggle"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <RiEyeOffLine size={16} aria-hidden />
                    ) : (
                      <RiEyeLine size={16} aria-hidden />
                    )}
                  </button>
                </div>
              </div>
              <div>
                <label className="osa-label">
                  Re-enter Password <span className="osa-required">*</span>
                </label>
                <div className="osa-input-wrap">
                  <input
                    className={`osa-input osa-input-pw ${passwordMismatch ? 'osa-input-invalid' : ''}`}
                    type={showPassword ? 'text' : 'password'}
                    value={passwordConfirm}
                    onChange={e => setPasswordConfirm(e.target.value)}
                    aria-invalid={passwordMismatch}
                  />
                  <button
                    type="button"
                    className="osa-pw-toggle"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
                      <RiEyeOffLine size={16} aria-hidden />
                    ) : (
                      <RiEyeLine size={16} aria-hidden />
                    )}
                  </button>
                </div>
                {passwordMismatch && (
                  <div className="osa-field-error">
                    <RiErrorWarningLine size={14} aria-hidden />
                    <span>Passwords do not match.</span>
                  </div>
                )}
              </div>

              <div>
                <label className="osa-label">
                  Backend roles{' '}
                  <span className="osa-count">{backendRoleOptions.value?.length ?? 0}</span>{' '}
                  <span className="osa-optional">(optional)</span>
                </label>
                <p className="osa-help">
                  External roles from your identity provider (SAML/JWT). They are
                  linked to permissions through OpenSearch role mappings.
                </p>
                <RoleDropdown
                  placeholder="Select backend roles"
                  loading={backendRoleOptions.loading}
                  options={backendRoleOptions.value ?? []}
                  selected={selectedBackend}
                  onToggle={toggleBackend}
                  emptyText="No existing backend roles; use the field below."
                />
                <input
                  className="osa-input osa-input-extra"
                  value={backendExtra}
                  onChange={e => setBackendExtra(e.target.value)}
                  placeholder="Additional backend roles (comma-separated)"
                />
              </div>

              <div>
                <label className="osa-label">
                  Security roles{' '}
                  <span className="osa-count">{securityRoleOptions.value?.length ?? 0}</span>{' '}
                  <span className="osa-optional">(optional)</span>
                </label>
                <p className="osa-help">
                  Roles defined in OpenSearch that grant index, cluster, and
                  tenant permissions directly to the account.
                </p>
                <RoleDropdown
                  placeholder="Select security roles"
                  loading={securityRoleOptions.loading}
                  options={securityRoleOptions.value ?? []}
                  selected={selectedSecurity}
                  onToggle={toggleSecurity}
                  emptyText="No roles available."
                />
              </div>

              <div>
                <label className="osa-label">
                  Attributes <span className="osa-optional">(optional)</span>
                </label>
                <Flex direction="column" gap="1">
                  {attrs.map((row, i) => (
                    <Flex key={i} gap="1" align="center">
                      <input
                        className="osa-input osa-attr-key"
                        value={row.key}
                        onChange={e =>
                          setAttrs(a =>
                            a.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)),
                          )
                        }
                        placeholder="key"
                      />
                      <input
                        className="osa-input osa-attr-val"
                        value={row.value}
                        onChange={e =>
                          setAttrs(a =>
                            a.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                          )
                        }
                        placeholder="value"
                      />
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => setAttrs(a => a.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    </Flex>
                  ))}
                  <div>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => setAttrs(a => [...a, { key: '', value: '' }])}
                    >
                      Add attribute
                    </Button>
                  </div>
                </Flex>
              </div>

              <div>
                <label className="osa-label">
                  Reason <span className="osa-required">*</span>
                </label>
                <textarea
                  className="osa-textarea"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Why is this account needed?"
                  rows={3}
                />
              </div>

              <Flex gap="2">
                <Button
                  variant="secondary"
                  onClick={() => navigate(requestsLink())}
                  isDisabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={submit}
                  isDisabled={busy || !canSubmit}
                >
                  Submit create request
                </Button>
              </Flex>
            </Flex>
          </Box>
        </Flex>
      </Container>
    </>
  );
};
