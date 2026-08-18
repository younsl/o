import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PasswordField,
  PluginHeader,
  Tag,
  TagGroup,
  Text,
  TextField,
} from '@backstage/ui';
import {
  RiArrowLeftLine,
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiPlugLine,
} from '@remixicon/react';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { staleBranchesPlugin } from '../../plugin';
import { staleBranchesApiRef } from '../../api';
import { CredentialProbeResult, EndpointProbeResult } from '../../api/types';
import { rootRouteRef } from '../../routes';
import '../ScheduleForm/ScheduleForm.css';

/**
 * The credential check carries a token on every call, so it waits for a real
 * pause. The reachability check carries nothing and only reads a URL, so it can
 * answer sooner without putting a secret on the wire that often.
 */
const CREDENTIAL_DEBOUNCE_MS = 1200;
const ENDPOINT_DEBOUNCE_MS = 500;

const SOURCE_LABELS: Record<string, string> = {
  database: 'saved here',
  'app-config': 'app-config',
  integrations: 'the integrations.gitlab block',
  unset: 'nowhere yet',
};

/**
 * Mirrors the backend rule so an obviously wrong value is reported without a
 * round trip. The backend still validates on save.
 */
const localUrlError = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full URL such as https://gitlab.example.com/api/v4';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'URL must use http or https';
  }
  if (!/\/api\/v\d+\/?$/.test(parsed.pathname)) {
    return 'URL must end with the API root, for example /api/v4';
  }
  return null;
};

type CheckState = 'idle' | 'busy' | 'ok' | 'bad';

/**
 * One precondition, its verdict, and what the verdict was based on.
 *
 * The tick sits on the label rather than inside the message, so a glance down
 * the labels says what is already settled without reading a word of the
 * results beside them.
 */
const CheckRow = ({
  label,
  state,
  children,
}: {
  label: string;
  state: CheckState;
  children: React.ReactNode;
}) => (
  <>
    <span className="sb-check-label">
      <span className="sb-check-icon" aria-hidden>
        {state === 'ok' && (
          <RiCheckboxCircleFill size={14} className="sb-probe-ok" />
        )}
        {state === 'bad' && (
          <RiErrorWarningFill size={14} className="sb-probe-bad" />
        )}
        {state === 'busy' && <span className="sb-probe-spinner" />}
      </span>
      <Text variant="body-x-small" color={state === 'ok' ? 'success' : 'secondary'}>
        {label}
      </Text>
    </span>
    <div className="sb-probe-status" aria-live="polite">
      {children}
    </div>
  </>
);

/**
 * The one GitLab connection every schedule scans through.
 *
 * Kept apart from the schedules for the same reason Airflow keeps connections
 * apart from DAGs: the credential is instance wide, and duplicating it per
 * schedule would mean rotating a token in as many places as there are scans.
 */
