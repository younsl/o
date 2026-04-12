import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Flex, Link, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useAsync } from 'react-use';
import { catalogHealthApiRef } from '../../api';
import { GitlabProject } from '../../api/types';
import './GenerateCatalogInfoDialog.css';

interface GenerateCatalogInfoDialogProps {
  project: GitlabProject;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}

const COMPONENT_TYPES = ['service', 'website', 'library', 'documentation', 'other'];
const LIFECYCLES = ['production', 'experimental', 'deprecated'];

export const GenerateCatalogInfoDialog = ({
  project,
  open,
  onClose,
  onSubmitted,
}: GenerateCatalogInfoDialogProps) => {
  const api = useApi(catalogHealthApiRef);
  const catalogApi = useApi(catalogApiRef);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('service');
  const [lifecycle, setLifecycle] = useState('production');
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mrUrl, setMrUrl] = useState<string | null>(null);

  const { value: existingTags = [] } = useAsync(async () => {
    const { items } = await catalogApi.getEntities({
      filter: { kind: 'Component' },
      fields: ['metadata.tags'],
    });
    const tagSet = new Set<string>();
    for (const entity of items) {
      const t = (entity.metadata as any).tags;
      if (Array.isArray(t)) t.forEach((tag: string) => tagSet.add(tag));
    }
    return Array.from(tagSet).sort();
  }, [catalogApi]);

  const filteredSuggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    if (!q) return existingTags.filter(t => !tags.includes(t));
    return existingTags.filter(t => t.includes(q) && !tags.includes(t));
  }, [tagInput, existingTags, tags]);

  useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription('');
      setType('service');
      setLifecycle('production');
      setOwner('');
      setTags([]);
      setTagInput('');
      setError(null);
      setMrUrl(null);
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open, project.name]);

  const preview = useMemo(() => {
    const lines = [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      `  name: ${name || project.name}`,
      description ? `  description: ${description}` : null,
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
  }, [name, description, type, lifecycle, owner, tags, project.name]);

  if (!open) return null;

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
        projectId: project.id,
        name: name || project.name,
        description,
        type,
        lifecycle,
        owner: owner || 'unknown',
        tags,
      });
      setMrUrl(result.mergeRequestUrl);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="gcid-overlay" onClick={onClose}>
      <div className="gcid-dialog" onClick={e => e.stopPropagation()}>
        <Text as="h3" variant="body-large" weight="bold">
          Generate catalog-info.yaml
        </Text>
        <Box mt="1">
          <Text variant="body-small" color="secondary">
            {project.pathWithNamespace}
          </Text>
        </Box>

        {mrUrl ? (
          <Box mt="4">
            <Alert status="success" title="Merge Request created" />
            <Box mt="3">
              <Link href={mrUrl} target="_blank" rel="noopener noreferrer">
                <Text variant="body-small">Open Merge Request</Text>
              </Link>
            </Box>
            <Flex justify="end" mt="4">
              <Button variant="primary" onPress={onClose}>Close</Button>
            </Flex>
          </Box>
        ) : (
          <>
            <Flex direction="column" gap="3" mt="4">
              <label className="gcid-label">
                <Text variant="body-small" weight="bold">Name <span className="gcid-required">*</span></Text>
                <input
                  className="gcid-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={project.name}
                />
              </label>

              <label className="gcid-label">
                <Text variant="body-small" weight="bold">Description</Text>
                <input
                  className="gcid-input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Short description of this component"
                />
              </label>

              <Flex gap="3">
                <label className="gcid-label" style={{ flex: 1 }}>
                  <Text variant="body-small" weight="bold">Type <span className="gcid-required">*</span></Text>
                  <select className="gcid-select" value={type} onChange={e => setType(e.target.value)}>
                    {COMPONENT_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="gcid-label" style={{ flex: 1 }}>
                  <Text variant="body-small" weight="bold">Lifecycle <span className="gcid-required">*</span></Text>
                  <select className="gcid-select" value={lifecycle} onChange={e => setLifecycle(e.target.value)}>
                    {LIFECYCLES.map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </label>
              </Flex>

              <label className="gcid-label">
                <Text variant="body-small" weight="bold">Owner <span className="gcid-required">*</span></Text>
                <input
                  className="gcid-input"
                  value={owner}
                  onChange={e => setOwner(e.target.value)}
                  placeholder="group:default/my-team"
                />
              </label>

              <div className="gcid-label">
                <Text variant="body-small" weight="bold">Tags</Text>
                <Flex gap="1" style={{ flexWrap: 'wrap' }}>
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
                          {s}
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
                <pre className="gcid-preview">{preview}</pre>
              </Box>
            </Flex>

            {error && (
              <Box mt="3">
                <Alert status="danger" title={error} />
              </Box>
            )}

            <Flex gap="2" justify="end" mt="4">
              <Button variant="secondary" onPress={onClose} isDisabled={submitting}>
                Cancel
              </Button>
              <Button variant="primary" onPress={handleSubmit} isDisabled={submitting || !name.trim() || !type || !lifecycle || !owner.trim()}>
                {submitting ? 'Submitting...' : 'Create MR'}
              </Button>
            </Flex>
          </>
        )}
      </div>
    </div>
  );
};
