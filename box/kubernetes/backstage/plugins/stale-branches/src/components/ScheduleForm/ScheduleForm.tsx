import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PasswordField,
  PluginHeader,
  Select,
  Switch,
  Tag,
  TagGroup,
  Text,
  TextAreaField,
  TextField,
} from '@backstage/ui';
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiBrush3Line,
} from '@remixicon/react';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { staleBranchesPlugin } from '../../plugin';
import { staleBranchesApiRef } from '../../api';
import { CronPreview } from '../../api/types';
import { rootRouteRef } from '../../routes';
import { SlackPreview } from './SlackPreview';
import { formatRunTime, formatUntil } from '../../utils/format';
import './ScheduleForm.css';

/** The cron preview follows typing, and costs nothing but a parse. */
const CRON_DEBOUNCE_MS = 400;

/** Weekday mornings, the cadence the shell job this plugin replaces used. */
const DEFAULT_CRON = '0 10 * * 1-5';

const DEFAULTS = {
  thresholdDays: '14',
  ignoredBranches: [
    'master',
    'main',
    'develop',
    'devel',
    'master-sandbox',
    'master-stage',
  ].join('\n'),
  ignoreProtected: true,
  enabled: true,
};

/**
 * The IANA zone list the browser already carries, so no table has to be
 * shipped or kept current. Empty on a browser without the API, which the
 * timezone field falls back to free text for.
 */
const TIMEZONES: string[] = (() => {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  try {
    return supported ? supported('timeZone') : [];
  } catch {
    return [];
  }
})();

const TIMEZONE_SET = new Set(TIMEZONES);

/** The browser's own zone is the one a new schedule most likely wants. */
const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * A zone name alone does not say whether it is the right one, so the current
 * offset rides along in the label. It follows DST, being read off today.
 */
const offsetLabel = (zone: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const offset = parts.find(part => part.type === 'timeZoneName')?.value;
    return offset ? `${zone} (${offset})` : zone;
  } catch {
    return zone;
  }
};

/** Comma or newline separated, so a list can be pasted from anywhere. */
const parseList = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);

/** Label and rationale on the left, switch on the right, one tap target. */
const ToggleRow = ({
  title,
  description,
  isSelected,
  onChange,
}: {
  title: string;
  description: string;
  isSelected: boolean;
  onChange: (next: boolean) => void;
}) => (
  <label className="sb-toggle-row">
    <span className="sb-toggle-copy">
      <Text as="span" variant="body-small" weight="bold">
        {title}
      </Text>
      <Text as="span" variant="body-x-small" color="secondary">
        {description}
      </Text>
    </span>
    <Switch
      aria-label={title}
      isSelected={isSelected}
      onChange={onChange}
      className="sb-switch"
    />
  </label>
);

