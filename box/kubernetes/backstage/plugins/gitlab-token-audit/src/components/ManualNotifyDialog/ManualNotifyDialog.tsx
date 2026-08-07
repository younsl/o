import React, { useEffect, useState } from 'react';
import {
  Accordion,
  AccordionPanel,
  AccordionTrigger,
  Alert,
  Box,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Flex,
  Switch,
  Text,
  TextField,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { gitlabTokenAuditApiRef } from '../../api';

interface Props {
  defaultOpen?: boolean;
  onClose: () => void;
  /** Optional pre-filtered set of tokenKeys to notify. Empty/undefined = let
   *  backend pick all eligible tokens within the largest configured threshold. */
  tokenKeys?: string[];
  /** Display label for the target — used when notifying a single token. */
  targetLabel?: string;
  /** Webhook config presence — disables submit if missing. */
  webhookConfigured: boolean;
}

export const ManualNotifyDialog = ({
  defaultOpen = true,
  onClose,
  tokenKeys,
  targetLabel,
  webhookConfigured,
}: Props) => {
  const api = useApi(gitlabTokenAuditApiRef);

  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    sent: number;
    skipped: number;
    candidates: number;
    note?: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    candidateCount: number;
    payload: Record<string, unknown>;
  } | null>(null);

  const refreshPreview = async () => {
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const data = await api.previewNotifyPayload({
        tokenKeys,
        reason: reason.trim() || undefined,
      });
      setPreview(data);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  // Re-fetch preview when reason changes (debounced via natural keystroke
  // cadence — small payload, admin-only endpoint).
  useEffect(() => {
    const id = setTimeout(() => {
      refreshPreview();
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reason]);

  const targetCount = tokenKeys?.length ?? null;

  const handleSubmit = async () => {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const res = await api.triggerManualNotify({
        tokenKeys,
        reason: reason.trim() || undefined,
        force,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to trigger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogTrigger
      defaultOpen={defaultOpen}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <button
        aria-hidden
        style={{ position: 'fixed', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
      >
        trigger
      </button>
      <Dialog width={520}>
        <DialogHeader>Send notification now</DialogHeader>
        <DialogBody>
          <Flex direction="column" gap="3">
            {!webhookConfigured && (
              <Alert
                status="warning"
                title="Webhook is not configured"
                description='Configure it from "Webhook settings" first.'
              />
            )}

            <Text variant="body-small" color="secondary">
              {targetCount === null
                ? 'All active tokens whose remaining time is within the largest configured threshold will be notified.'
                : `${targetCount} selected token${targetCount === 1 ? '' : 's'} will be notified.`}
            </Text>

            <TextField
              label="Reason (optional)"
              description="Included in the notification payload — useful for audit trail."
              placeholder="e.g. quarterly token rotation reminder"
              value={reason}
              onChange={setReason}
            />

            <Box>
              <Switch
                isSelected={force}
                onChange={setForce}
                label="Force resend (ignore dedup)"
              />
              <Text variant="body-x-small" color="secondary">
                By default, a token already notified for its current (threshold,
                expiresAt) pair will be skipped.
              </Text>
            </Box>

            <Accordion>
              <AccordionTrigger
                title={
                  preview
                    ? `Preview payload (${preview.candidateCount} token${preview.candidateCount === 1 ? '' : 's'})`
                    : 'Preview payload'
                }
              />
              <AccordionPanel>
                <Flex direction="column" gap="2">
                  <Flex justify="between" align="center">
                    <Text variant="body-x-small" color="secondary">
                      Exact JSON body that will be POSTed to the webhook URL.
                    </Text>
                    <Button
                      variant="tertiary"
                      size="small"
                      onPress={refreshPreview}
                      isDisabled={previewLoading}
                    >
                      {previewLoading ? 'Loading…' : 'Refresh'}
                    </Button>
                  </Flex>
                  {previewError && <Alert status="danger" title={previewError} />}
                  {preview && (
                    <Box
                      style={{
                        background: 'var(--bui-bg-neutral-2, rgba(0,0,0,0.25))',
                        border: '1px solid var(--bui-border-1, rgba(255,255,255,0.08))',
                        borderRadius: 6,
                        padding: 12,
                        maxHeight: 320,
                        overflow: 'auto',
                      }}
                    >
                      <pre
                        style={{
                          margin: 0,
                          fontSize: 11,
                          lineHeight: 1.5,
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, monospace',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {JSON.stringify(preview.payload, null, 2)}
                      </pre>
                    </Box>
                  )}
                </Flex>
              </AccordionPanel>
            </Accordion>

            {error && <Alert status="danger" title={error} />}
            {result && (
              <Alert
                status={result.sent > 0 ? 'success' : 'info'}
                title={`Sent: ${result.sent} · Skipped: ${result.skipped} · Candidates: ${result.candidates}`}
                description={result.note}
              />
            )}
          </Flex>
        </DialogBody>
        <DialogFooter>
          <Flex gap="2" justify="end" style={{ width: '100%' }}>
            <Button variant="secondary" onPress={onClose} isDisabled={submitting}>
              Close
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              isDisabled={submitting || !webhookConfigured}
            >
              {submitting ? 'Sending…' : 'Send notification'}
            </Button>
          </Flex>
        </DialogFooter>
      </Dialog>
    </DialogTrigger>
  );
};
