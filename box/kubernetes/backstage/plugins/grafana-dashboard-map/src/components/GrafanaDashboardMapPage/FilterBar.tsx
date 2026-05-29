import React from 'react';
import { Flex, SearchField } from '@backstage/ui';

export interface FilterBarProps {
  search: string;
  onSearchChange: (q: string) => void;
}

export const FilterBar = ({ search, onSearchChange }: FilterBarProps) => {
  return (
    <Flex align="center" gap="2" pb="2">
      <div style={{ flex: 1, minWidth: 240, maxWidth: 480 }}>
        <SearchField
          placeholder="Search by title, folder, tag…"
          value={search}
          onChange={onSearchChange}
        />
      </div>
    </Flex>
  );
};
