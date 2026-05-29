import React, { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  Link,
  PluginHeader,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiKeyLine } from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { gitlabTokenAuditPlugin } from '../../plugin';
import { useAsyncRetry } from 'react-use';
import { gitlabTokenAuditApiRef } from '../../api';
import { GitlabToken, WebhookConfig } from '../../api/types';
import { ManualNotifyDialog } from '../ManualNotifyDialog';

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : '—';

const formatLastUsed = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'Never used';

const STATE_STYLE: Record<
  GitlabToken['state'],
  { bg: string; border: string; fg: string }
> = {
  active: {
    bg: 'rgba(34, 197, 94, 0.15)',
    border: 'rgba(34, 197, 94, 0.5)',
    fg: '#22c55e',
  },
  expired: {
    bg: 'rgba(239, 68, 68, 0.15)',
    border: 'rgba(239, 68, 68, 0.5)',
    fg: '#ef4444',
  },
  revoked: {
    bg: 'rgba(156, 163, 175, 0.15)',
    border: 'rgba(156, 163, 175, 0.5)',
    fg: '#9ca3af',
  },
  inactive: {
    bg: 'rgba(156, 163, 175, 0.15)',
    border: 'rgba(156, 163, 175, 0.5)',
    fg: '#9ca3af',
  },
};

const kindLabel = (kind: GitlabToken['kind']) =>
  kind === 'personal'
    ? 'Personal Access Token'
    : kind === 'project'
    ? 'Project Access Token'
    : 'Group Access Token';

const ACCESS_LEVEL_LABEL: Record<number, string> = {
  5: 'Minimal Access',
  10: 'Guest',
  20: 'Reporter',
  30: 'Developer',
  40: 'Maintainer',
  50: 'Owner',
};

const accessLevelLabel = (level: number | undefined): string => {
  if (level === undefined) return '—';
  return `${ACCESS_LEVEL_LABEL[level] ?? 'Custom'} (${level})`;
};

const ownerLabel = (token: GitlabToken) => {
  if (token.kind === 'personal') {
    if (token.userName) return `@${token.userName}`;
    if (token.userId) return `user #${token.userId}`;
    return '—';
  }
  return token.ownerScope ?? '—';
};

