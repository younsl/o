import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Flex,
  PluginHeader,
  Select,
  Switch,
  Tag,
  TagGroup,
  Text,
  TextField,
} from '@backstage/ui';
import {
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiStackLine,
} from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { forkliftCoveragePlugin } from '../../plugin';
import { forkliftCoverageApiRef } from '../../api';
import { CoverageResponse, HostProbeResult } from '../../api/types';
import { SlackPreview } from './SlackPreview';
import './ConfigurationWizard.css';

/**
 * Weekday first, since a cron like '0 10 * * 1-5' is easiest to sanity check
 * against the day it lands on. Forced to en-US so the format stays stable
 * regardless of the browser locale.
 */
const formatNextRun = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** Long enough to not fire mid-word, short enough that nobody waits on it. */
const PROBE_DEBOUNCE_MS = 1000;

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

/**
 * Mirrors the backend host rule so an obviously wrong value is reported
 * without a round trip. The backend still validates on save.
 */
const localHostError = (raw: string): string | null => {
  const host = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host) return null;
  if (/[/@?#\s]/.test(host)) {
    return 'Enter a bare host such as forklift.example.com, with no scheme or path';
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(host)) {
    return 'Host is not a valid domain name';
  }
  return null;
};

/**
 * Mirrors the backend rule for a scan that leaves nothing to act on, so the
 * form can say whether the skip applies to the result already on screen.
 */
const isFullCoverage = (coverage: CoverageResponse): boolean =>
  coverage.target > 0 &&
  coverage.partial === 0 &&
  coverage.notApplied === 0 &&
  coverage.errored === 0;

/** Switch on the left, label and rationale after it, one tap target. */
const ToggleRow = ({
  title,
  description,
  isSelected,
  isDisabled,
  onChange,
}: {
  title: string;
  description: string;
  isSelected: boolean;
  isDisabled?: boolean;
  onChange: (next: boolean) => void;
}) => (
  <label className="fc-toggle-row">
    <Switch
      aria-label={title}
      isSelected={isSelected}
      isDisabled={isDisabled}
      onChange={onChange}
      className="fc-switch"
    />
    <span className="fc-toggle-copy">
      <Text as="span" variant="body-small" weight="bold">
        {title}
      </Text>
      <Text as="span" variant="body-x-small" color="secondary">
        {description}
      </Text>
    </span>
  </label>
);

