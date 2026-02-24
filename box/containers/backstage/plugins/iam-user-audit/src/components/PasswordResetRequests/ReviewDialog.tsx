import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { iamUserAuditApiRef } from '../../api';
import { PasswordResetRequest } from '../../api/types';
import '../PasswordResetDialog/PasswordResetDialog.css';

interface ReviewDialogProps {
  request: PasswordResetRequest;
  action: 'approve' | 'reject';
  open: boolean;
  onClose: () => void;
  onReviewed: () => void;
}

export const ReviewDialog = ({
  request,
  action,
  open,
  onClose,
  onReviewed,
}: ReviewDialogProps) => {
  const api = useApi(iamUserAuditApiRef);
  const [comment, setComment] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  if (!open) return null;

  const isApprove = action === 'approve';

  const handleSubmit = async () => {
    if (!comment.trim()) {
      setError('Comment is required');
      return;
    }
    if (isApprove && !newPassword) {
      setError('New password is required for approval');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await api.reviewPasswordResetRequest(request.id, {
        action,
        comment: comment.trim() || undefined,
        newPassword: isApprove ? newPassword : undefined,
      });
      setComment('');
      setNewPassword('');
      onReviewed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="prd-overlay" onClick={onClose}>
      <div className="prd-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          {isApprove ? 'Approve' : 'Reject'} Password Reset
        </Text>
        <Box mt="3">
          <Text as="p" variant="body-small" color="secondary">
            IAM User: <strong>{request.iamUserName}</strong>
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Requester: {request.requesterRef}
          </Text>
          <Text as="p" variant="body-small" color="secondary">
            Reason: {request.reason}
          </Text>
        </Box>

        {isApprove && (
          <Box mt="3">
            <label className="prd-label">
              <Text variant="body-small" weight="bold">
                New Password
              </Text>
              <div className="prd-password-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="prd-textarea prd-password-input"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Enter new password for the IAM user"
                  style={{ minHeight: 'auto' }}
                />
                <button
                  type="button"
                  className="prd-password-toggle"
                  onClick={() => setShowPassword(prev => !prev)}
                  tabIndex={-1}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
          </Box>
        )}

        <Box mt="3">
          <label className="prd-label">
            <Text variant="body-small" weight="bold">
              Comment
            </Text>
            <textarea
              className="prd-textarea"
              rows={2}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={
                isApprove
                  ? 'Reason for approval'
                  : 'Reason for rejection'
              }
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
          <Button
            variant="secondary"
            onPress={onClose}
            isDisabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant={isApprove ? 'primary' : 'secondary'}
            onPress={handleSubmit}
            isDisabled={submitting || !comment.trim() || (isApprove && !newPassword)}
          >
            {submitting
              ? 'Submitting...'
              : isApprove
                ? 'Approve & Reset'
                : 'Reject'}
          </Button>
        </Flex>
      </div>
    </div>
  );
};
