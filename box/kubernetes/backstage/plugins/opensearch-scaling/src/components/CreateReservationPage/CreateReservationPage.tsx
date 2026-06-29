import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useRouteRef } from '@backstage/core-plugin-api';
import { useAsync } from 'react-use';
import {
  Alert,
  Box,
  Button,
  Combobox,
  Container,
  DatePicker,
  Flex,
  PluginHeader,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  TextField,
} from '@backstage/ui';
import { RiArrowUpCircleLine, RiCheckLine } from '@remixicon/react';
import { opensearchScalingPlugin } from '../../plugin';
import { rootRouteRef } from '../../routes';
import { opensearchScalingApiRef } from '../../api';
import { toKey } from '../common';
import { formatInZone, zonedWallClockToUtc } from '../time';
import '../opensearch-scaling.css';

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * A DatePicker minute-granularity value is a wall-clock date/time (no zone).
 * Render it as "YYYY-MM-DDTHH:MM" so it can be paired with the chosen timezone.
 */
const toWallClock = (v: any): string => {
  if (!v || typeof v.year !== 'number') return '';
  return `${v.year}-${pad(v.month)}-${pad(v.day)}T${pad(v.hour ?? 0)}:${pad(
    v.minute ?? 0,
  )}`;
};

export const CreateReservationPage = () => {
  const api = useApi(opensearchScalingApiRef);
  const navigate = useNavigate();
  const listLink = useRouteRef(rootRouteRef);

  const config = useAsync(() => api.getConfig(), [api]);
  const userRole = useAsync(() => api.getUserRole(), [api]);
  const isAdmin = userRole.value?.isAdmin ?? false;
  const domains = useAsync(() => api.listDomains(), [api]);

  const [domain, setDomain] = useState('');
  const [instanceType, setInstanceType] = useState('');
  const [instanceCount, setInstanceCount] = useState('');
  const [volumeSizeGb, setVolumeSizeGb] = useState('');
  const [dateValue, setDateValue] = useState<any>(null);
  const [timezone, setTimezone] = useState('');
  const [reason, setReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default the timezone selector to the backend-provided default once.
  useEffect(() => {
    if (!timezone && config.value?.defaultTimezone) {
      setTimezone(config.value.defaultTimezone);
    }
  }, [config.value, timezone]);

  // Fetch the selected domain's current config + in-progress flag.
  const domainDetail = useAsync(
    () => (domain ? api.getDomain(domain) : Promise.resolve(undefined)),
    [api, domain],
  );

  // Prefill target fields from the current config so the user edits from it.
  useEffect(() => {
    const d = domainDetail.value;
    if (!d) return;
    setInstanceType(d.instanceType ?? '');
    setInstanceCount(d.instanceCount != null ? String(d.instanceCount) : '');
    setVolumeSizeGb(d.volumeSizeGb != null ? String(d.volumeSizeGb) : '');
  }, [domainDetail.value]);

  const detail = domainDetail.value;
  const changeInProgress = detail?.changeInProgress ?? false;

  const countNum = Number(instanceCount);
  const volNum = Number(volumeSizeGb);
  const localTime = toWallClock(dateValue);
  const scheduledUtc =
    localTime && timezone ? zonedWallClockToUtc(localTime, timezone) : null;
  const scheduleInFuture = scheduledUtc
    ? scheduledUtc.getTime() > Date.now()
    : false;

  const isNoop =
    !!detail &&
    instanceType === (detail.instanceType ?? '') &&
    countNum === detail.instanceCount &&
    volNum === detail.volumeSizeGb;

  // Before/after comparison rows shown live as the user edits the form.
  const beforeCount = detail?.instanceCount ?? null;
  const beforeVol = detail?.volumeSizeGb ?? null;
  const afterCount = Number.isInteger(countNum) && countNum > 0 ? countNum : null;
  const afterVol = Number.isInteger(volNum) && volNum > 0 ? volNum : null;
  const num = (n: number | null) => (n == null ? '-' : String(n));
  const dir = (b: number | null, a: number | null): 'up' | 'down' | null =>
    b == null || a == null || a === b ? null : a > b ? 'up' : 'down';
  const delta = (b: number | null, a: number | null): number | null =>
    b == null || a == null ? null : a - b;
  const pct = (b: number | null, a: number | null): number | null =>
    b == null || a == null || b === 0 ? null : Math.round(((a - b) / b) * 100);
  const beforeTotal =
    beforeCount != null && beforeVol != null ? beforeCount * beforeVol : null;
  const afterTotal =
    afterCount != null && afterVol != null ? afterCount * afterVol : null;

  // Numeric rows carry the signed delta, percent change, and a unit suffix so
  // the panel can show exactly how much each spec increases or decreases.
  const numericRow = (
    label: string,
    b: number | null,
    a: number | null,
    unit: string,
  ) => ({
    label,
    before: num(b),
    after: num(a),
    changed: a != null && a !== b,
    dir: dir(b, a),
    delta: delta(b, a),
    pct: pct(b, a),
    unit,
  });

  const specRows = detail
    ? [
        {
          label: 'Instance type',
          before: detail.instanceType ?? '-',
          after: instanceType || '-',
          changed: instanceType !== (detail.instanceType ?? ''),
          dir: null as 'up' | 'down' | null,
          delta: null as number | null,
          pct: null as number | null,
          unit: '',
        },
        numericRow('Data nodes', beforeCount, afterCount, ''),
        numericRow('EBS / node (GB)', beforeVol, afterVol, ' GB'),
        numericRow('Total EBS (GB)', beforeTotal, afterTotal, ' GB'),
      ]
    : [];

  // The spec is complete enough to simulate (independent of schedule/reason).
  const specReady =
    isAdmin &&
    !!domain &&
    !changeInProgress &&
    instanceType.trim().length > 0 &&
    Number.isInteger(countNum) &&
    countNum >= 1 &&
    Number.isInteger(volNum) &&
    volNum >= 10 &&
    !isNoop;

  const canSubmit =
    specReady && scheduleInFuture && reason.trim().length > 0;

  // Auto-run an AWS dry-run once the spec is ready, debounced so typing the
  // node count or volume does not fire a request on every keystroke.
  const [previewTarget, setPreviewTarget] = useState<{
    instanceType: string;
    instanceCount: number;
    volumeSizeGb: number;
  } | null>(null);
  useEffect(() => {
    if (!specReady) {
      setPreviewTarget(null);
      return undefined;
    }
    const id = setTimeout(
      () =>
        setPreviewTarget({
          instanceType: instanceType.trim(),
          instanceCount: countNum,
          volumeSizeGb: volNum,
        }),
      500,
    );
    return () => clearTimeout(id);
  }, [specReady, domain, instanceType, countNum, volNum]);

  const preview = useAsync(
    async () =>
      domain && previewTarget
        ? api.previewScaling(domain, previewTarget)
        : undefined,
    [api, domain, previewTarget],
  );

  const deployInfo = (
    t: string | null | undefined,
  ): {
    label: string;
    short: string;
    status: 'info' | 'success' | 'warning';
    desc: string;
  } => {
    switch (t) {
      case 'Blue/Green':
        return {
          label: 'Blue/Green deployment',
          short: 'Blue/Green',
          status: 'warning',
          desc: 'AWS creates a new environment and migrates data. This is heavier and slower, and a brief performance impact is possible.',
        };
      case 'DynamicUpdate':
        return {
          label: 'Dynamic in-place update',
          short: 'Dynamic',
          status: 'success',
          desc: 'AWS applies the change in place without a blue/green deployment.',
        };
      case 'None':
        return {
          label: 'No change',
          short: 'No change',
          status: 'info',
          desc: 'AWS reports no configuration change for these values.',
        };
      default:
        return {
          label: t || 'Undetermined',
          short: t || 'Undetermined',
          status: 'info',
          desc: 'AWS could not determine the deployment type for this change.',
        };
    }
  };

  const submit = useCallback(async () => {
    setError(null);
    if (!scheduledUtc) {
      setError('Pick a valid reservation date and time.');
      return;
    }
    setBusy(true);
    try {
      await api.createRequest({
        domain,
        instanceType: instanceType.trim(),
        instanceCount: countNum,
        volumeSizeGb: volNum,
        scheduledAt: scheduledUtc.toISOString(),
        timezone,
        reason: reason.trim(),
      });
      // Back to the list, where the new reservation appears.
      navigate(listLink());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to submit scaling reservation');
    } finally {
      setBusy(false);
    }
  }, [
    api,
    domain,
    instanceType,
    countNum,
    volNum,
    scheduledUtc,
    timezone,
    reason,
    navigate,
    listLink,
  ]);

  // Prefer the instance types the AWS API reports as valid for the selected
  // domain's engine version; fall back to the configured list before selection.
  const instanceTypeSource =
    detail?.instanceTypes && detail.instanceTypes.length > 0
      ? detail.instanceTypes
      : config.value?.instanceTypes ?? [];
  const instanceTypeOptions = instanceTypeSource.map(t => ({
    value: t,
    label: t === detail?.instanceType ? `${t} (Current)` : t,
  }));
  const domainOptions = (domains.value ?? []).map(d => ({
    value: d.name,
    label: d.engineVersion ? `${d.name} (${d.engineVersion})` : d.name,
  }));
  const timezoneOptions = (config.value?.timezones ?? []).map(tz => ({
    value: tz,
    label: tz,
  }));

  return (
    <>
      <PluginHeader
        icon={<RiArrowUpCircleLine />}
        title="Reserve OpenSearch scaling"
        customActions={
          <TagGroup>
            <Tag id="plugin-id" size="small">
              {opensearchScalingPlugin.getId()}
            </Tag>
            <Tag id="model" size="small">
              scheduled
            </Tag>
          </TagGroup>
        }
      />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Text variant="body-small" color="secondary">
            Reserve a scaling change (data-node instance type, node count, and
            per-node EBS volume) for an Amazon OpenSearch Service domain. The
            change runs at your reserved time; it is blocked if the domain
            already has a change or upgrade in progress.
          </Text>

          {error && <Alert status="danger" title={error} />}
          {!userRole.loading && !isAdmin && (
            <Alert
              status="warning"
              title="Only admins can reserve scaling changes. You can view reservations but not create them."
            />
          )}

          <Box className="osc-section">
            <Flex direction="column" gap="3">
              <Select
                label="Domain"
                isRequired
                searchable
                placeholder={
                  domains.loading ? 'Loading domains...' : 'Select a domain'
                }
                options={domainOptions}
                selectedKey={domain || null}
                onSelectionChange={key => setDomain(toKey(key))}
              />

              {domain && domainDetail.loading && (
                <Skeleton style={{ height: 24 }} />
              )}

              {detail &&
                (changeInProgress ? (
                  <Alert
                    status="danger"
                    title="This domain already has a change or upgrade in progress, so you cannot reserve a new change until it completes."
                  />
                ) : (
                  <Alert
                    status="success"
                    icon={<RiCheckLine />}
                    title="This domain has no change or upgrade in progress and is ready to reserve."
                  />
                ))}

              <Combobox
                label="Data node instance type"
                isRequired
                allowsCustomValue
                isDisabled={!domain}
                placeholder={
                  domain
                    ? 'Select or type an instance type'
                    : 'Select a domain first'
                }
                options={instanceTypeOptions}
                inputValue={instanceType}
                onInputChange={setInstanceType}
              />

              <Flex gap="3" direction="row">
                <TextField
                  label="Data node count"
                  isRequired
                  inputMode="numeric"
                  value={instanceCount}
                  onChange={setInstanceCount}
                  placeholder="e.g. 3"
                />
                <TextField
                  label="EBS volume per node (GB)"
                  isRequired
                  inputMode="numeric"
                  value={volumeSizeGb}
                  onChange={setVolumeSizeGb}
                  placeholder="e.g. 100"
                />
              </Flex>

              {detail && (
                <Box className="osc-diff">
                  <div className="osc-diff-cols">
                    {/* Left: current spec */}
                    <div className="osc-diff-col osc-diff-col-left">
                      <div className="osc-diff-colhead">Current</div>
                      {specRows.map(r => (
                        <div className="osc-diff-line" key={r.label}>
                          <span className="osc-diff-rowlabel">{r.label}</span>
                          <span className="osc-mono">{r.before}</span>
                        </div>
                      ))}
                    </div>

                    {/* Center: one connected arrow through the deployment badge */}
                    <div className="osc-diff-mid">
                      <div className="osc-diff-track">
                        <span className="osc-diff-seg" />
                        {preview.loading ? (
                          <span className="osc-deploy osc-deploy-loading">
                            simulating...
                          </span>
                        ) : preview.error ? (
                          <span
                            className="osc-deploy osc-deploy-warning"
                            title={preview.error.message}
                          >
                            simulate failed
                          </span>
                        ) : preview.value ? (
                          <span
                            className={`osc-deploy osc-deploy-${
                              deployInfo(preview.value.deploymentType).status
                            }`}
                            title={
                              preview.value.message
                                ? `${deployInfo(preview.value.deploymentType).desc} ${preview.value.message}`
                                : deployInfo(preview.value.deploymentType).desc
                            }
                          >
                            {deployInfo(preview.value.deploymentType).short}
                          </span>
                        ) : (
                          <span className="osc-deploy osc-deploy-loading">
                            change preview
                          </span>
                        )}
                        <span className="osc-diff-seg" />
                        <span className="osc-diff-tip" />
                      </div>
                    </div>

                    {/* Right: target spec */}
                    <div className="osc-diff-col osc-diff-col-right">
                      <div className="osc-diff-colhead">After</div>
                      {specRows.map(r => (
                        <div className="osc-diff-line" key={r.label}>
                          <span
                            className={`osc-mono ${
                              r.changed ? 'osc-diff-changed' : ''
                            }`}
                          >
                            {r.after}
                            {r.dir && r.delta != null && r.delta !== 0 && (
                              <span
                                className={`osc-delta ${
                                  r.dir === 'up' ? 'osc-up' : 'osc-down'
                                }`}
                              >
                                {' '}
                                {r.dir === 'up' ? '▲' : '▼'}{' '}
                                {r.delta > 0 ? '+' : ''}
                                {r.delta}
                                {r.unit}
                                {r.pct != null &&
                                  ` (${r.pct > 0 ? '+' : ''}${r.pct}%)`}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {specReady &&
                    !preview.loading &&
                    !preview.error &&
                    preview.value &&
                    (() => {
                      const info = deployInfo(preview.value.deploymentType);
                      const desc = preview.value.message
                        ? `${info.desc} ${preview.value.message}`
                        : info.desc;
                      return (
                        <div className="osc-sim">
                          <Alert
                            status={info.status}
                            title={info.label}
                            description={desc}
                          />
                        </div>
                      );
                    })()}
                </Box>
              )}

              <Flex gap="3" direction="row">
                <DatePicker
                  label="Reserved execution time"
                  isRequired
                  granularity="minute"
                  value={dateValue}
                  onChange={setDateValue}
                />
                <Select
                  label="Timezone"
                  isRequired
                  searchable
                  placeholder="Select timezone"
                  options={timezoneOptions}
                  selectedKey={timezone || null}
                  onSelectionChange={key => setTimezone(toKey(key))}
                />
              </Flex>

              {scheduledUtc && (
                <Text variant="body-small" color="secondary">
                  Runs at {formatInZone(scheduledUtc.toISOString(), timezone)} ·{' '}
                  {scheduledUtc.toISOString()} UTC
                  {!scheduleInFuture && (
                    <span className="osc-warn"> — must be in the future</span>
                  )}
                </Text>
              )}

              <TextField
                label="Reason"
                isRequired
                value={reason}
                onChange={setReason}
                placeholder="Why is this scaling needed?"
              />

              {isNoop && (
                <Text variant="body-small" className="osc-warn">
                  Target matches the current configuration; change at least one
                  value.
                </Text>
              )}

              <Flex gap="2">
                <Button
                  variant="secondary"
                  onClick={() => navigate(listLink())}
                  isDisabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={submit}
                  isDisabled={busy || !canSubmit}
                >
                  Reserve scaling
                </Button>
              </Flex>
            </Flex>
          </Box>
        </Flex>
      </Container>
    </>
  );
};
