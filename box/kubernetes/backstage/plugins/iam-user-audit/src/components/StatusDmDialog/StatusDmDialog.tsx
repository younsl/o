import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Skeleton, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { iamUserAuditApiRef } from '../../api';
import '../PasswordResetDialog/PasswordResetDialog.css';

interface SlackUserInfo {
  id: string;
  realName: string;
  displayName: string;
  title: string;
  image48: string;
  email: string;
}

interface StatusDmDialogProps {
  userName: string;
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}

export const StatusDmDialog = ({
  userName,
  open,
  onClose,
  onSent,
}: StatusDmDialogProps) => {
  const api = useApi(iamUserAuditApiRef);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slackUser, setSlackUser] = useState<SlackUserInfo | null>(null);
  const [slackLoading, setSlackLoading] = useState(true);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSlackLoading(true);
    api.getSlackUserInfo(userName)
      .then(setSlackUser)
      .catch(() => setSlackUser(null))
      .finally(() => setSlackLoading(false));
  }, [api, open, userName]);

  if (!open) return null;

  const handleSend = async () => {
    if (!message.trim()) {
      setError('Message is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.sendStatusDm(userName, message.trim());
      setMessage('');
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send DM');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="prd-overlay" onClick={onClose}>
      <div className="prd-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          Send Status DM
        </Text>
        <Box mt="3">
          <Text variant="body-small" color="secondary">
            IAM User: <strong>{userName}</strong>
          </Text>
        </Box>

        {/* Slack User Info */}
        <Box mt="3" style={{ background: '#2a2a2a', borderRadius: 6, padding: 12 }}>
          <Text variant="body-x-small" color="secondary" style={{ marginBottom: 8, display: 'block' }}>
            Slack Recipient
          </Text>
          {slackLoading ? (
            <Flex gap="2" align="center">
              <Skeleton width={36} height={36} />
              <Flex direction="column" gap="1">
                <Skeleton width={120} height={14} />
                <Skeleton width={160} height={12} />
              </Flex>
            </Flex>
          ) : slackUser ? (
            <Flex gap="2" align="center">
              <img
                src={slackUser.image48}
                alt={slackUser.realName}
                width={36}
                height={36}
                style={{ borderRadius: '50%' }}
              />
              <Flex direction="column">
                <Text variant="body-small" weight="bold">
                  {slackUser.realName}
                  {slackUser.displayName && slackUser.displayName !== slackUser.realName && (
                    <Text as="span" variant="body-x-small" color="secondary">
                      {' '}({slackUser.displayName})
                    </Text>
                  )}
                </Text>
                <Text variant="body-x-small" color="secondary">
                  {slackUser.email}
                  {slackUser.title && ` · ${slackUser.title}`}
                </Text>
              </Flex>
            </Flex>
          ) : (
            <Text variant="body-small" color="danger">
              Slack user not found
            </Text>
          )}
        </Box>

        <Box mt="3">
          <label className="prd-label">
            <Text variant="body-small" weight="bold">
              Message <Text as="span" variant="body-small" color="danger">*</Text>
            </Text>
            <textarea
              className="prd-textarea"
              rows={4}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Describe the current status and required actions..."
            />
          </label>
        </Box>
        {error && (
          <Box mt="2">
            <Text variant="body-small" color="danger">
              {error}
            </Text>
          </Box>
        )}
        <Flex gap="2" justify="end" mt="4">
          <Button variant="secondary" onPress={onClose} isDisabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={handleSend}
            isDisabled={submitting || !message.trim() || !slackUser}
          >
            {submitting ? 'Sending...' : 'Send'}
          </Button>
        </Flex>
      </div>
    </div>
  );
};
