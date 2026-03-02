import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Flex,
  SearchField,
  Select,
  Text,
  Link,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { openApiRegistryApiRef } from '../../api';
import { OpenApiRegistration } from '../../api/types';

const tagStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 12,
  backgroundColor: 'var(--bui-color-bg-elevated, #2a2a2a)',
  border: '1px solid var(--bui-color-border-default, #444)',
};

const activeTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: 'var(--bui-color-bg-accent, #1e40af)',
  border: '1px solid var(--bui-color-border-accent, #3b82f6)',
  color: '#fff',
};

const iconButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 4,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  color: 'inherit',
  opacity: 0.7,
};

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 13,
  borderBottom: '1px solid var(--bui-color-border-default, #444)',
  color: 'var(--bui-color-text-secondary, #aaa)',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 13,
  borderBottom: '1px solid var(--bui-color-border-default, #333)',
};

const lifecycleOptions = [
  { value: 'all', label: 'All' },
  { value: 'production', label: 'Production' },
  { value: 'staging', label: 'Staging' },
  { value: 'development', label: 'Development' },
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'deprecated', label: 'Deprecated' },
];

export interface RegisteredApisListProps {
  registrations: OpenApiRegistration[] | undefined;
  loading: boolean;
  loadError: Error | undefined;
  onRetry: () => void;
}

