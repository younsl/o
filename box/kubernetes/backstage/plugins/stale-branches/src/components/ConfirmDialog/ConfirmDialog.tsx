import React, { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Flex,
  Text,
  TextField,
} from '@backstage/ui';
import './ConfirmDialog.css';

/**
 * In-app confirmation for a destructive action.
 *
 * `window.confirm` is blocked by some browsers inside an embedded frame and
 * cannot carry the context that makes a delete safe to approve, so the prompt
 * is a real dialog. DialogTrigger wants a trigger element even when the open
 * state is controlled from outside, so a hidden one stands in for it.
 *
 * With `requireText` the action stays locked until the reader types that exact
 * string. A dialog whose only cost is one more click is answered by reflex, and
 * the row that opened it is the row nobody checked. Typing the name is the
 * cheapest way to make approving it require having read which one it is.
 */
export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  requireText,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the confirm button unlocks only on an exact match. */
  requireText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const [typed, setTyped] = useState('');

  // Reopening for a different row must not inherit the last row's answer.
  useEffect(() => {
    if (open) setTyped('');
  }, [open, requireText]);

  const locked = !!requireText && typed.trim() !== requireText;

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={next => {
        // Escape and an outside click both resolve to a cancel, so dismissing is
        // never mistaken for approving.
        if (!next) onCancel();
      }}
    >
      {/* React Aria wires the trigger through press context, which a plain DOM
          button does not consume, so this is a real Button kept out of layout. */}
      <Button className="sb-hidden-trigger" aria-hidden>
        {''}
      </Button>
      <Dialog className="sb-confirm-dialog">
        <DialogHeader>{title}</DialogHeader>
        <DialogBody>
          <Flex direction="column" gap="3">
            <Text variant="body-small" color="secondary">
              {description}
            </Text>
            {requireText && (
              <Flex direction="column" gap="1">
                <TextField
                  label="Confirm the name"
                  description={`Type ${requireText} to enable the button`}
                  placeholder={requireText}
                  value={typed}
                  onChange={setTyped}
                  autoFocus
                />
                {/* Silent while empty: an error on a field nobody has typed in
                    yet reads as a failure rather than as an instruction. */}
                {typed.trim() !== '' && locked && (
                  <Text variant="body-x-small" color="danger">
                    That does not match.
                  </Text>
                )}
              </Flex>
            )}
          </Flex>
        </DialogBody>
        <DialogFooter>
          <Flex justify="end" gap="2">
            <Button variant="secondary" onPress={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              className={destructive ? 'sb-danger-button' : undefined}
              isDisabled={locked}
              onPress={onConfirm}
            >
              {confirmLabel}
            </Button>
          </Flex>
        </DialogFooter>
      </Dialog>
    </DialogTrigger>
  );
};
