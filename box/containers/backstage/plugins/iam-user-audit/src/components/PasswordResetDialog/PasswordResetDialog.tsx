import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Text } from '@backstage/ui';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { iamUserAuditApiRef } from '../../api';
import './PasswordResetDialog.css';

interface PasswordResetDialogProps {
  userName: string;
  userArn: string;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

export const PasswordResetDialog = ({
  userName,
  userArn,
  open,
  onClose,
  onSubmitted,
}: PasswordResetDialogProps) => {
  const api = useApi(iamUserAuditApiRef);
  const identityApi = useApi(identityApiRef);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const profileInfo = await identityApi.getProfileInfo();
      await api.createPasswordResetRequest({
        iamUserName: userName,
        iamUserArn: userArn,
        reason: reason.trim(),
        requesterEmail: profileInfo.email,
      });
      setReason('');
      onSubmitted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="prd-overlay" onClick={onClose}>
      <div className="prd-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          Request Password Reset
        </Text>
        <Box mt="3">
          <Text variant="body-small" color="secondary">
            IAM User: <strong>{userName}</strong>
          </Text>
        </Box>
        <Box mt="3">
          <label className="prd-label">
            <Text variant="body-small" weight="bold">
              Reason
            </Text>
            <textarea
              className="prd-textarea"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Why does this user need a password reset?"
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
            isDisabled={submitting || !reason.trim()}
          >
            {submitting ? 'Submitting...' : 'Submit Request'}
          </Button>
        </Flex>
      </div>
    </div>
  );
};