export const ScheduleForm = ({ mode }: { mode: 'create' | 'edit' }) => {
  const api = useApi(staleBranchesApiRef);
  const navigate = useNavigate();
  const rootPath = useRouteRef(rootRouteRef)();
  const { id } = useParams();

  const { value: adminStatus, loading: adminLoading } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const { value: existing, loading: existingLoading } = useAsyncRetry(async () => {
    if (mode !== 'edit' || !id) return undefined;
    return api.getSchedule(id);
  }, [mode, id]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projects, setProjects] = useState('');
  const [thresholdDays, setThresholdDays] = useState(DEFAULTS.thresholdDays);
  const [ignoredBranches, setIgnoredBranches] = useState(
    DEFAULTS.ignoredBranches,
  );
  const [ignoreProtected, setIgnoreProtected] = useState(
    DEFAULTS.ignoreProtected,
  );
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookDescription, setWebhookDescription] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [timezone, setTimezone] = useState(localTimezone);
  const [cronPreview, setCronPreview] = useState<CronPreview | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    text: string;
    sample: boolean;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? '');
    setProjects(existing.projectNames.join('\n'));
    setThresholdDays(String(existing.thresholdDays));
    setIgnoredBranches(existing.ignoredBranches.join('\n'));
    setIgnoreProtected(existing.ignoreProtected);
    setWebhookDescription(existing.webhookDescription ?? '');
    setWebhookEnabled(existing.webhookEnabled);
    setEnabled(existing.enabled);
    setCron(existing.cron);
    setTimezone(existing.timezone);
    // Editing opens the extra fields when any of them was changed from the
    // default, so a saved value is never hidden behind a collapsed section.
    setAdvancedOpen(
      String(existing.thresholdDays) !== DEFAULTS.thresholdDays ||
        existing.ignoredBranches.join('\n') !== DEFAULTS.ignoredBranches ||
        existing.ignoreProtected !== DEFAULTS.ignoreProtected ||
        existing.enabled !== DEFAULTS.enabled ||
        existing.webhookEnabled ||
        !!existing.webhookUrlMasked ||
        !!existing.webhookDescription,
    );
  }, [existing]);

  // 400-odd formatters, so build the labels once rather than per keystroke.
  const zoneOptions = useMemo(
    () => TIMEZONES.map(zone => ({ id: zone, label: offsetLabel(zone) })),
    [],
  );

  // A stored value can be a retired alias such as Asia/Calcutta, which the
  // browser list no longer carries. Keep it as an option, otherwise opening
  // the form would silently drop the saved zone.
  const timezoneOptions = useMemo(() => {
    if (!timezone || TIMEZONE_SET.has(timezone)) return zoneOptions;
    return [{ id: timezone, label: offsetLabel(timezone) }, ...zoneOptions];
  }, [zoneOptions, timezone]);

  // Resolved on the backend, which owns the same parser the scheduler runs on.
  const cronSeq = React.useRef(0);
  useEffect(() => {
    const expression = cron.trim();
    if (!expression || !isAdmin) {
      setCronPreview(null);
      return undefined;
    }
    const seq = ++cronSeq.current;
    const timer = setTimeout(async () => {
      try {
        const result = await api.previewCron(expression, timezone);
        if (seq !== cronSeq.current) return;
        setCronPreview(result);
      } catch {
        if (seq !== cronSeq.current) return;
        // A rejected preview is a rejected expression, which the inline message
        // below already says. Nothing to raise to the form banner.
        setCronPreview({
          valid: false,
          timezone,
          nextRuns: [],
          error: 'Not a valid cron expression',
        });
      }
    }, CRON_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, cron, timezone, isAdmin]);

  const handlePreview = useCallback(async () => {
    if (!id) return;
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await api.previewNotify(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  }, [api, id]);

  const projectCount = parseList(projects).length;
  const daysValue = Number(thresholdDays);
  const daysError =
    !Number.isInteger(daysValue) || daysValue < 1 || daysValue > 3650
      ? 'Enter a whole number of days from 1 to 3650'
      : null;
  const cronInvalid = cronPreview !== null && !cronPreview.valid;
  const projectPhrase = `${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`;
  // An unusable threshold leaves the sentence readable rather than printing a
  // number the field has already rejected.
  const thresholdPhrase = daysError
    ? 'the threshold'
    : `${daysValue} ${daysValue === 1 ? 'day' : 'days'}`;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        description: description.trim() || null,
        projectNames: parseList(projects),
        thresholdDays: Number(thresholdDays),
        ignoredBranches: parseList(ignoredBranches),
        ignoreProtected,
        webhookUrl: webhookUrl.trim() || undefined,
        webhookDescription: webhookDescription.trim() || null,
        webhookEnabled,
        cron: cron.trim(),
        timezone,
        enabled,
      };
      const saved =
        mode === 'edit' && id
          ? await api.updateSchedule(id, input)
          : await api.createSchedule(input);
      navigate(`${rootPath}/schedules/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [
    api,
    mode,
    id,
    name,
    description,
    projects,
    thresholdDays,
    ignoredBranches,
    ignoreProtected,
    webhookUrl,
    webhookDescription,
    webhookEnabled,
    cron,
    timezone,
    enabled,
    navigate,
    rootPath,
  ]);

  const header = (
    <PluginHeader
      icon={<RiBrush3Line />}
      title={mode === 'edit' ? 'Edit schedule' : 'New schedule'}
      customActions={
        <TagGroup>
          <Tag id="plugin-id" size="small">
            {staleBranchesPlugin.getId()}
          </Tag>
        </TagGroup>
      }
    />
  );

  if (adminLoading || (mode === 'edit' && existingLoading)) {
    return (
      <>
        {header}
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        {header}
        <Container my="4">
          <Alert
            status="warning"
            title="Only administrators can change schedules"
            description="Ask your DevOps team to register or edit a scan."
          />
        </Container>
      </>
    );
  }

  const saveBlocked =
    saving || !name.trim() || !!daysError || projectCount === 0 || cronInvalid;

  return (
    <>
      {header}
      <Container my="4">
        <Box className="sb-form">
          {/* Three fields and a button. Everything with a working default sits
              under Advanced, so the shortest path to a schedule is the one on
              screen. */}
          <TextField
            label="Name"
            description="Shown in the schedule list and in the title of every Slack report"
            placeholder="Payments weekly cleanup"
            value={name}
            onChange={setName}
          />

          {/* Beside the name, not under Advanced: the two are written in one
              breath, and a list of schedules called "Payments" and "Payments
              2" is what happens when the second line is somewhere else. */}
          <TextField
            label="Description"
            description="Optional, shown under the name in the schedule list"
            placeholder="pay and money, weekday mornings"
            value={description}
            onChange={setDescription}
          />

          <TextAreaField
            label="Projects"
            description="One per line. group/name is safer than a bare name, which matches every project called that"
            rows={4}
            placeholder={'payments/checkout-api\nplatform/notification-worker'}
            value={projects}
            onChange={setProjects}
          />

          <div className="sb-field">
            <Text as="div" variant="body-small" weight="bold">
              Runs
            </Text>
            {/* Bottom aligned, and both fields carry a description. One field
                with a hint under its label and one without pushed its input a
                line lower than its neighbour; matching the descriptions fixes
                the common case, and aligning on the bottom edge keeps the two
                inputs on one line even when a description wraps at a width
                neither of them chose. */}
            <Flex gap="2" align="end" style={{ flexWrap: 'wrap' }}>
              <Box style={{ flex: '1 1 200px', minWidth: 180 }}>
                <TextField
                  label="Cron"
                  description="minute hour day-of-month month day-of-week"
                  placeholder={DEFAULT_CRON}
                  value={cron}
                  onChange={setCron}
                />
              </Box>
              <Box style={{ flex: '1 1 220px', minWidth: 180 }}>
                {/* Picked, not typed: the zone set is closed, and a typo here
                    only surfaces later as a run at the wrong hour. */}
                {timezoneOptions.length > 0 ? (
                  <Select
                    label="Timezone"
                    description="the zone the cron is read in"
                    options={timezoneOptions}
                    selectedKey={timezone}
                    onSelectionChange={key => setTimezone(key as string)}
                    search={{ placeholder: 'Search zones' }}
                  />
                ) : (
                  <TextField
                    label="Timezone"
                    description="the zone the cron is read in"
                    placeholder="Asia/Seoul"
                    value={timezone}
                    onChange={setTimezone}
                  />
                )}
              </Box>
            </Flex>

            {/* The expression is resolved as it is typed, so a wrong cron is
                caught here rather than by a run that never fires. Three fire
                times rather than one: a single timestamp does not say whether
                the expression repeats the way its author meant. */}
            <div className="sb-cron-preview" aria-live="polite">
              {cronPreview && !cronPreview.valid && (
                <Text variant="body-x-small" color="danger">
                  {cronPreview.error}
                </Text>
              )}
              {cronPreview?.valid && (
                <Flex direction="column" gap="0.5">
                  <Text variant="body-x-small" color="secondary">
                    Next runs in {cronPreview.timezone}
                  </Text>
                  {/* Rendered in the schedule's own zone, so the weekday named
                      here is the weekday the cron was written against rather
                      than whatever day that instant falls on for the reader.
                      The relative part stays reader-relative, since "in 5d" is
                      the same span everywhere. */}
                  {cronPreview.nextRuns.map((run, index) => (
                    <Text
                      key={run}
                      variant="body-x-small"
                      color={index === 0 ? 'success' : 'secondary'}
                    >
                      {formatRunTime(run, cronPreview.timezone)} ·{' '}
                      {formatUntil(run)}
                    </Text>
                  ))}
                </Flex>
              )}
            </div>
          </div>

          {/* What the form adds up to, in the words the schedule page will use.
              It moves as the fields do, so the effect of a change is visible
              without saving to find out.

              Written as a sentence rather than as a formula. "14+ days" needs
              the reader to work out which side of the threshold counts, and
              says nothing about what the number is measured from; "last commit
              is older than 14 days" names both. */}
          <div className="sb-summary">
            <Text variant="body-x-small" color="secondary">
              {projectCount === 0 ? (
                <>
                  Add a project to scan. Every branch whose last commit is older
                  than <strong>{thresholdPhrase}</strong> will be reported.
                </>
              ) : (
                <>
                  Scans <strong>{projectPhrase}</strong> and reports every branch
                  whose last commit is older than{' '}
                  <strong>{thresholdPhrase}</strong>
                  {webhookEnabled ? (
                    <>
                      , posting the result to{' '}
                      <strong>{webhookDescription.trim() || 'Slack'}</strong>
                    </>
                  ) : null}
                  .
                </>
              )}
              {enabled ? '' : ' Paused, so nothing fires until it is resumed.'}
            </Text>
          </div>

          <button
            type="button"
            className="sb-disclosure"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(open => !open)}
          >
            {advancedOpen ? (
              <RiArrowDownSLine size={15} aria-hidden />
            ) : (
              <RiArrowRightSLine size={15} aria-hidden />
            )}
            Advanced
            {!advancedOpen && (
              <span className="sb-disclosure-hint">
                threshold, ignored branches, Slack, pause
              </span>
            )}
          </button>

          {advancedOpen && (
            <div className="sb-advanced">
              <Flex gap="2" style={{ flexWrap: 'wrap' }}>
                <Box style={{ flex: '0 0 180px' }}>
                  <TextField
                    label="Threshold in days"
                    description="Time since the last push"
                    placeholder="14"
                    value={thresholdDays}
                    onChange={setThresholdDays}
                  />
                </Box>
                <Box style={{ flex: '1 1 260px', minWidth: 220 }}>
                  <TextAreaField
                    label="Never stale"
                    description="One branch name per line. The default branch is always skipped"
                    rows={3}
                    placeholder={'master\ndevelop'}
                    value={ignoredBranches}
                    onChange={setIgnoredBranches}
                  />
                </Box>
              </Flex>
              {daysError && (
                <Text variant="body-x-small" color="danger">
                  {daysError}
                </Text>
              )}

              <ToggleRow
                title="Skip protected branches"
                description="Extends the default-branch skip to every branch GitLab marks protected"
                isSelected={ignoreProtected}
                onChange={setIgnoreProtected}
              />

              <PasswordField
                label="Slack webhook"
                description={
                  existing?.webhookUrlMasked
                    ? `Currently ${existing.webhookUrlMasked}, leave empty to keep it`
                    : 'One grouped message per run, listing only branches not yet reported at their current commit'
                }
                placeholder="https://hooks.slack.com/services/…"
                value={webhookUrl}
                onChange={setWebhookUrl}
              />
              {/* The URL is stored masked, and every Slack webhook masks to
                  the same origin, so the label is the only thing that says
                  which channel a report lands in. */}
              <TextField
                label="Webhook description"
                description="Where the report lands, for example #devops-alerts"
                placeholder="#devops-alerts"
                value={webhookDescription}
                onChange={setWebhookDescription}
              />
              <ToggleRow
                title="Post the report to Slack"
                description="Sent after every run, and available as a manual send"
                isSelected={webhookEnabled}
                onChange={setWebhookEnabled}
              />
              {mode === 'edit' && (
                <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
                  <Button
                    variant="secondary"
                    onPress={handlePreview}
                    isDisabled={previewLoading}
                  >
                    {previewLoading ? 'Loading…' : 'Preview Slack message'}
                  </Button>
                  {preview?.sample && (
                    <Text variant="body-x-small" color="secondary">
                      No successful run yet, so the preview uses example data
                    </Text>
                  )}
                </Flex>
              )}
              {preview && (
                <SlackPreview text={preview.text} sample={preview.sample} />
              )}

              <ToggleRow
                title="Active"
                description="Paused keeps the schedule and its history, but nothing fires until it is resumed"
                isSelected={enabled}
                onChange={setEnabled}
              />
            </div>
          )}

          {error && <Alert status="danger" title={error} />}

          {/* Bottom right, and the primary last: the eye leaves the form at
              its end, which is where the action that commits it belongs. The
              reason the button is blocked stays on the left, next to the fields
              it is talking about rather than under the button. */}
          <Flex
            gap="2"
            align="center"
            justify="between"
            className="sb-form-actions"
          >
            {/* One reason at a time, in field order, so the button never just
                sits disabled without saying what is missing. */}
            <Text variant="body-x-small" color="secondary">
              {saveBlocked && !saving
                ? !name.trim()
                  ? 'Give the schedule a name'
                  : projectCount === 0
                    ? 'Add at least one project'
                    : daysError
                      ? 'Fix the threshold under Advanced'
                      : 'Fix the cron expression'
                : ''}
            </Text>
            <Flex gap="2" align="center">
              <Button
                variant="secondary"
                onPress={() =>
                  navigate(
                    mode === 'edit' && id
                      ? `${rootPath}/schedules/${id}`
                      : rootPath,
                  )
                }
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onPress={handleSave}
                isDisabled={saveBlocked}
              >
                {saving
                  ? 'Saving…'
                  : mode === 'edit'
                    ? 'Save changes'
                    : 'Create schedule'}
              </Button>
            </Flex>
          </Flex>
        </Box>
      </Container>
    </>
  );
};