const HEADER = (
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

export const ConfigurationWizard = ({
  onSaved,
}: {
  onSaved: () => void;
}) => {
  const api = useApi(forkliftCoverageApiRef);

  const { value: adminStatus, loading: adminLoading } = useAsyncRetry(
    async () => api.getAdminStatus(),
    [],
  );
  const isAdmin = adminStatus?.isAdmin ?? false;

  const { value: settings, loading: settingsLoading } = useAsyncRetry(async () => {
    if (!isAdmin) return undefined;
    return api.getSettings();
  }, [isAdmin]);

  const [host, setHost] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [skipWhenFullCoverage, setSkipWhenFullCoverage] = useState(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [scanCron, setScanCron] = useState('0 10 * * 1-5');
  const [timezone, setTimezone] = useState('UTC');
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    text: string;
    sample: boolean;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  /** Last saved value of the toggle, to spot unsaved webhook edits. */
  const [savedWebhookEnabled, setSavedWebhookEnabled] = useState(false);

  // Needed to know whether a scan result exists; the backend refuses to send
  // a report before the first scan.
  const { value: coverage, retry: refetchCoverage } = useAsyncRetry(async () => {
    if (!isAdmin) return undefined;
    return api.getCoverage();
  }, [isAdmin]);

  const scanning = coverage?.scanning ?? false;

  // A scan started elsewhere still blocks Send now here, so poll until it ends
  // rather than leaving the button stuck on a stale state.
  useEffect(() => {
    if (!scanning) return undefined;
    const id = setInterval(() => refetchCoverage(), 2_000);
    return () => clearInterval(id);
  }, [scanning, refetchCoverage]);

  useEffect(() => {
    if (!settings) return;
    setHost(settings.forkliftHost ?? '');
    setWebhookEnabled(settings.webhookEnabled);
    setSavedWebhookEnabled(settings.webhookEnabled);
    setSkipWhenFullCoverage(settings.webhookSkipWhenFullCoverage);
    setAutoScanEnabled(settings.schedule.autoScanEnabled);
    setScanCron(settings.schedule.cron);
    setTimezone(settings.schedule.timezone);
  }, [settings]);

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

  const handleSendNow = useCallback(async () => {
    setSending(true);
    setError(null);
    setSent(null);
    try {
      const result = await api.notify();
      setSent(`Sent, listing ${result.notApplied} projects.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }, [api]);

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await api.previewNotify());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  }, [api]);

  // A host edit invalidates the previous probe, so the result never claims a
  // value the admin has since changed.
  const updateHost = useCallback((value: string) => {
    setHost(value);
    setProbe(null);
    setError(null);
  }, []);

  // Probing on every keystroke would fire a request per character, so the
  // check waits for a pause long enough to read as "done typing" but short
  // enough that nobody waits on it.
  const probeSeq = React.useRef(0);
  useEffect(() => {
    const candidate = host.trim();
    if (!candidate || localHostError(candidate)) {
      setTesting(false);
      return undefined;
    }

    const seq = ++probeSeq.current;
    setTesting(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.testHost(candidate);
        // A slower earlier request must not overwrite a newer answer.
        if (seq !== probeSeq.current) return;
        setProbe(result);
      } catch (err) {
        if (seq !== probeSeq.current) return;
        setError(err instanceof Error ? err.message : 'Test failed');
      } finally {
        if (seq === probeSeq.current) setTesting(false);
      }
    }, PROBE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [api, host]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveSettings({
        forkliftHost: host,
        webhookUrl: webhookUrl.trim() || undefined,
        webhookEnabled,
        webhookSkipWhenFullCoverage: skipWhenFullCoverage,
        scanCron,
        timezone,
        autoScanEnabled,
      });
      setProbe(result.probe);
      // The URL is write only from here on, so the field is cleared once it
      // is stored. Coverage carries the webhook state that gates Send now.
      setWebhookUrl('');
      setSavedWebhookEnabled(webhookEnabled);
      refetchCoverage();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [
    api,
    refetchCoverage,
    host,
    webhookUrl,
    webhookEnabled,
    skipWhenFullCoverage,
    scanCron,
    timezone,
    autoScanEnabled,
    onSaved,
  ]);

  if (adminLoading || (isAdmin && settingsLoading)) {
    return (
      <>
        {HEADER}
        <Container my="4">
          <Text>Loading…</Text>
        </Container>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        {HEADER}
        <Container my="4">
          <Alert
            status="warning"
            title="Forklift Coverage is not set up yet"
            description="A Backstage administrator needs to enter the Forklift host before coverage can be scanned. Ask your DevOps team to finish the setup."
          />
        </Container>
      </>
    );
  }

  const managed = settings?.managedByConfig ?? false;

  // Send now posts the stored webhook. Anything unsaved in the form would make
  // the button lie about what it is going to send, and a scan in flight would
  // report half-counted projects, so that blocks first.
  const sendBlockedReason = (() => {
    if (scanning) return 'A scan is running, sending is paused until it ends';
    if (!settings?.webhookUrlMasked) return 'Save a webhook URL to send';
    if (!coverage?.webhookConfigured) {
      return 'Turn the Slack toggle on and save to send';
    }
    if (webhookUrl.trim() || webhookEnabled !== savedWebhookEnabled) {
      return 'Save your webhook changes first';
    }
    if (!coverage?.lastScannedAt) return 'Run a scan before sending a report';
    return null;
  })();

  // The toggle only bites on a result that has nothing left to act on, and the
  // form state is what the admin is about to save, so the note follows it
  // rather than the stored value.
  const skipQuietNow =
    webhookEnabled &&
    skipWhenFullCoverage &&
    !!coverage?.lastScannedAt &&
    isFullCoverage(coverage);

  // Live counts, refreshed by the poll above, so the wait has a visible end.
  // Listing has no total yet, so it carries no percentage.
  const progress = coverage?.scanProgress;
  const scanCaption = `${
    !progress || progress.phase === 'listing' || progress.total === 0
      ? 'Listing projects'
      : `Scanning ${progress.done} of ${progress.total} (${Math.min(
          100,
          Math.round((progress.done / progress.total) * 100),
        )}%)`
  }, sending is paused until it ends`;

  return (
    <>
      {HEADER}
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Point the plugin at your Forklift artifact repository. The host is
          verified before it is saved, so a typo cannot silently produce zero
          coverage.
        </Text>

        {managed && (
          <Box mt="3">
            <Alert
              status="info"
              title="Host is pinned in app-config"
              description="Saving here stores an override in the database. Remove forkliftCoverage.forkliftHost from app-config if you want the UI to be the only source."
            />
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
          <Flex direction="column" gap="3">
            <Flex direction="column" gap="1">
              <Text variant="body-medium" weight="bold">
                1. Forklift host
              </Text>
              <Text variant="body-x-small" color="secondary">
                Bare host with no scheme or path, for example
                forklift.example.com
              </Text>
            </Flex>

            <Box style={{ maxWidth: 420 }}>
              <TextField
                label="Host"
                placeholder="forklift.example.com"
                value={host}
                onChange={updateHost}
              />
            </Box>

            {/* Verified as you type. The row keeps its height across states so
                the form does not jump while checking. */}
            <div className="fc-probe-status" aria-live="polite">
              {(() => {
                const formatError = localHostError(host);
                if (!host.trim()) {
                  return (
                    <Text variant="body-x-small" color="secondary">
                      Checked automatically once you stop typing
                    </Text>
                  );
                }
                if (formatError) {
                  return (
                    <Text variant="body-x-small" color="danger">
                      {formatError}
                    </Text>
                  );
                }
                if (testing) {
                  return (
                    <>
                      <span className="fc-probe-spinner" aria-hidden />
                      <Text variant="body-x-small" color="secondary">
                        Checking https://{host.trim()}
                      </Text>
                    </>
                  );
                }
                if (probe?.reachable) {
                  return (
                    <>
                      <RiCheckboxCircleFill size={14} className="fc-probe-ok" />
                      <Text variant="body-x-small" color="success">
                        Reachable in {probe.latencyMs}ms, answered HTTP{' '}
                        {probe.status}
                      </Text>
                    </>
                  );
                }
                if (probe) {
                  return (
                    <>
                      <RiErrorWarningFill size={14} className="fc-probe-bad" />
                      <Text variant="body-x-small" color="danger">
                        Did not answer. {probe.error}
                      </Text>
                    </>
                  );
                }
                return null;
              })()}
            </div>

            <Flex direction="column" gap="1">
              <Text variant="body-medium" weight="bold">
                2. Slack webhook, optional
              </Text>
              <Text variant="body-x-small" color="secondary">
                Coverage summaries are posted here after each scheduled scan.
                {settings?.webhookUrlMasked
                  ? ` Currently ${settings.webhookUrlMasked}, leave empty to keep it.`
                  : ''}
              </Text>
            </Flex>

            <TextField
              label="Webhook URL"
              placeholder="https://hooks.slack.com/services/…"
              value={webhookUrl}
              onChange={setWebhookUrl}
            />
            <ToggleRow
              title="Post the summary to Slack"
              description="Sent after every scheduled scan, and available as a manual send"
              isSelected={webhookEnabled}
              onChange={setWebhookEnabled}
            />
            {/* Only the scheduled post is dropped. Send now stays available,
                since a report someone asked for is never noise. */}
            <ToggleRow
              title="Stay quiet at full coverage"
              description="Skip the scheduled post when every target project is applied, with no partial, missing, or errored project left to act on"
              isSelected={skipWhenFullCoverage}
              isDisabled={!webhookEnabled}
              onChange={setSkipWhenFullCoverage}
            />
            {/* A skipped post looks the same as a broken one from the channel,
                so the page says when the current result is the reason. */}
            {skipQuietNow && (
              <Text variant="body-x-small" color="secondary">
                Coverage is 100%, so the scheduled post is skipped while this is
                on. Send now still works.
              </Text>
            )}

            <Flex direction="column" gap="1">
              <Text variant="body-medium" weight="bold">
                3. Automatic scan and Slack summary
              </Text>
              <Text variant="body-x-small" color="secondary">
                A scan runs on this schedule and posts the summary to the
                webhook above. Manual scans stay available either way.
              </Text>
            </Flex>

            <ToggleRow
              title="Run the scan automatically"
              description="Off means coverage only updates when someone presses Scan now"
              isSelected={autoScanEnabled}
              onChange={setAutoScanEnabled}
            />

            <Flex gap="2" style={{ flexWrap: 'wrap' }}>
              <Box style={{ flex: '1 1 200px', minWidth: 160 }}>
                <TextField
                  label="Cron"
                  placeholder="0 10 * * 1-5"
                  value={scanCron}
                  onChange={setScanCron}
                  isDisabled={!autoScanEnabled}
                />
              </Box>
              <Box style={{ flex: '1 1 200px', minWidth: 160 }}>
                {/* Picked, not typed: the zone set is closed, and a typo here
                    only surfaces later as a scan running at the wrong hour. */}
                {timezoneOptions.length > 0 ? (
                  <Select
                    label="Timezone"
                    options={timezoneOptions}
                    selectedKey={timezone}
                    onSelectionChange={key => setTimezone(key as string)}
                    search={{ placeholder: 'Search zones' }}
                    isDisabled={!autoScanEnabled}
                  />
                ) : (
                  <TextField
                    label="Timezone"
                    placeholder="Asia/Seoul"
                    value={timezone}
                    onChange={setTimezone}
                    isDisabled={!autoScanEnabled}
                  />
                )}
              </Box>
            </Flex>

            {settings?.schedule.nextRunAt && (
              <Text variant="body-x-small" color="secondary">
                Currently next runs {formatNextRun(settings.schedule.nextRunAt)}
              </Text>
            )}

            <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onPress={handlePreview}
                isDisabled={previewLoading}
              >
                {previewLoading ? 'Loading…' : 'Preview Slack message'}
              </Button>
              {/* Sends the stored webhook, not whatever is typed in the form,
                  so it stays disabled until the URL is saved and enabled and
                  there is a scan to report on. */}
              <Button
                variant="secondary"
                onPress={handleSendNow}
                isDisabled={sending || !!sendBlockedReason}
              >
                {sending ? 'Sending…' : 'Send now'}
              </Button>
              {/* A running scan is the one blocked state that resolves on its
                  own, so it gets live counts instead of a static reason. */}
              {scanning && (
                <Flex align="center" gap="1" aria-live="polite">
                  <span className="fc-probe-spinner" aria-hidden />
                  <Text variant="body-x-small" color="secondary">
                    {scanCaption}
                  </Text>
                </Flex>
              )}
              {preview?.sample && (
                <Text variant="body-x-small" color="secondary">
                  No scan has run yet, so the preview uses example numbers
                </Text>
              )}
              {/* The scanning case is already covered by the caption above. */}
              {sendBlockedReason && !scanning && (
                <Text variant="body-x-small" color="secondary">
                  {sendBlockedReason}
                </Text>
              )}
              {sent && (
                <Text variant="body-x-small" color="success">
                  {sent}
                </Text>
              )}
            </Flex>

            {preview && (
              <SlackPreview text={preview.text} sample={preview.sample} />
            )}

            {error && <Alert status="danger" title={error} />}

            <Flex gap="2">
              {/* The backend refuses an unreachable host anyway, so the button
                  waits for the check rather than letting the save fail. */}
              <Button
                variant="primary"
                onPress={handleSave}
                isDisabled={!probe?.reachable || saving || testing}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </Flex>
          </Flex>
        </Box>
      </Container>
    </>
  );
};
