import React from 'react';
import { Button, Flex } from '@backstage/ui';

export interface ToolbarProps {
  isAdmin: boolean;
  editing: boolean;
  saving: boolean;
  dirty: boolean;
  hasSelection: boolean;
  onEnterEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onAddBox: () => void;
  onAddGroup: () => void;
  onAddArea: () => void;
  onDeleteSelected: () => void;
}

export const Toolbar = ({
  isAdmin,
  editing,
  saving,
  dirty,
  hasSelection,
  onEnterEdit,
  onSave,
  onCancel,
  onAddBox,
  onAddGroup,
  onAddArea,
  onDeleteSelected,
}: ToolbarProps) => {
  if (!isAdmin) return null;

  if (!editing) {
    return (
      <Button size="small" variant="secondary" onPress={onEnterEdit}>
        Edit
      </Button>
    );
  }

  return (
    <Flex align="center" gap="1">
      <Button size="small" variant="secondary" onPress={onAddBox}>
        + Box
      </Button>
      <Button size="small" variant="secondary" onPress={onAddGroup}>
        + Group
      </Button>
      <Button size="small" variant="secondary" onPress={onAddArea}>
        + Area
      </Button>
      <Button
        size="small"
        variant="secondary"
        destructive
        onPress={onDeleteSelected}
        isDisabled={!hasSelection}
      >
        Delete
      </Button>

      <span
        style={{
          width: 1,
          height: 18,
          background: 'var(--bui-border-1)',
          margin: '0 var(--bui-space-1)',
        }}
      />

      <Button
        size="small"
        variant="secondary"
        onPress={onCancel}
        isDisabled={saving}
      >
        Cancel
      </Button>
      <Button
        size="small"
        variant="primary"
        onPress={onSave}
        isDisabled={saving || !dirty}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </Flex>
  );
};