export const ConnectionPanel = () => {
  const api = useApi(staleBranchesApiRef);
  const navigate = useNavigate();
  const rootPath = useRouteRef(rootRouteRef)();

  const { value: adminStatus, loading: adminLoading } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: connection,
    loading: connectionLoading,
    retry,
  } = useAsyncRetry(async () => {
    if (!isAdmin) return undefined;
    return api.getConnection();
  }, [isAdmin]);

  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<CredentialProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [endpoint, setEndpoint] = useState<EndpointProbeResult | null>(null);
  const [endpointTesting, setEndpointTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!connection) return;
    // With one permitted API root there is nothing to choose, so the field
    // arrives filled rather than asking for what app-config already pins.
    const allowed = connection.allowedApiBaseUrls ?? [];
    setApiBaseUrl(
      connection.apiBaseUrl ?? (allowed.length === 1 ? allowed[0] : ''),
    );
  }, [connection]);

  // Editing either credential invalidates the previous probe, so the result
  // never claims a pair the admin has since changed.
  const update = useCallback(
    (setter: (value: string) => void, alsoClearsEndpoint = false) => {
      return (value: string) => {
        setter(value);
        setProbe(null);
        if (alsoClearsEndpoint) setEndpoint(null);
        setError(null);
        setSaved(false);
      };
    },
    [],
  );

  // Answers the half of the question that needs no token, so a URL typed into
  // an otherwise empty form is verified straight away rather than staying
  // silent until a credential exists.
  const endpointSeq = React.useRef(0);
  useEffect(() => {
    const url = apiBaseUrl.trim();
    if (!url || localUrlError(url) || !isAdmin) {
      setEndpointTesting(false);
      return undefined;
    }

    const seq = ++endpointSeq.current;
    setEndpointTesting(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.probeEndpoint(url);
        // A slower earlier request must not overwrite a newer answer.
        if (seq !== endpointSeq.current) return;
        setEndpoint(result);
      } catch {
        if (seq !== endpointSeq.current) return;
        setEndpoint({
          reachable: false,
          status: null,
          latencyMs: 0,
          looksLikeGitlab: false,
          error: 'The check could not be run',
        });
      } finally {
        if (seq === endpointSeq.current) setEndpointTesting(false);
      }
    }, ENDPOINT_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [api, apiBaseUrl, isAdmin]);

  // Probing on every keystroke would fire a request per character, and each one
  // carries a token, so the check waits for a pause long enough to read as
  // "done typing".
  const probeSeq = React.useRef(0);
  useEffect(() => {
    const url = apiBaseUrl.trim();
    // An empty token means "keep the stored one", which the backend probes
    // with, so a set-up instance still verifies without retyping the secret.
    const hasCredential = !!token.trim() || !!connection?.gitlabTokenMasked;
    if (!url || localUrlError(url) || !hasCredential || !isAdmin) {
      setTesting(false);
      return undefined;
    }

    const seq = ++probeSeq.current;
    setTesting(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.testConnection(url, token.trim() || undefined);
        // A slower earlier request must not overwrite a newer answer.
        if (seq !== probeSeq.current) return;
        setProbe(result);
      } catch (err) {
        if (seq !== probeSeq.current) return;
        setError(err instanceof Error ? err.message : 'Test failed');
      } finally {
        if (seq === probeSeq.current) setTesting(false);
      }
    }, CREDENTIAL_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [api, apiBaseUrl, token, connection?.gitlabTokenMasked, isAdmin]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveConnection(
        apiBaseUrl.trim(),
        token.trim() || undefined,
      );
      setProbe(result.probe);
      // The token is write only from here on, so the field is cleared once it
      // is stored.
      setToken('');
      setSaved(true);
      retry();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [api, apiBaseUrl, token, retry]);

  const header = (
    <PluginHeader
      icon={<RiPlugLine />}
      title="GitLab connection"
      customActions={
        <TagGroup>
          <Tag id="plugin-id" size="small">
            {staleBranchesPlugin.getId()}
          </Tag>
        </TagGroup>
      }
    />
  );

  if (adminLoading || (isAdmin && connectionLoading && !connection)) {
    return (
      <>
        {header}
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        {header}
        <Container my="4">
          <Alert
            status="warning"
            title="Only administrators can change the connection"
            description="Ask your DevOps team to set up the GitLab credentials."
          />
        </Container>
      </>
    );
  }

  const urlError = localUrlError(apiBaseUrl);
  const allowedUrls = connection?.allowedApiBaseUrls ?? [];
  const hasCredential = !!token.trim() || !!connection?.gitlabTokenMasked;

  const endpointState: CheckState = (() => {
    if (urlError || !apiBaseUrl.trim()) return 'idle';
    if (endpointTesting) return 'busy';
    if (!endpoint) return 'idle';
    return endpoint.reachable && endpoint.looksLikeGitlab ? 'ok' : 'bad';
  })();

  const credentialState: CheckState = (() => {
    if (!hasCredential || urlError || !apiBaseUrl.trim()) return 'idle';
    if (testing) return 'busy';
    if (!probe) return 'idle';
    return probe.reachable ? 'ok' : 'bad';
  })();

  return (
    <>
      {header}
      <Container my="4">
        <button type="button" className="sb-back" onClick={() => navigate(rootPath)}>
          <RiArrowLeftLine size={13} aria-hidden />
          All schedules
        </button>

        <Box mt="3">
          <Text variant="body-medium" color="secondary">
            Every schedule scans through these credentials. They are verified
            against the GitLab API before they are saved, so a wrong token is
            reported here rather than as an empty run later.
          </Text>
        </Box>

        {connection?.managedByConfig && (
          <Box mt="3">
            <Alert
              status="info"
              title="Credentials are pinned in app-config"
              description="Saving here stores an override in the database. Remove staleBranches.apiBaseUrl from app-config if you want the UI to be the only source."
            />
          </Box>
        )}

        <Box mt="4" p="3" className="sb-form-card">
          <Flex direction="column" gap="3">
            <Text variant="body-x-small" color="secondary">
              Currently read from {SOURCE_LABELS[connection?.source ?? 'unset']}
              {connection?.updatedAt
                ? `, last changed by ${connection.updatedBy ?? 'unknown'}`
                : ''}
            </Text>

            <TextField
              label="API URL"
              placeholder="https://gitlab.example.com/api/v4"
              value={apiBaseUrl}
              onChange={update(setApiBaseUrl, true)}
            />
            {/* The backend calls only the API roots app-config names, so the
                form says which ones those are rather than letting a save
                fail on an address it was never going to accept. */}
            <Text variant="body-x-small" color="secondary">
              {allowedUrls.length > 0
                ? `Allowed by app-config: ${allowedUrls.join(', ')}`
                : 'No GitLab instance is configured yet. Add integrations.gitlab or staleBranches.allowedHosts to app-config first.'}
            </Text>
            <PasswordField
              label="Token"
              placeholder={
                connection?.gitlabTokenMasked
                  ? `Stored as ${connection.gitlabTokenMasked}, leave empty to keep it`
                  : 'glpat-…'
              }
              value={token}
              onChange={update(setToken)}
            />
            <Text variant="body-x-small" color="secondary">
              A read_api scoped token is enough. It is stored as written and is
              never sent back to the browser.
            </Text>

            {/* Two checks, because they answer two different questions and fail
                for different reasons. Reachability needs no token, so it
                answers while the form is still half filled; the credential
                check needs one and says whose it is. Each row keeps its height
                across states so the form does not jump while checking. */}
            <div className="sb-checks">
              <CheckRow label="Endpoint" state={endpointState}>
                {(() => {
                  if (urlError) {
                    return (
                      <Text variant="body-x-small" color="danger">
                        {urlError}
                      </Text>
                    );
                  }
                  if (!apiBaseUrl.trim()) {
                    return (
                      <Text variant="body-x-small" color="secondary">
                        Checked automatically once you stop typing
                      </Text>
                    );
                  }
                  if (endpointTesting) {
                    return (
                      <Text variant="body-x-small" color="secondary">
                        Reaching {apiBaseUrl.trim()}/version
                      </Text>
                    );
                  }
                  if (endpointState === 'ok' && endpoint) {
                    return (
                      <Text variant="body-x-small" color="success">
                        Reachable in {endpoint.latencyMs}ms, answered HTTP{' '}
                        {endpoint.status}
                        {endpoint.status === 401
                          ? ' as an authenticated API expects'
                          : ''}
                      </Text>
                    );
                  }
                  if (endpoint) {
                    return (
                      <Text variant="body-x-small" color="danger">
                        {endpoint.reachable
                          ? endpoint.error
                          : `Did not answer after ${endpoint.latencyMs}ms. ${endpoint.error ?? ''}`}
                      </Text>
                    );
                  }
                  return null;
                })()}
              </CheckRow>

              <CheckRow label="Credential" state={credentialState}>
                {(() => {
                  if (!hasCredential) {
                    return (
                      <Text variant="body-x-small" color="secondary">
                        Enter a token to check it
                      </Text>
                    );
                  }
                  if (urlError || !apiBaseUrl.trim()) {
                    return (
                      <Text variant="body-x-small" color="secondary">
                        Waiting for a valid API URL
                      </Text>
                    );
                  }
                  if (testing) {
                    return (
                      <Text variant="body-x-small" color="secondary">
                        Calling {apiBaseUrl.trim()}/user
                      </Text>
                    );
                  }
                  if (probe?.reachable) {
                    return (
                      <Text variant="body-x-small" color="success">
                        Token belongs to {probe.username ?? 'an unnamed user'},
                        answered in {probe.latencyMs}ms
                      </Text>
                    );
                  }
                  if (probe) {
                    return (
                      <Text variant="body-x-small" color="danger">
                        {probe.error}
                      </Text>
                    );
                  }
                  return null;
                })()}
              </CheckRow>
            </div>

            {error && <Alert status="danger" title={error} />}
            {saved && !error && (
              <Alert status="success" title="Connection saved" />
            )}

            {/* Bottom right, and the primary last: the eye leaves the form at
                its end, which is where the action that commits it belongs. The
                way out sits before it so a stray click at the edge cancels
                rather than saves. */}
            <Flex gap="2" align="center" justify="end" className="sb-form-actions">
              <Button variant="secondary" onPress={() => navigate(rootPath)}>
                Back
              </Button>
              <Button
                variant="primary"
                onPress={handleSave}
                // Both checks gate the save, not just the credential one. A
                // failing endpoint already fails the credential probe today,
                // but the button should be blocked by what the reader is
                // looking at rather than by a consequence of it.
                isDisabled={
                  saving ||
                  testing ||
                  endpointTesting ||
                  !!urlError ||
                  endpointState !== 'ok' ||
                  credentialState !== 'ok'
                }
              >
                {saving ? 'Saving…' : 'Save connection'}
              </Button>
            </Flex>
          </Flex>
        </Box>
      </Container>
    </>
  );
};
