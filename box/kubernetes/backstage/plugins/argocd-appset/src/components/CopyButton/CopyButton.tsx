import React, { useCallback, useEffect, useId, useState } from 'react';
import { ButtonIcon, Tooltip, TooltipTrigger } from '@backstage/ui';
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';

const COPIED_RESET_MS = 2000;

/**
 * There is one clipboard, so only one button can honestly claim to hold what is
 * in it. Every mounted button listens, and a copy anywhere clears the check mark
 * everywhere else at once rather than leaving two buttons both claiming it until
 * a timer runs out.
 */
const listeners = new Set<(activeId: string) => void>();

function announceCopy(id: string): void {
  listeners.forEach(listener => listener(id));
}

/**
 * Copies `value` to the clipboard and confirms by swapping its icon for a check
 * mark. Clipboard access can be refused, in which case the button does nothing
 * rather than interrupting the reader with a failure they cannot act on.
 */
export const CopyButton = (props: {
  value: string;
  /** What is being copied, used in the label a screen reader announces */
  subject: string;
  className?: string;
  iconSize?: number;
}) => {
  const id = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    const listener = (activeId: string) => {
      if (activeId !== id) setCopied(false);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [id]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      announceCopy(id);
    } catch {
      // Clipboard unavailable or denied: leave the button as it was.
    }
  }, [props.value, id]);

  const iconSize = props.iconSize ?? 14;

  return (
    <TooltipTrigger delay={200}>
      <ButtonIcon
        size="small"
        variant="tertiary"
        className={props.className}
        icon={
          copied ? <RiCheckLine size={iconSize} /> : <RiFileCopyLine size={iconSize} />
        }
        aria-label={copied ? `Copied ${props.subject}` : `Copy ${props.subject}`}
        onPress={handleCopy}
      />
      <Tooltip>{copied ? 'Copied' : `Copy ${props.subject}`}</Tooltip>
    </TooltipTrigger>
  );
};
