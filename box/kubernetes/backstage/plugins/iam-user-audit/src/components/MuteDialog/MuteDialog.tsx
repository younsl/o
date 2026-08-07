import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { iamUserAuditApiRef } from '../../api';
import '../PasswordResetDialog/PasswordResetDialog.css';

interface MuteDialogProps {
  userName: string;
  passwordLastUsed: string | null;
  hasConsoleAccess: boolean;
  open: boolean;
  onClose: () => void;
  onMuted: () => void;
}

const formatDate = (dateString: string | null) => {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleString();
};

export const MuteDialog = ({
  userName,
  passwordLastUsed,
  hasConsoleAccess,
  open,
  onClose,
  onMuted,
}: MuteDialogProps) => {
  const api = useApi(iamUserAuditApiRef);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
    return undefined;
  }, [open]);

  if (!open) return null;

  const trimmedReason = reason.trim();
  const isReasonValid = trimmedReason.length > 0;

  const handleSubmit = async () => {
    if (!isReasonValid) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.muteUser(userName, trimmedReason);
      setReason('');
      onMuted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mute user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="prd-overlay" onClick={onClose}>
      <div className="prd-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          Mute Alarms
        </Text>
        <Box mt="3">
          <Text variant="body-small" color="secondary">
            IAM User: <strong>{userName}</strong>
          </Text>
        </Box>
        <Box mt="1">
          <Text variant="body-small" color="secondary">
            Console Last Used: <strong>{formatDate(passwordLastUsed)}</strong>{' '}
            <Text
              as="span"
              variant="body-x-small"
              color={hasConsoleAccess ? 'success' : 'secondary'}
            >
              ({hasConsoleAccess ? 'Enabled' : 'Disabled'})
            </Text>
          </Text>
        </Box>
        <Box mt="2">
          <Text variant="body-small" color="secondary">
            Channel notifications and warning DMs for this user will be
            suppressed until unmuted.
          </Text>
        </Box>
        <Box mt="3">
          <label className="prd-label">
            <Text variant="body-small" weight="bold">
              Reason{' '}
              <Text as="span" variant="body-x-small" color="danger">
                *
              </Text>
            </Text>
            <textarea
              className="prd-textarea"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. on long-term leave, system account, ..."
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
            onPress={handleSubmit}
            isDisabled={submitting || !isReasonValid}
          >
            {submitting ? 'Muting...' : 'Mute'}
          </Button>
        </Flex>
      </div>
    </div>
  );
};