export const RegisteredApisList = ({ registrations, loading, loadError, onRetry }: RegisteredApisListProps) => {
  const api = useApi(openApiRegistryApiRef);

  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingRegistration, setDeletingRegistration] =
    useState<OpenApiRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<string>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tagDropdownRef.current &&
        !tagDropdownRef.current.contains(e.target as Node)
      ) {
        setTagDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // Get unique owners for filter dropdown
  const uniqueOwners = useMemo(() => {
    if (!registrations) return [];
    return [...new Set(registrations.map(r => r.owner))].sort();
  }, [registrations]);

  const uniqueTags = useMemo(() => {
    if (!registrations) return [];
    return [...new Set(registrations.flatMap(r => r.tags ?? []))].sort();
  }, [registrations]);

  const ownerOptions = useMemo(() => [
    { value: 'all', label: 'All' },
    ...uniqueOwners.map(owner => ({ value: owner, label: owner })),
  ], [uniqueOwners]);

  // Filter registrations
  const filteredRegistrations = useMemo(() => {
    if (!registrations) return [];
    return registrations.filter(r => {
      const matchesSearch = searchQuery === '' ||
        r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.owner.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesLifecycle = lifecycleFilter === 'all' || r.lifecycle === lifecycleFilter;
      const matchesOwner = ownerFilter === 'all' || r.owner === ownerFilter;
      const matchesTag =
        selectedTags.size === 0 || [...selectedTags].every(t => (r.tags ?? []).includes(t));
      return matchesSearch && matchesLifecycle && matchesOwner && matchesTag;
    });
  }, [registrations, searchQuery, lifecycleFilter, ownerFilter, selectedTags]);

  const allCount = registrations?.length ?? 0;

  const hasActiveFilters =
    searchQuery !== '' ||
    lifecycleFilter !== 'all' ||
    ownerFilter !== 'all' ||
    selectedTags.size > 0;

  const handleRefresh = async (registration: OpenApiRegistration) => {
    setRefreshingId(registration.id);
    setError(null);
    setSuccess(null);

    try {
      await api.refreshApi(registration.id);
      setSuccess(`API "${registration.name}" refreshed. Changes will reflect in the Catalog shortly.`);
      onRetry();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to refresh API',
      );
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDeleteClick = (registration: OpenApiRegistration) => {
    setDeletingRegistration(registration);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingRegistration) return;

    setError(null);

    try {
      await api.deleteRegistration(deletingRegistration.id);
      setDeleteDialogOpen(false);
      setDeletingRegistration(null);
      onRetry();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete registration',
      );
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setDeletingRegistration(null);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <Flex justify="center" p="4">
        <Text color="secondary">Loading...</Text>
      </Flex>
    );
  }

  if (loadError) {
    return <Alert status="danger" description={`Failed to load registrations: ${loadError.message}`} />;
  }

  if (!registrations || registrations.length === 0) {
    return (
      <Flex direction="column" align="center" p="4">
        <Text weight="bold" color="secondary">No APIs registered yet</Text>
        <Text variant="body-small" color="secondary">
          Register your first API using the Register tab
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="3">
      {error && <Alert status="danger" description={error} />}
      {success && <Alert status="success" description={success} />}

      {/* Filters Section */}
      <Box
        p="3"
        style={{
          backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
          borderRadius: 4,
        }}
      >
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <Flex gap="2" align="end" direction={{ initial: 'column', sm: 'row' }}>
          <Box style={{ minWidth: 300 }}>
            <SearchField
              label="Search"
              placeholder="Search by name, title, or owner..."
              value={searchQuery}
              onChange={setSearchQuery}
              size="small"
            />
          </Box>
          <Box style={{ minWidth: 150 }}>
            <Select
              label="Lifecycle"
              options={lifecycleOptions}
              selectedKey={lifecycleFilter}
              onSelectionChange={(key) => setLifecycleFilter(key as string)}
            />
          </Box>
          <Box style={{ minWidth: 150 }}>
            <Select
              label="Owner"
              options={ownerOptions}
              selectedKey={ownerFilter}
              onSelectionChange={(key) => setOwnerFilter(key as string)}
            />
          </Box>
          {/* Tags Multi-Select */}
          {uniqueTags.length > 0 && (
            <Box style={{ minWidth: 160, position: 'relative' }} ref={tagDropdownRef}>
              <div style={{ fontSize: 'var(--bui-font-size-2, 0.75rem)', fontWeight: 400, marginBottom: 'var(--bui-space-3, 12px)', color: 'var(--bui-fg-primary, #fff)' }}>
                Tags ({uniqueTags.length})
              </div>
              <button
                type="button"
                onClick={() => setTagDropdownOpen(prev => !prev)}
                style={{
                  width: '100%',
                  height: '2rem',
                  padding: '0 var(--bui-space-3, 12px)',
                  fontSize: 'var(--bui-font-size-3, 0.875rem)',
                  fontWeight: 400,
                  fontFamily: 'var(--bui-font-regular, system-ui)',
                  background: 'var(--bui-bg-neutral-1, rgba(255,255,255,0.1))',
                  border: '1px solid var(--bui-border-2, #585858)',
                  borderRadius: 'var(--bui-radius-3, 8px)',
                  color: 'var(--bui-fg-primary, #fff)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 'var(--bui-space-2, 8px)',
                  boxSizing: 'border-box',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedTags.size === 0
                    ? 'All'
                    : `${selectedTags.size} selected`}
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5, transition: 'transform 0.15s', transform: tagDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
              {tagDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    zIndex: 100,
                    marginTop: 4,
                    minWidth: '100%',
                    maxHeight: 280,
                    overflowY: 'auto',
                    background: 'var(--bui-bg-popover, #1a1a1a)',
                    border: '1px solid var(--bui-border-1, #434343)',
                    borderRadius: 'var(--bui-radius-3, 8px)',
                    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
                  }}
                >
                  {selectedTags.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedTags(new Set())}
                      style={{
                        width: '100%',
                        padding: '0 var(--bui-space-3, 12px)',
                        height: '2rem',
                        fontSize: 'var(--bui-font-size-3, 0.875rem)',
                        background: 'none',
                        border: 'none',
                        borderBottom: '1px solid var(--bui-border-2, #585858)',
                        color: 'var(--bui-fg-secondary, rgba(255,255,255,0.5))',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      Clear all
                    </button>
                  )}
                  {uniqueTags.map(tag => (
                    <label
                      key={tag}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--bui-space-2, 8px)',
                        padding: '0 var(--bui-space-3, 12px)',
                        minHeight: '2rem',
                        fontSize: 'var(--bui-font-size-3, 0.875rem)',
                        cursor: 'pointer',
                        borderRadius: 'var(--bui-radius-2, 4px)',
                        backgroundColor: selectedTags.has(tag) ? 'var(--bui-bg-neutral-2, rgba(255,255,255,0.06))' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTags.has(tag)}
                        onChange={() => toggleTag(tag)}
                        style={{ accentColor: '#3b82f6' }}
                      />
                      {tag}
                    </label>
                  ))}
                </div>
              )}
            </Box>
          )}
        </Flex>
      </Box>

      {/* Registrations Section */}
      <Box
        p="3"
        style={{
          backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
          borderRadius: 4,
        }}
      >
        <Flex justify="between" align="center" mb="3">
          <Text variant="body-medium" weight="bold">
            Registrations
          </Text>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 24,
                height: 24,
                padding: '0 8px',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
                backgroundColor: hasActiveFilters ? '#f59e0b' : 'rgba(128,128,128,0.25)',
                color: hasActiveFilters ? '#fff' : 'rgba(255,255,255,0.7)',
              }}
            >
              {hasActiveFilters
                ? `${filteredRegistrations.length} / ${allCount}`
                : allCount}
            </span>
            <Text variant="body-small" color="secondary">
              APIs
            </Text>
          </span>
        </Flex>

        {filteredRegistrations.length === 0 ? (
          <Flex direction="column" align="center" p="4">
            <Text color="secondary">No APIs match the current filters</Text>
          </Flex>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>Owner</th>
                  <th style={thStyle}>Lifecycle</th>
                  <th style={thStyle}>Tags</th>
                  <th style={thStyle}>Registered At</th>
                  <th style={thStyle}>Last Synced</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRegistrations.map(registration => (
                  <tr key={registration.id}>
                    <td style={tdStyle}>
                      <Link href={`/catalog/default/api/${registration.name}`}>
                        {registration.name}
                      </Link>
                    </td>
                    <td style={tdStyle}>{registration.title || '-'}</td>
                    <td style={tdStyle}>{registration.owner}</td>
                    <td style={tdStyle}>
                      <span style={tagStyle}>{registration.lifecycle}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(registration.tags ?? []).length > 0
                          ? registration.tags!.map(tag => (
                              <span
                                key={tag}
                                style={selectedTags.has(tag) ? activeTagStyle : tagStyle}
                              >
                                {tag}
                              </span>
                            ))
                          : '-'}
                      </span>
                    </td>
                    <td style={tdStyle}>{formatDate(registration.createdAt)}</td>
                    <td style={tdStyle}>{formatDate(registration.lastSyncedAt)}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button
                          title="Refresh API spec"
                          aria-label="Refresh API spec"
                          style={{ ...iconButtonStyle, ...(refreshingId === registration.id ? { opacity: 0.3, pointerEvents: 'none' as const } : {}) }}
                          onClick={() => handleRefresh(registration)}
                          disabled={refreshingId === registration.id}
                        >
                          {refreshingId === registration.id ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ animation: 'spin 1s linear infinite' }}>
                              <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                            </svg>
                          )}
                        </button>
                        <a
                          title="View spec URL"
                          aria-label="View spec URL"
                          href={registration.specUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={iconButtonStyle}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
                          </svg>
                        </a>
                        <button
                          title="Delete registration"
                          aria-label="Delete registration"
                          style={iconButtonStyle}
                          onClick={() => handleDeleteClick(registration)}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                          </svg>
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>

      {/* Delete confirmation dialog */}
      {deleteDialogOpen && (
        <DialogTrigger defaultOpen onOpenChange={(open) => { if (!open) handleDeleteCancel(); }}>
          <button aria-hidden style={{ position: 'fixed', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}>trigger</button>
          <Dialog>
            <DialogHeader>Delete API Registration</DialogHeader>
            <DialogBody>
              <Text>
                Are you sure you want to delete the registration for "
                {deletingRegistration?.name}"? This will also remove the API entity
                from the catalog.
              </Text>
            </DialogBody>
            <DialogFooter>
              <Flex gap="2" justify="end">
                <Button variant="secondary" onPress={handleDeleteCancel}>Cancel</Button>
                <Button variant="primary" onPress={handleDeleteConfirm}>Delete</Button>
              </Flex>
            </DialogFooter>
          </Dialog>
        </DialogTrigger>
      )}
    </Flex>
  );
};
