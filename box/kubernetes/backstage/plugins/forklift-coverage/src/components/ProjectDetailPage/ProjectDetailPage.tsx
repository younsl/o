import React, { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  Link,
  PluginHeader,
  Switch,
  Tag,
  TagGroup,
  Text,
} from '@backstage/ui';
import { RiStackLine } from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { forkliftCoveragePlugin } from '../../plugin';
import { forkliftCoverageApiRef } from '../../api';
import { AppliedState, PipelineFile } from '../../api/types';
import { highlightGitlabCiLine } from '../../utils/gitlabCiHighlight';
import { formatRelative } from '../../utils/relativeTime';
import './ProjectDetailPage.css';

const APPLIED_STYLE: Record<
  AppliedState | 'skipped' | 'unscanned',
  { bg: string; border: string; fg: string; label: string }
> = {
  yes: {
    bg: 'rgba(34, 197, 94, 0.15)',
    border: 'rgba(34, 197, 94, 0.5)',
    fg: '#22c55e',
    label: 'APPLIED',
  },
  partial: {
    bg: 'rgba(245, 158, 11, 0.15)',
    border: 'rgba(245, 158, 11, 0.5)',
    fg: '#f59e0b',
    label: 'PARTIAL',
  },
  no: {
    bg: 'rgba(239, 68, 68, 0.15)',
    border: 'rgba(239, 68, 68, 0.5)',
    fg: '#ef4444',
    label: 'NOT APPLIED',
  },
  error: {
    bg: 'rgba(156, 163, 175, 0.15)',
    border: 'rgba(156, 163, 175, 0.5)',
    fg: '#9ca3af',
    label: 'SCAN ERROR',
  },
  skipped: {
    bg: 'rgba(156, 163, 175, 0.15)',
    border: 'rgba(156, 163, 175, 0.5)',
    fg: '#9ca3af',
    label: 'NO CI',
  },
  unscanned: {
    bg: 'rgba(156, 163, 175, 0.15)',
    border: 'rgba(156, 163, 175, 0.5)',
    fg: '#9ca3af',
    label: 'NOT SCANNED YET',
  },
};

const ExternalLinkIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <Flex direction="column" gap="1" style={{ minWidth: 160 }}>
    <Text as="div" variant="body-x-small" color="secondary">
      {label}
    </Text>
    <Text as="div" variant="body-small" weight="bold">
      {children}
    </Text>
  </Flex>
);

/**
 * Highlights the lines that reference Forklift so a reviewer can see the
 * wiring without reading the whole file.
 */
const PipelineFileView = ({
  file,
  forkliftHost,
}: {
  file: PipelineFile;
  forkliftHost: string | null;
}) => {
  const lines = file.content.split('\n');
  return (
    <Box mt="3">
      <Flex align="center" gap="2" mb="1" style={{ flexWrap: 'wrap' }}>
        <Text variant="body-small" weight="bold">
          {file.path}
        </Text>
        {/* A bare Tag outside a TagGroup crashes react-aria's collection
            builder, so this badge is plain text. */}
        {file.matchesForklift && (
          <Text variant="body-x-small" color="success">
            references Forklift
          </Text>
        )}
        {file.truncated && (
          <Text variant="body-x-small" color="secondary">
            truncated
          </Text>
        )}
      </Flex>
      <pre className="fc-pipeline-view">
        {lines.map((line, index) => {
          const highlighted =
            !!forkliftHost &&
            (line.includes(forkliftHost) || /FORKLIFT_[A-Z0-9_]*TOKEN/.test(line));
          return (
            <div
              key={`${file.path}-${index}`}
              className={
                highlighted ? 'fc-pipeline-line fc-pipeline-hit' : 'fc-pipeline-line'
              }
            >
              <span className="fc-pipeline-lineno">{index + 1}</span>
              <span className="fc-pipeline-code">
                {line ? highlightGitlabCiLine(line, `${file.path}-${index}`) : ' '}
              </span>
            </div>
          );
        })}
      </pre>
    </Box>
  );
};

