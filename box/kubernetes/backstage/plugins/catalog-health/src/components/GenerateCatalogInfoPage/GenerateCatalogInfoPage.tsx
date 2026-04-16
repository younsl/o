import React, { useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Container, Flex, Grid, HeaderPage, Link, Select, Text, TextField } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useAsync } from 'react-use';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { catalogHealthApiRef } from '../../api';
import { highlightYamlLine } from '../../utils/yamlHighlight';
import './GenerateCatalogInfoPage.css';

const typeOptions = [
  { value: 'service', label: 'service' },
  { value: 'website', label: 'website' },
  { value: 'library', label: 'library' },
  { value: 'documentation', label: 'documentation' },
  { value: 'other', label: 'other' },
];

const lifecycleOptions = [
  { value: 'production', label: 'production' },
  { value: 'development', label: 'development' },
  { value: 'experimental', label: 'experimental' },
  { value: 'deprecated', label: 'deprecated' },
];

export const GenerateCatalogInfoPage = () => {
  const api = useApi(catalogHealthApiRef);
  const catalogApi = useApi(catalogApiRef);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const projectId = Number(searchParams.get('projectId') || 0);
  const projectName = searchParams.get('name') || '';
  const projectPath = searchParams.get('path') || '';

  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState('');
  const [type, setType] = useState('service');
  const [lifecycle, setLifecycle] = useState('production');
  const [owner, setOwner] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [showOwnerSuggestions, setShowOwnerSuggestions] = useState(false);
  const [ownerHighlightIndex, setOwnerHighlightIndex] = useState(-1);
  const ownerInputRef = useRef<HTMLInputElement>(null);
  const ownerSuggestionsRef = useRef<HTMLDivElement>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mrUrl, setMrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ALLOWED_BRANCHES = ['main', 'master'];

  const { value: branches = [] } = useAsync(async () => {
    if (!projectId) return [];
    const result = await api.getBranches(projectId);
    const allowed = result.filter(b => ALLOWED_BRANCHES.includes(b.name));
    const defaultBranch = allowed.find(b => b.default) ?? allowed[0];
    if (defaultBranch && !targetBranch) {
      setTargetBranch(defaultBranch.name);
    }
    return allowed;
  }, [projectId]);

  const branchOptions = useMemo(() =>
    branches.map(b => ({
      value: b.name,
      label: b.default ? `${b.name} (default)` : b.name,
    })),
  [branches]);

  const { value: catalogCounts = { tags: new Map<string, number>(), owners: new Map<string, number>() } } = useAsync(async () => {
    const { items } = await catalogApi.getEntities({
      filter: { kind: 'Component' },
      fields: ['metadata.tags', 'spec.owner'],
    });
    const tags = new Map<string, number>();
    const owners = new Map<string, number>();
    for (const entity of items) {
      const t = (entity.metadata as any).tags;
      if (Array.isArray(t)) t.forEach((tag: string) => tags.set(tag, (tags.get(tag) ?? 0) + 1));
      const o = (entity.spec as any)?.owner;
      if (typeof o === 'string' && o) owners.set(o, (owners.get(o) ?? 0) + 1);
    }
    return { tags, owners };
  }, [catalogApi]);

  const topOwner = useMemo(() => {
    let max = 0;
    let top = '';
    for (const [k, v] of catalogCounts.owners) {
      if (v > max) { max = v; top = k; }
    }
    return top;
  }, [catalogCounts.owners]);

  const filteredOwnerSuggestions = useMemo(() => {
    const allOwners = Array.from(catalogCounts.owners.keys()).sort();
    const q = owner.trim().toLowerCase();
    if (!q) return allOwners;
    return allOwners.filter(o => o.toLowerCase().includes(q));
  }, [owner, catalogCounts.owners]);

  const filteredSuggestions = useMemo(() => {
    const allTags = Array.from(catalogCounts.tags.keys()).sort();
    const q = tagInput.trim().toLowerCase();
    if (!q) return allTags.filter(t => !tags.includes(t));
    return allTags.filter(t => t.includes(q) && !tags.includes(t));
  }, [tagInput, catalogCounts.tags, tags]);

  const preview = useMemo(() => {
    const lines = [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      `  name: ${name || projectName}`,
      description ? `  description: ${description}` : null,
      projectPath ? '  annotations:' : null,
      projectPath ? `    gitlab.com/project-slug: ${projectPath}` : null,
    ];
    if (tags.length > 0) {
      lines.push('  tags:');
      tags.forEach(t => lines.push(`    - ${t}`));
    }
    lines.push(
      'spec:',
      `  type: ${type}`,
      `  lifecycle: ${lifecycle}`,
      `  owner: ${owner || 'unknown'}`,
    );
    return lines.filter(Boolean).join('\n');
  }, [name, description, type, lifecycle, owner, tags, projectName, projectPath]);

  const addTag = (value: string) => {
    const v = value.trim().toLowerCase();
    if (v && !tags.includes(v)) {
      setTags(prev => [...prev, v]);
    }
    setTagInput('');
    setShowSuggestions(false);
    setHighlightIndex(-1);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const result = await api.submitCatalogInfo({
        projectId,
        name: name || projectName,
        description,
        type,
        lifecycle,
        owner: owner || 'unknown',
        tags,
        targetBranch: targetBranch || undefined,
      });
      setMrUrl(result.mergeRequestUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <HeaderPage
        title="Generate catalog-info.yaml"
        breadcrumbs={[
          { label: 'Home', href: '/' },
          { label: 'Catalog Health', href: '/catalog-health' },
        ]}
      />
      <Container my="4">
        <Box style={{ maxWidth: 640 }}>
          <Text variant="body-small" color="secondary">
            {projectPath || 'Select a project from Catalog Health page'}
          </Text>

          {mrUrl ? (
            <Box mt="4">
              <Alert status="success" title="Merge Request created" />
              <Box mt="3">
                <Link href={mrUrl} target="_blank" rel="noopener noreferrer">
                  <Text variant="body-small">Open Merge Request</Text>
                </Link>
              </Box>
              <Flex gap="2" mt="4">
                <Button variant="secondary" onPress={() => navigate('/catalog-health')}>
                  Back to Catalog Health
                </Button>
              </Flex>
            </Box>
          ) : (
            <>
              <Flex direction="column" gap="3" mt="4">
                <TextField
                  label="Name"
                  value={name}
                  onChange={setName}
                  placeholder={projectName}
                  isRequired
                />

                <TextField
                  label="Description"
                  value={description}
                  onChange={setDescription}
                  placeholder="Short description of this component"
                />

                <Grid.Root columns={{ initial: '1', md: '2' }} gap="3">
                  <Select
                    label="Type"
                    options={typeOptions}
                    selectedKey={type}
                    onSelectionChange={key => setType(key as string)}
                    isRequired
                  />
                  <Select
                    label="Lifecycle"
                    options={lifecycleOptions}
                    selectedKey={lifecycle}
                    onSelectionChange={key => setLifecycle(key as string)}
                    isRequired
                  />
                </Grid.Root>

                <Grid.Root columns={{ initial: '1', md: '2' }} gap="3">
                  <div>
                    <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
                      Owner <span style={{ fontWeight: 400, color: 'var(--bui-fg-secondary, rgba(255,255,255,0.5))' }}>(Required)</span>
                    </Text>
                    <div className="gcid-autocomplete">
                      <input
                        ref={ownerInputRef}
                        className="gcid-input"
                        value={owner}
                        onChange={e => {
                          setOwner(e.target.value);
                          setShowOwnerSuggestions(true);
                          setOwnerHighlightIndex(-1);
                        }}
                        onFocus={() => setShowOwnerSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowOwnerSuggestions(false), 150)}
                        onKeyDown={e => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setOwnerHighlightIndex(prev => Math.min(prev + 1, filteredOwnerSuggestions.length - 1));
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setOwnerHighlightIndex(prev => Math.max(prev - 1, -1));
                          } else if (e.key === 'Enter') {
                            e.preventDefault();
                            if (ownerHighlightIndex >= 0 && ownerHighlightIndex < filteredOwnerSuggestions.length) {
                              setOwner(filteredOwnerSuggestions[ownerHighlightIndex]);
                              setShowOwnerSuggestions(false);
                              setOwnerHighlightIndex(-1);
                            }
                          } else if (e.key === 'Escape') {
                            setShowOwnerSuggestions(false);
                          }
                        }}
                        placeholder="Search existing owner or type new"
                      />
                      {showOwnerSuggestions && filteredOwnerSuggestions.length > 0 && (
                        <div className="gcid-suggestions" ref={ownerSuggestionsRef}>
                          {filteredOwnerSuggestions.slice(0, 10).map((s, i) => (
                            <div
                              key={s}
                              className={`gcid-suggestion-item${i === ownerHighlightIndex ? ' gcid-suggestion-active' : ''}`}
                              onMouseDown={() => {
                                setOwner(s);
                                setShowOwnerSuggestions(false);
                                setOwnerHighlightIndex(-1);
                              }}
                            >
                              <Flex align="center" gap="2" style={{ flex: 1, minWidth: 0 }}>
                                <span className={`gcid-owner-kind ${s.startsWith('user:') ? 'gcid-owner-kind-user' : 'gcid-owner-kind-group'}`}>
                                  {s.startsWith('user:') ? 'User' : 'Group'}
                                </span>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                              </Flex>
                              <span className="gcid-suggestion-count">{catalogCounts.owners.get(s) ?? 0}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <Select
                    label="Target Branch"
                    options={branchOptions}
                    selectedKey={targetBranch}
                    onSelectionChange={key => setTargetBranch(key as string)}
                  />
                </Grid.Root>

                <div>
                  <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
                    Tags <span style={{ fontWeight: 400, color: 'var(--bui-fg-secondary, rgba(255,255,255,0.5))' }}>(Required)</span>
                  </Text>
                  {tags.length > 0 && (
                    <Flex gap="1" mb="2" style={{ flexWrap: 'wrap' }}>
                      {tags.map(tag => (
                        <span key={tag} className="gcid-tag">
                          {tag}
                          <button
                            className="gcid-tag-remove"
                            onClick={() => setTags(prev => prev.filter(t => t !== tag))}
                          >
                            &times;
                          </button>
                        </span>
                      ))}
                    </Flex>
                  )}
                  <div className="gcid-tag-autocomplete">
                    <input
                      ref={tagInputRef}
                      className="gcid-input"
                      value={tagInput}
                      onChange={e => {
                        setTagInput(e.target.value);
                        setShowSuggestions(true);
                        setHighlightIndex(-1);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      onKeyDown={e => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setHighlightIndex(prev => Math.min(prev + 1, filteredSuggestions.length - 1));
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setHighlightIndex(prev => Math.max(prev - 1, -1));
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          if (highlightIndex >= 0 && highlightIndex < filteredSuggestions.length) {
                            addTag(filteredSuggestions[highlightIndex]);
                          } else {
                            addTag(tagInput);
                          }
                        } else if (e.key === 'Escape') {
                          setShowSuggestions(false);
                        }
                      }}
                      placeholder="Search existing tags or type new"
                    />
                    {showSuggestions && filteredSuggestions.length > 0 && (
                      <div className="gcid-suggestions" ref={suggestionsRef}>
                        {filteredSuggestions.slice(0, 10).map((s, i) => (
                          <div
                            key={s}
                            className={`gcid-suggestion-item${i === highlightIndex ? ' gcid-suggestion-active' : ''}`}
                            onMouseDown={() => addTag(s)}
                          >
                            <span>{s}</span>
                            <span className="gcid-suggestion-count">{catalogCounts.tags.get(s) ?? 0}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* YAML Preview */}
                <Box>
                  <Text variant="body-small" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
                    Preview
                  </Text>
                  <div className="gcid-preview-wrapper">
                    <button
                      className="gcid-copy-btn"
                      onClick={() => {
                        navigator.clipboard.writeText(preview).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        });
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <pre className="gcid-preview">{preview.split('\n').map((line, i) => (
                      <span key={i} className="gcid-preview-line" data-line={i + 1}>{highlightYamlLine(line)}{'\n'}</span>
                    ))}</pre>
                  </div>
                </Box>
              </Flex>

              {error && (
                <Box mt="3">
                  <Alert status="danger" title={error} />
                </Box>
              )}

              <Flex gap="2" justify="end" mt="4">
                <Button variant="secondary" onPress={() => navigate('/catalog-health')} isDisabled={submitting}>
                  Cancel
                </Button>
                <Button variant="primary" onPress={handleSubmit} isDisabled={submitting || !name.trim() || !type || !lifecycle || !owner.trim() || tags.length === 0}>
                  {submitting ? 'Submitting...' : 'Create MR'}
                </Button>
              </Flex>
            </>
          )}
        </Box>
      </Container>
    </>
  );
};