export const TokenDetailPage = () => {
  const api = useApi(gitlabTokenAuditApiRef);
  const navigate = useNavigate();
  const { tokenKey } = useParams<{ tokenKey: string }>();
  const decodedKey = tokenKey ? decodeURIComponent(tokenKey) : '';

  const { value: tokens, loading } = useAsyncRetry(
    async () => api.listTokens(),
    [],
  );
  const [webhook, setWebhook] = useState<WebhookConfig | null | undefined>(
    undefined,
  );
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  React.useEffect(() => {
    api.getWebhook().then(setWebhook).catch(() => setWebhook(null));
    api
      .getStatus()
      .then(s => setLastFetchedAt(s.lastFetchedAt ?? null))
      .catch(() => setLastFetchedAt(null));
  }, [api]);

  const token = useMemo<GitlabToken | undefined>(() => {
    if (!tokens) return undefined;
    return tokens.find(
      t =>
        `${t.kind}:${t.ownerScope ?? 'pat'}:${t.id}` === decodedKey,
    );
  }, [tokens, decodedKey]);

  const [notifyOpen, setNotifyOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    } finally {
      setTimeout(() => setCopyStatus('idle'), 1500);
    }
  };

  const notifyDisabledReason: string | null = (() => {
    if (webhook === undefined) return 'Loading webhook settings…';
    if (webhook === null) {
      return 'Webhook not configured. Set gitlabTokenAudit.webhook in app-config.';
    }
    if (!webhook.enabled) {
      return 'Webhook is disabled. Set gitlabTokenAudit.webhook.enabled=true.';
    }
    if (!webhook.url) {
      return 'Webhook URL is empty.';
    }
    return null;
  })();

  if (loading) {
    return (
      <>
        <PluginHeader
          icon={<RiKeyLine />}
          title="GitLab Token"
          customActions={
            <TagGroup>
              <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
            </TagGroup>
          }
        />
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (!token) {
    return (
      <>
        <PluginHeader
          icon={<RiKeyLine />}
          title="GitLab Token"
          customActions={
            <TagGroup>
              <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
            </TagGroup>
          }
        />
        <Container my="4">
          <Alert
            status="warning"
            title="Token not found"
            description={`No cached token matches key "${decodedKey}". It may have been deleted on GitLab side, or the cache is stale.`}
          />
          <Box mt="3">
            <Button variant="secondary" onPress={() => navigate('..')}>
              Back to list
            </Button>
          </Box>
        </Container>
      </>
    );
  }

  const remaining =
    token.daysUntilExpiry === null
      ? 'No expiry'
      : token.daysUntilExpiry < 0
      ? `Expired ${Math.abs(token.daysUntilExpiry)}d ago`
      : `${token.daysUntilExpiry}d remaining`;

  return (
    <>
      <PluginHeader
        icon={<RiKeyLine />}
        title={`Token · ${token.name}`}
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">{gitlabTokenAuditPlugin.getId()}</Tag>
          </TagGroup>
        }
      />
      <Container my="4">
        <Box mb="3">
          <Button variant="tertiary" onPress={() => navigate('..')}>
            ← Back to list
          </Button>
        </Box>

        <Box
          p="3"
          style={{
            background: 'var(--bui-color-bg-elevated, #1a1a1a)',
            borderRadius: 8,
          }}
        >
          <Flex justify="between" align="center" mb="3" style={{ flexWrap: 'wrap' }} gap="2">
            <Flex direction="column" gap="1">
              <Text variant="title-medium" weight="bold">
                {token.name}
              </Text>
              <Text variant="body-small" color="secondary">
                {kindLabel(token.kind)} · {ownerLabel(token)}
              </Text>
              {token.description && (
                <Text variant="body-small" color="secondary" style={{ fontStyle: 'italic' }}>
                  {token.description}
                </Text>
              )}
            </Flex>
            <Flex direction="column" align="end" gap="1">
              <Box
                px="2"
                py="1"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  backgroundColor: STATE_STYLE[token.state].bg,
                  border: `1px solid ${STATE_STYLE[token.state].border}`,
                  borderRadius: 4,
                  color: STATE_STYLE[token.state].fg,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  lineHeight: 1,
                }}
              >
                {token.state.toUpperCase()}
              </Box>
              {lastFetchedAt && (
                <Text variant="body-x-small" color="secondary">
                  Last fetched{' '}
                  {new Date(lastFetchedAt).toLocaleString(undefined, {
                    timeZoneName: 'short',
                  })}
                </Text>
              )}
            </Flex>
          </Flex>

          <Flex direction="column" gap="3">
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--bui-space-3, 12px)',
              }}
            >
              <DetailField label="Kind" value={kindLabel(token.kind)} />
              <DetailField
                label="Owner"
                value={
                  token.webUrl ? (
                    <Link
                      href={token.webUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ownerLabel(token)}
                    </Link>
                  ) : (
                    ownerLabel(token)
                  )
                }
              />
              {token.kind !== 'personal' && (
                <DetailField
                  label="Access level"
                  value={accessLevelLabel(token.accessLevel)}
                />
              )}
              {token.kind === 'personal' &&
                token.impersonation !== undefined && (
                  <DetailField
                    label="Impersonation"
                    value={token.impersonation ? 'Yes' : 'No'}
                  />
                )}
              <DetailField label="Active" value={token.active ? 'Yes' : 'No'} />
              <DetailField
                label="Revoked"
                value={token.revoked ? 'Yes' : 'No'}
              />
            </Box>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 'var(--bui-space-3, 12px)',
              }}
            >
              <DetailField
                label="Expires"
                value={token.expiresAt ?? 'No expiry'}
              />
              <DetailField label="Remaining" value={remaining} />
              <DetailField
                label="Created"
                value={formatDate(token.createdAt)}
              />
              <DetailField
                label="Last used"
                value={formatLastUsed(token.lastUsedAt)}
              />
            </Box>
          </Flex>

          <Box mt="3">
            <Text variant="body-x-small" color="secondary">
              Scopes ({token.scopes.length})
            </Text>
            <Box mt="1">
              {token.scopes.length === 0 ? (
                <Text variant="body-small" color="secondary">
                  —
                </Text>
              ) : (
                <TagGroup>
                  {token.scopes.map(s => (
                    <Tag key={s}>{s}</Tag>
                  ))}
                </TagGroup>
              )}
            </Box>
          </Box>
        </Box>

        <Box
          mt="4"
          p="3"
          style={{
            background: 'var(--bui-color-bg-elevated, #1a1a1a)',
            borderRadius: 8,
          }}
        >
          <Flex direction="column" gap="2">
            <Text variant="body-medium" weight="bold">
              GitLab Token URL
            </Text>
            {token.webUrl ? (
              <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
                <Link
                  href={token.webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="body-small"
                  style={{
                    flex: '1 1 320px',
                    minWidth: 240,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {token.webUrl}
                </Link>
                <Button
                  variant="secondary"
                  size="small"
                  onPress={() => handleCopy(token.webUrl!)}
                >
                  {copyStatus === 'copied'
                    ? 'Copied!'
                    : copyStatus === 'failed'
                    ? 'Copy failed'
                    : 'Copy'}
                </Button>
              </Flex>
            ) : (
              <Text variant="body-small" color="secondary">
                URL unavailable — owning project/group could not be resolved
                (deleted or insufficient token scope).
              </Text>
            )}
          </Flex>
        </Box>

        <Box
          mt="4"
          p="3"
          style={{
            background: 'var(--bui-color-bg-elevated, #1a1a1a)',
            borderRadius: 8,
          }}
        >
          <Flex direction="column" gap="2">
            <Text variant="body-medium" weight="bold">
              Notify
            </Text>
            <Text variant="body-small" color="secondary">
              Trigger a webhook for this token. Reuses the configured webhook
              URL and Slack template.
            </Text>
            <Box>
              <Button
                variant="primary"
                onPress={() => setNotifyOpen(true)}
                isDisabled={!!notifyDisabledReason}
              >
                Send notification
              </Button>
              {notifyDisabledReason && (
                <Box mt="2">
                  <Text variant="body-x-small" color="secondary">
                    {notifyDisabledReason}
                  </Text>
                </Box>
              )}
            </Box>
          </Flex>
        </Box>
      </Container>

      {notifyOpen && (
        <ManualNotifyDialog
          onClose={() => setNotifyOpen(false)}
          tokenKeys={[decodedKey]}
          targetLabel={token.name}
          webhookConfigured={!!webhook?.enabled && !!webhook.url}
        />
      )}
    </>
  );
};

interface DetailFieldProps {
  label: string;
  value: React.ReactNode;
}

const DetailField = ({ label, value }: DetailFieldProps) => (
  <Box
    p="3"
    style={{
      background: 'var(--bui-bg-neutral-2, rgba(255,255,255,0.04))',
      border: '1px solid var(--bui-border-1, rgba(255,255,255,0.08))',
      borderRadius: 'var(--bui-radius-3, 6px)',
      minWidth: 0,
    }}
  >
    <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
      <Text as="div" variant="body-x-small" color="secondary">
        {label}
      </Text>
      <Text
        as="div"
        variant="body-small"
        weight="bold"
        style={{
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </Text>
    </Flex>
  </Box>
);
