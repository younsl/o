import React from 'react';
import { Button, Flex, Skeleton, Text } from '@backstage/ui';
import { RequestStatus } from '../api/types';
import './opensearch-account.css';

export type AsyncState<T> = { loading: boolean; error?: Error; value?: T };

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Pending',
  executed: 'Executed',
  rejected: 'Rejected',
  failed: 'Failed',
};

export const RoleChips = ({ roles }: { roles: string[] }) => {
  if (roles.length === 0) return <span className="osa-muted">-</span>;
  return (
    <span className="osa-chips">
      {roles.map(r => (
        <span key={r} className="osa-chip">
          {r}
        </span>
      ))}
    </span>
  );
};

export const Loading = () => (
  <Flex direction="column" gap="2">
    <Skeleton style={{ height: 24, width: '30%' }} />
    <Skeleton style={{ height: 120 }} />
  </Flex>
);

export const RoleCheckboxGrid = ({
  options,
  loading,
  selected,
  toggle,
  emptyText,
}: {
  options: string[];
  loading: boolean;
  selected: Set<string>;
  toggle: (r: string) => void;
  emptyText: string;
}) => {
  if (loading) return <Skeleton style={{ height: 80 }} />;
  return (
    <div className="osa-role-grid">
      {options.map(r => (
        <label key={r} className="osa-role-option">
          <input
            type="checkbox"
            checked={selected.has(r)}
            onChange={() => toggle(r)}
          />
          <span className="osa-mono">{r}</span>
        </label>
      ))}
      {options.length === 0 && <span className="osa-muted">{emptyText}</span>}
    </div>
  );
};

export const Modal = (props: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) => (
  <div className="osa-modal-backdrop" onClick={props.onCancel}>
    <div className="osa-modal" onClick={e => e.stopPropagation()}>
      <Text variant="title-small">{props.title}</Text>
      <div className="osa-modal-body">{props.children}</div>
      <Flex gap="2" justify="end">
        <Button variant="secondary" onClick={props.onCancel} isDisabled={props.busy}>
          Cancel
        </Button>
        <Button
          variant={props.danger ? 'secondary' : 'primary'}
          onClick={props.onConfirm}
          isDisabled={props.busy || props.confirmDisabled}
        >
          {props.confirmLabel}
        </Button>
      </Flex>
    </div>
  </div>
);