export const ProjectDetailPage = () => {
  const api = useApi(forkliftCoverageApiRef);
  const navigate = useNavigate();
  const { projectPath } = useParams<{ projectPath: string }>();
  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const { value: adminStatus } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const {
    value: project,
    loading,
    error,
    retry: refetchProject,
  } = useAsyncRetry(async () => api.getProject(decodedPath), [decodedPath]);

  const [togglingScope, setTogglingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const handleScopeToggle = useCallback(
    async (included: boolean) => {
      setTogglingScope(true);
      setScopeError(null);
      try {
        await api.setExclusion(decodedPath, !included);
        refetchProject();
      } catch (err) {
        setScopeError(
          err instanceof Error ? err.message : 'Could not change the scope',
        );
      } finally {
        setTogglingScope(false);
      }
    },
    [api, decodedPath, refetchProject],
  );

  const { value: coverage } = useAsyncRetry(async () => api.getCoverage(), []);

  // Fetched per visit rather than during the scan, so it stays current without
  // adding a request per project to every scan.
  const { value: lastCommit, loading: lastCommitLoading } = useAsyncRetry(
    async () => (decodedPath ? api.getLastCommit(decodedPath) : null),
    [decodedPath],
  );

  const [showPipeline, setShowPipeline] = useState(false);
  const {
    value: pipeline,
    loading: pipelineLoading,
    error: pipelineError,
  } = useAsyncRetry(async () => {
    if (!showPipeline || !isAdmin || !decodedPath) return undefined;
    return api.getPipeline(decodedPath);
  }, [showPipeline, isAdmin, decodedPath]);

  const header = (
    <PluginHeader
      icon={<RiStackLine />}
      title="Forklift Coverage"
      customActions={
        <TagGroup>
          <Tag id="plugin-id" size="small">
            {forkliftCoveragePlugin.getId()}
          </Tag>
        </TagGroup>
      }
    />
  );

  if (loading) {
    return (
      <>
        {header}
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (error || !project) {
    return (
      <>
        {header}
        <Container my="4">
          <Alert
            status="warning"
            title="Project not found"
            description="This project was not part of the last scan. Run a scan and try again."
          />
          <Box mt="3">
            <Button variant="secondary" onPress={() => navigate('..')}>
              Back to coverage
            </Button>
          </Box>
        </Container>
      </>
    );
  }

  // A project with no verdict must not be shown as if it had one.
  const style = !project.scanned
    ? APPLIED_STYLE.unscanned
    : APPLIED_STYLE[project.skipped ? 'skipped' : project.applied];
  // A topic or the config list owns those opt-outs, so the page must not
  // pretend it can undo them.
  const byTopicOrConfig =
    !!project.excludeReason && project.excludeReason !== 'manual';

  return (
    <>
      {header}
      <Container my="4">
        {/* The repository name is the page title and the way into GitLab, so
            no separate link is needed alongside it. */}
        <Flex justify="between" align="start" gap="3" style={{ flexWrap: 'wrap' }}>
          <Box>
            <Link
              href={project.webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="fc-detail-title"
            >
              {project.name}
              <ExternalLinkIcon />
            </Link>
            <Text as="div" variant="body-x-small" color="secondary">
              {project.group || '(root)'}
            </Text>
            {project.topics.length > 0 && (
              <Box mt="2">
                <TagGroup>
                  {project.topics.map(topic => (
                    <Tag key={topic}>{topic}</Tag>
                  ))}
                </TagGroup>
              </Box>
            )}
          </Box>
          <Button variant="secondary" onPress={() => navigate('..')}>
            Back to coverage
          </Button>
        </Flex>

        <Box
          mt="4"
          p="3"
          style={{
            background: style.bg,
            border: `1px solid ${style.border}`,
            borderRadius: 6,
          }}
        >
          <Flex direction="column" gap="1">
            <Text as="div" variant="title-medium" weight="bold" style={{ color: style.fg }}>
              {style.label}
            </Text>
            <Text as="div" variant="body-x-small" color="secondary">
              {project.scanned
                ? 'A project counts as applied when its pipeline and a registry file both point at Forklift.'
                : 'The last scan produced no verdict for this project. It gets one on the next scan.'}
            </Text>
          </Flex>
        </Box>

        {isAdmin && (
          <Box mt="4">
            {/* Excluding drops the project from the coverage number straight
                away. Re-including cannot invent a verdict, so it only returns
                to the table after the next scan. */}
            <label className="fc-toggle-row">
              <span className="fc-toggle-copy">
                <Text as="span" variant="body-small" weight="bold">
                  Include in the scan
                </Text>
                <Text as="span" variant="body-x-small" color="secondary">
                  {byTopicOrConfig
                    ? `Excluded by ${project.excludeReason}, which is owned outside this page`
                    : project.excludeReason === 'manual'
                    ? 'Excluded here. Turning this on brings it back with the next scan'
                    : 'Counts toward coverage'}
                </Text>
              </span>
              <Switch
                aria-label="Include this project in the scan"
                className="fc-switch"
                isSelected={!project.excludeReason}
                isDisabled={byTopicOrConfig || togglingScope}
                onChange={handleScopeToggle}
              />
            </label>
            {scopeError && (
              <Box mt="2">
                <Alert status="danger" title={scopeError} />
              </Box>
            )}
          </Box>
        )}

        <Box
          mt="4"
          p="3"
          style={{
            border: '1px solid var(--bui-color-border-default)',
            borderRadius: 6,
          }}
        >
          <Text variant="body-medium" weight="bold">
            Verdict
          </Text>
          <Flex gap="4" mt="3" style={{ flexWrap: 'wrap' }}>
            <Field label="CI wired">{project.ciWired ? 'yes' : 'no'}</Field>
            <Field label="Registry pinned">
              {project.registryPinned ? 'yes' : 'no'}
            </Field>
            <Field label="Format">{project.format ?? '—'}</Field>
            <Field label="Branch">{project.branch ?? '—'}</Field>
            <Field label="On default branch">
              {project.onDefault === null ? '—' : project.onDefault ? 'yes' : 'no'}
            </Field>
            <Field label="Default branch">{project.defaultBranch ?? '—'}</Field>
            {/* The age leads because it is the part anybody acts on, and the
                exact timestamp follows because GitLab folds repository pushes
                and project record edits into this one field, which an age
                rounded to months would hide. */}
            <Field label="Last activity">
              {formatRelative(project.lastActivityAt)}{' '}
              <Text variant="body-x-small" color="secondary" weight="regular">
                ({new Date(project.lastActivityAt).toLocaleString()})
              </Text>
            </Field>
            <Field label="Last commit by">
              {lastCommitLoading ? '…' : lastCommit?.authorName ?? '—'}
            </Field>
          </Flex>
          {lastCommit && (
            <Box mt="3">
              <Text variant="body-x-small" color="secondary">
                {lastCommit.authorName} committed{' '}
                {lastCommit.webUrl ? (
                  <Link
                    href={lastCommit.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {lastCommit.shortId}
                  </Link>
                ) : (
                  lastCommit.shortId
                )}{' '}
                on {lastCommit.ref}, {new Date(lastCommit.committedAt).toLocaleString()}
                {' · '}
                {lastCommit.title}
              </Text>
            </Box>
          )}

          {project.note && (
            <Box mt="3">
              <Text variant="body-x-small" color="secondary">
                Note {project.note}
              </Text>
            </Box>
          )}
        </Box>

        <Box
          mt="4"
          p="3"
          style={{
            border: '1px solid var(--bui-color-border-default)',
            borderRadius: 6,
          }}
        >
          <Text variant="body-medium" weight="bold">
            Evidence
          </Text>
          <Box mt="2">
            {project.evidence.length === 0 ? (
              <Text variant="body-small" color="secondary">
                No file in this project references Forklift.
              </Text>
            ) : (
              <TagGroup>
                {project.evidence.map(path => (
                  <Tag key={path}>{path}</Tag>
                ))}
              </TagGroup>
            )}
          </Box>
        </Box>

        <Box
          mt="4"
          p="3"
          style={{
            border: '1px solid var(--bui-color-border-default)',
            borderRadius: 6,
          }}
        >
          <Flex justify="between" align="center" gap="2" style={{ flexWrap: 'wrap' }}>
            <Text variant="body-medium" weight="bold">
              Pipeline definition
            </Text>
            {isAdmin && (
              <Button
                variant="secondary"
                onPress={() => setShowPipeline(prev => !prev)}
              >
                {showPipeline ? 'Hide pipeline' : 'Show pipeline'}
              </Button>
            )}
          </Flex>

          {!isAdmin ? (
            <Box mt="2">
              <Text variant="body-small" color="secondary">
                Pipeline files are visible to Backstage administrators only.
              </Text>
            </Box>
          ) : (
            <>
              <Box mt="2">
                <Text variant="body-x-small" color="secondary">
                  Only GitLab CI files are fetched. Application source is never
                  read by this page.
                </Text>
              </Box>
              {showPipeline && pipelineLoading && (
                <Box mt="3">
                  <Text variant="body-small">Loading pipeline…</Text>
                </Box>
              )}
              {showPipeline && pipelineError && (
                <Box mt="3">
                  <Alert
                    status="danger"
                    title={
                      pipelineError instanceof Error
                        ? pipelineError.message
                        : 'Failed to load pipeline'
                    }
                  />
                </Box>
              )}
              {showPipeline && pipeline && (
                <>
                  <Box mt="3">
                    <Text variant="body-x-small" color="secondary">
                      ref {pipeline.ref}
                    </Text>
                  </Box>
                  {pipeline.files.length === 0 ? (
                    <Box mt="2">
                      <Text variant="body-small" color="secondary">
                        No GitLab CI file found on this ref.
                      </Text>
                    </Box>
                  ) : (
                    pipeline.files.map(file => (
                      <PipelineFileView
                        key={file.path}
                        file={file}
                        forkliftHost={coverage?.forkliftHost ?? null}
                      />
                    ))
                  )}
                </>
              )}
            </>
          )}
        </Box>
      </Container>
    </>
  );
};
