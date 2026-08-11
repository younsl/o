import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Alert,
  Box,
  ButtonIcon,
  Card,
  CardBody,
  CardFooter,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Button,
  Flex,
  Grid,
  Link,
  SearchField,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import {
  RiAlertLine,
  RiArrowUpCircleLine,
  RiEditLine,
  RiHistoryLine,
  RiInformationLine,
  RiNotificationLine,
  RiNotificationOffLine,
} from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import {
  argocdAppsetApiRef,
  ApplicationSetResponse,
  BranchInfo,
  MUTE_ANNOTATION,
  ScanStatus,
  UpstreamChart,
  VersionOrigin,
} from '../../api';
import { CopyButton } from '../CopyButton';
import { HighlightText } from '../HighlightText';
import { YamlBlock } from '../YamlBlock';
import './ApplicationSetTable.css';

const appInfoList = (appSet: ApplicationSetResponse) =>
  Object.values(appSet.applicationInfos ?? {});

/** Enough of a digest to identify it, since the whole thing tells no more. */
const DIGEST_SHOWN = 14;

/**
 * Image name and tag without the registry path. Every image here comes through
 * the same proxy, so the prefix repeats on every line and pushes the part that
 * differs out of view.
 */
export const shortImageRef = (ref: string): string => {
  const [path, digest] = ref.split('@');
  const name = path.slice(path.lastIndexOf('/') + 1);

  return digest ? `${name}@${digest.slice(0, DIGEST_SHOWN)}` : name;
};

/**
 * Distinct chart version provenances across the generated Applications. The
 * same chart deployed to several clusters reads identical values from different
 * paths, so entries are grouped by the values themselves and the applications
 * sharing them are listed together.
 */
interface OriginGroup {
  origin: VersionOrigin;
  applications: string[];
  /** Charts these applications deploy, to match an upgrade against the group */
  charts: string[];
}

const chartVersionOrigins = (appSet: ApplicationSetResponse): OriginGroup[] => {
  const groups = new Map<string, OriginGroup>();

  for (const info of appInfoList(appSet)) {
    const origin = info.chartVersionOrigin;
    if (!origin) continue;

    const signature = JSON.stringify([origin.kind, origin.content]);
    const group = groups.get(signature);
    if (group) {
      group.applications.push(info.name);
      if (info.chart && !group.charts.includes(info.chart)) {
        group.charts.push(info.chart);
      }
    } else {
      groups.set(signature, {
        origin,
        applications: [info.name],
        charts: info.chart ? [info.chart] : [],
      });
    }
  }

  return [...groups.values()];
};

/**
 * Charts an ApplicationSet deploys, with the version pinned for each. One entry
 * per distinct chart: the same chart deployed to several clusters is one row
 * unless the clusters are pinned to different versions.
 */
interface ChartTarget {
  chart: string;
  currentVersion: string;
  upstreamChart: string | null;
  upstreamRepository: string | null;
}

const chartTargets = (appSet: ApplicationSetResponse): ChartTarget[] => {
  const byKey = new Map<string, ChartTarget>();

  for (const info of appInfoList(appSet)) {
    if (!info.chart || !info.chartVersion) continue;
    const key = `${info.chart}|${info.chartVersion}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        chart: info.chart,
        currentVersion: info.chartVersion,
        upstreamChart: info.upstreamChart,
        upstreamRepository: info.upstreamRepository,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.chart.localeCompare(b.chart));
};

/** Numeric field-by-field, so 0.10.0 sorts above 0.9.0. */
export const isUpgradeAvailable = (current: string, latest: string): boolean => {
  const toParts = (version: string) =>
    version
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map(Number);

  const currentParts = toParts(current);
  const latestParts = toParts(latest);
  if (currentParts.some(Number.isNaN) || latestParts.some(Number.isNaN)) {
    return false;
  }

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i += 1) {
    const diff = (latestParts[i] ?? 0) - (currentParts[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

/**
 * How the pinned version stands against the newest one upstream offers. The
 * wording carries the distinction; only the actionable case takes an accent,
 * since a table where every row is tinted teaches a reader to ignore the tint.
 */
type UpstreamState = 'upgrade' | 'latest' | 'ahead' | 'checking' | 'unknown';

interface UpstreamComparison {
  state: UpstreamState;
  symbol: string | null;
  version: string | null;
  status: string;
}

export const describeUpstream = (
  currentVersion: string,
  state: UpstreamChart | 'loading' | 'error' | undefined,
): UpstreamComparison => {
  if (state === 'loading') {
    return { state: 'checking', symbol: null, version: null, status: 'Checking' };
  }

  const latest = state && state !== 'error' ? state.latestVersion : null;
  if (!latest) {
    return { state: 'unknown', symbol: null, version: null, status: 'Unknown' };
  }

  if (isUpgradeAvailable(currentVersion, latest)) {
    return {
      state: 'upgrade',
      symbol: '↑',
      version: latest,
      status: 'Upgrade available',
    };
  }
  if (latest === currentVersion) {
    return { state: 'latest', symbol: '=', version: latest, status: 'Latest' };
  }

  // Pinned past what the repository publishes, which a prerelease pin does.
  return {
    state: 'ahead',
    symbol: '↓',
    version: latest,
    status: 'Ahead of upstream',
  };
};


type UpstreamStateMap = Record<string, UpstreamChart | 'loading' | 'error'>;

export const upstreamKey = (target: ChartTarget): string | null =>
  target.upstreamChart && target.upstreamRepository
    ? `${target.upstreamRepository}|${target.upstreamChart}`
    : null;

/** How often the shared scan's progress is polled while it runs. */
const SCAN_POLL_MS = 800;

/** How often the cooldown countdown is refreshed while it is active. */
const COOLDOWN_POLL_MS = 1000;

/** Names shown before the rest are summarised as a count. */
const UNREADABLE_NAMES_SHOWN = 3;

/**
 * Charts whose upstream could not be read, so a count of failures can say which
 * ones they were. A failed lookup is stored like any other, with its reason in
 * place of a version, which is what makes this readable from state rather than
 * needing the scan to report it.
 */
export const unreadableCharts = (
  upstream: UpstreamStateMap,
): { chart: string; reason: string }[] =>
  Object.values(upstream).flatMap(entry => {
    if (entry === 'loading') return [];
    if (entry === 'error') return [];
    return entry.latestVersion === null
      ? [
          {
            chart: entry.chart,
            reason: entry.unavailableReason ?? 'no reason given',
          },
        ]
      : [];
  });

export const unreadableSummary = (
  charts: { chart: string; reason: string }[],
): string => {
  const names = charts.map(entry => entry.chart).sort();
  const shown = names.slice(0, UNREADABLE_NAMES_SHOWN).join(', ');
  const hidden = names.length - UNREADABLE_NAMES_SHOWN;

  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
};

export const scanButtonLabel = (status: ScanStatus | null): string => {
  if (status?.running) {
    const percent =
      status.total === 0 ? 100 : Math.round((status.done / status.total) * 100);
    return `Checking ${status.done} of ${status.total} (${percent}%)`;
  }
  if ((status?.cooldownSeconds ?? 0) > 0) {
    return `Check again in ${status!.cooldownSeconds}s`;
  }
  return 'Check for updates';
};

/** Charts of one ApplicationSet whose upstream offers something newer. */
const appSetUpgrades = (
  appSet: ApplicationSetResponse,
  upstream: UpstreamStateMap,
): { chart: string; currentVersion: string; latestVersion: string }[] =>
  chartTargets(appSet).flatMap(target => {
    const key = upstreamKey(target);
    const state = key ? upstream[key] : undefined;
    const comparison = describeUpstream(target.currentVersion, state);

    return comparison.state === 'upgrade' && comparison.version
      ? [
          {
            chart: target.chart,
            currentVersion: target.currentVersion,
            latestVersion: comparison.version,
          },
        ]
      : [];
  });

const originKindLabel = (kind: VersionOrigin['kind']) =>
  kind === 'helm-repository'
    ? 'Read from the Application, which pins a chart in a Helm repository'
    : 'Read from Chart.yaml in the git repository, which the Application does not carry';

/**
 * App versions across the generated Applications, with the applications on
 * each. More than one entry means the same ApplicationSet has deployed
 * different versions to different clusters, which is worth flagging: it is
 * usually a sync that stopped halfway rather than an intended difference.
 */
const appVersionGroups = (
  appSet: ApplicationSetResponse,
): { version: string; applications: string[] }[] => {
  const byVersion = new Map<string, string[]>();

  for (const info of appInfoList(appSet)) {
    if (!info.appVersion) continue;
    const applications = byVersion.get(info.appVersion) ?? [];
    applications.push(info.name);
    byVersion.set(info.appVersion, applications);
  }

  return [...byVersion.entries()]
    .map(([version, applications]) => ({ version, applications: applications.sort() }))
    .sort((a, b) => a.version.localeCompare(b.version));
};

const RETRY_INTERVAL_MS = 3000;

const TIME_UNITS: { limit: number; seconds: number; name: string }[] = [
  { limit: 60, seconds: 1, name: 'second' },
  { limit: 3600, seconds: 60, name: 'minute' },
  { limit: 86400, seconds: 3600, name: 'hour' },
  { limit: 2592000, seconds: 86400, name: 'day' },
  { limit: 31536000, seconds: 2592000, name: 'month' },
  { limit: Infinity, seconds: 31536000, name: 'year' },
];

/** "3 days ago", so a stale branch is obvious without reading a timestamp. */
export const relativeTime = (isoDate: string, now: Date = new Date()): string => {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return 'unknown';

  const elapsed = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  if (elapsed < 45) return 'just now';

  const unit = TIME_UNITS.find(candidate => elapsed < candidate.limit) ?? TIME_UNITS[5];
  const count = Math.round(elapsed / unit.seconds);
  return `${count} ${unit.name}${count === 1 ? '' : 's'} ago`;
};

/**
 * An empty list means one of two very different things: the cluster has no
 * ApplicationSets, or the backend has not filled its cache yet. The cache is
 * populated by a scheduled task with a startup delay, so right after a restart
 * the list is legitimately empty and reporting "none found" would be wrong.
 * `lastFetchedAt` is what separates the two.
 */
const FirstFetchPending = (props: { fetchCron?: string }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsedSeconds(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Flex direction="column" gap="3" mt="4" className="appset-pending">
      <Text variant="body-small" color="secondary" role="status">
        Waiting for the first fetch from the cluster. The backend fills its cache on a
        schedule{props.fetchCron ? ` (${props.fetchCron})` : ''} and has not reported a
        fetch yet. Retrying every {RETRY_INTERVAL_MS / 1000} seconds, {elapsedSeconds}s
        elapsed.
      </Text>
      {/* The shape the cards will take, so nothing moves once data arrives. */}
      <PlaceholderCards />
    </Flex>
  );
};

/** The card grid's own layout, empty. Shared by the initial load and the wait. */
const PlaceholderCards = () => (
  <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
    {[1, 2, 3, 4].map(card => (
      <Grid.Item key={card}>
        <Skeleton width="100%" height={200} />
      </Grid.Item>
    ))}
  </Grid.Root>
);

export const ApplicationSetTable = () => {
  const api = useApi(argocdAppsetApiRef);

  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);
  const isAdmin = adminStatus?.isAdmin ?? false;

  const [searchQuery, setSearchQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [revisionFilter, setRevisionFilter] = useState<string>('all');
  const [overviewFilter, setOverviewFilter] = useState<
    'all' | 'notHead' | 'muted' | 'upgrades'
  >('all');

  const [chartDetailKey, setChartDetailKey] = useState<string | null>(null);
  const [appDetailKey, setAppDetailKey] = useState<string | null>(null);
  const [upstreamState, setUpstreamState] = useState<UpstreamStateMap>({});
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [scanError, setScanError] = useState(false);
  const scanning = scanStatus?.running ?? false;
  // Keys already requested, so reopening the dialog does not refetch.
  const requestedUpstream = useRef<Set<string>>(new Set());
  const [mutingKey, setMutingKey] = useState<string | null>(null);
  const [localAppSets, setLocalAppSets] = useState<ApplicationSetResponse[] | undefined>(undefined);

  const {
    value: appSetsRaw,
    loading,
    error: loadError,
    retry: retryAppSets,
  } = useAsyncRetry(async () => {
    return api.listApplicationSets();
  }, []);

  const appSets = localAppSets ?? appSetsRaw;

  const { value: status, retry: retryStatus } = useAsyncRetry(async () => {
    return api.getStatus();
  }, []);

  // An empty list before the backend reports a fetch is a cold cache, not an
  // empty cluster. Treat a status that has not loaded yet the same way, since
  // it cannot yet rule the cold cache out.
  const awaitingFirstFetch =
    (appSets?.length ?? 0) === 0 && !status?.lastFetchedAt;

  useEffect(() => {
    if (!awaitingFirstFetch) return undefined;
    const timer = setInterval(() => {
      retryStatus();
      retryAppSets();
    }, RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [awaitingFirstFetch, retryStatus, retryAppSets]);

  const totalCount = appSets?.length ?? 0;
  const nonHeadCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => !a.isHeadRevision).length;
  }, [appSets]);
  const totalApps = useMemo(() => {
    if (!appSets) return 0;
    return appSets.reduce((sum, a) => sum + a.applicationCount, 0);
  }, [appSets]);
  const mutedCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => a.muted).length;
  }, [appSets]);

  const uniqueRepos = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.map(a => a.repoName).filter(Boolean))].sort();
  }, [appSets]);

  const uniqueRevisions = useMemo(() => {
    if (!appSets) return [];
    return [...new Set(appSets.flatMap(a => a.targetRevisions))].sort();
  }, [appSets]);

  const filteredAppSets = useMemo(() => {
    if (!appSets) return [];
    return appSets
      .filter(a => {
        const matchesSearch =
          searchQuery === '' ||
          a.name.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesRepo =
          repoFilter === 'all' || a.repoName === repoFilter;
        const matchesRevision =
          revisionFilter === 'all' || a.targetRevisions.includes(revisionFilter);
        const matchesOverview =
          overviewFilter === 'all' ||
          (overviewFilter === 'notHead' && !a.isHeadRevision) ||
          (overviewFilter === 'muted' && a.muted) ||
          (overviewFilter === 'upgrades' && appSetUpgrades(a, upstreamState).length > 0);
        return matchesSearch && matchesRepo && matchesRevision && matchesOverview;
      })
      .sort((a, b) => Number(a.isHeadRevision) - Number(b.isHeadRevision));
  }, [appSets, searchQuery, repoFilter, revisionFilter, overviewFilter, upstreamState]);

  const unreadable = useMemo(() => unreadableCharts(upstreamState), [upstreamState]);

  const upgradableCount = useMemo(() => {
    if (!appSets) return 0;
    return appSets.filter(a => appSetUpgrades(a, upstreamState).length > 0).length;
  }, [appSets, upstreamState]);

  const formatDate = (dateString: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const handleToggleMute = useCallback(async (namespace: string, name: string, muted: boolean) => {
    const key = `${namespace}/${name}`;
    setMutingKey(key);
    try {
      if (muted) {
        await api.unmute(namespace, name);
      } else {
        await api.mute(namespace, name);
      }
      setLocalAppSets(prev => {
        const source = prev ?? appSetsRaw;
        if (!source) return source;
        return source.map(a =>
          a.namespace === namespace && a.name === name
            ? { ...a, muted: !muted }
            : a,
        );
      });
    } catch {
      // silently fail — next fetch cycle will reflect actual state
    } finally {
      setMutingKey(null);
    }
  }, [api, appSetsRaw]);

  const [editRevisionKey, setEditRevisionKey] = useState<string | null>(null);
  const [editRevisionValue, setEditRevisionValue] = useState('');
  const [savingRevisionKey, setSavingRevisionKey] = useState<string | null>(null);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);

  useEffect(() => {
    if (!editRevisionKey || !appSets) return;
    const appSet = appSets.find(a => `${a.namespace}/${a.name}` === editRevisionKey);
    if (!appSet?.repoUrl) {
      setBranchesFailed(true);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesFailed(false);
    setBranches([]);
    setDefaultBranch(null);
    api.listBranches(appSet.repoUrl).then(
      result => {
        if (!cancelled) {
          setBranches(result.branches);
          setDefaultBranch(result.defaultBranch);
          setBranchesLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setBranchesFailed(true);
          setBranchesLoading(false);
        }
      },
    );
    return () => { cancelled = true; };
  }, [editRevisionKey, appSets, api]);

  /*
   * What the last scan recorded, by whoever ran it. Reading this rather than
   * scanning on load means the page marks what is upgradable without every
   * reader pressing anything, and a restarted backend still knows.
   */
  const loadStoredUpstream = useCallback(async () => {
    const charts = await api.listUpstreamCharts();
    setUpstreamState(prev => {
      const next = { ...prev };
      for (const chart of charts) {
        const key = `${chart.repository}|${chart.chart}`;
        next[key] = chart;
        // Marked as requested so opening a dialog does not fetch it again.
        requestedUpstream.current.add(key);
      }
      return next;
    });
  }, [api]);

  useEffect(() => {
    // Nothing stored yet is the normal first state, so a failure is not shown.
    loadStoredUpstream().catch(() => {});
    api.getScanStatus().then(setScanStatus, () => {});
  }, [api, loadStoredUpstream]);

  /*
   * The scan runs on the backend, so its progress and the cooldown that follows
   * belong to the deployment rather than to one browser. Polling is what lets a
   * reader watch a scan somebody else started.
   */
  useEffect(() => {
    const waitingOnScan = scanStatus?.running ?? false;
    const countingDown = (scanStatus?.cooldownSeconds ?? 0) > 0;
    if (!waitingOnScan && !countingDown) return undefined;

    const timer = setInterval(
      () => {
        api.getScanStatus().then(next => {
          setScanStatus(previous => {
            // A scan just finished: pull in what it recorded.
            if (previous?.running && !next.running) {
              loadStoredUpstream().catch(() => {});
            }
            return next;
          });
        }, () => {});
      },
      waitingOnScan ? SCAN_POLL_MS : COOLDOWN_POLL_MS,
    );

    return () => clearInterval(timer);
  }, [api, scanStatus?.running, scanStatus?.cooldownSeconds, loadStoredUpstream]);

  const handleScanUpstream = useCallback(async () => {
    setScanError(false);
    try {
      const { started } = await api.startScan();
      // A refusal means another reader got there first; the poll picks it up.
      setScanStatus(await api.getScanStatus());
      if (!started) return;
    } catch {
      setScanError(true);
    }
  }, [api]);

  /*
   * The upstream lookup reads a Helm index, which is far too large to pull on
   * the refresh schedule, so it runs only when the detail dialog opens.
   */
  useEffect(() => {
    if (!chartDetailKey || !appSets) return undefined;
    const appSet = appSets.find(a => `${a.namespace}/${a.name}` === chartDetailKey);
    if (!appSet) return undefined;

    let cancelled = false;

    for (const target of chartTargets(appSet)) {
      const { upstreamChart, upstreamRepository } = target;
      if (!upstreamChart || !upstreamRepository) continue;

      const key = `${upstreamRepository}|${upstreamChart}`;
      if (requestedUpstream.current.has(key)) continue;
      requestedUpstream.current.add(key);
      setUpstreamState(prev => ({ ...prev, [key]: 'loading' }));

      api.getUpstreamChart(upstreamRepository, upstreamChart).then(
        result => {
          if (!cancelled) setUpstreamState(prev => ({ ...prev, [key]: result }));
        },
        () => {
          // Dropped from the requested set so a reopen retries.
          requestedUpstream.current.delete(key);
          if (!cancelled) setUpstreamState(prev => ({ ...prev, [key]: 'error' }));
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [chartDetailKey, appSets, api]);

  const handleSaveTargetRevision = useCallback(async (namespace: string, name: string) => {
    const key = `${namespace}/${name}`;
    const trimmed = editRevisionValue.trim();
    if (!trimmed) return;
    setSavingRevisionKey(key);
    try {
      await api.setTargetRevision(namespace, name, trimmed);
      setLocalAppSets(prev => {
        const source = prev ?? appSetsRaw;
        if (!source) return source;
        const isDynamic = (rev: string) => /\{\{.*\}\}/.test(rev);
        const isHead = trimmed === 'HEAD' || trimmed === '' || isDynamic(trimmed);
        return source.map(a =>
          a.namespace === namespace && a.name === name
            ? { ...a, targetRevisions: [trimmed], isHeadRevision: isHead }
            : a,
        );
      });
      setEditRevisionKey(null);
    } catch {
      // silently fail — next fetch cycle will reflect actual state
    } finally {
      setSavingRevisionKey(null);
    }
  }, [api, appSetsRaw, editRevisionValue]);

  if (loading) {
    return (
      <Flex direction="column" gap="3" mt="4">
        <Skeleton width="100%" height={60} />
        <Skeleton width="100%" height={40} />
        <PlaceholderCards />
      </Flex>
    );
  }

  if (loadError) {
    return (
      <Flex direction="column" gap="2" mt="4">
        <Alert status="danger" title="Failed to load ApplicationSets" />
        <Text variant="body-small" color="secondary">
          {loadError.message}
        </Text>
      </Flex>
    );
  }

  if (!appSets || appSets.length === 0) {
    if (awaitingFirstFetch) {
      return <FirstFetchPending fetchCron={status?.fetchCron} />;
    }

    return (
      <Flex direction="column" align="center" gap="2" className="appset-empty-state">
        <Text variant="body-large" color="secondary">
          No ApplicationSets found
        </Text>
        <Text variant="body-small" color="secondary">
          The backend last fetched at {new Date(status!.lastFetchedAt!).toLocaleString()}{' '}
          and the cluster reported none. Check that the service account can list
          ApplicationSets in the configured namespace.
        </Text>
      </Flex>
    );
  }

  const repoOptions = [
    { value: 'all', label: 'All' },
    ...uniqueRepos.map(repo => ({ value: repo, label: repo })),
  ];

  const revisionOptions = [
    { value: 'all', label: 'All' },
    ...uniqueRevisions.map(rev => ({ value: rev, label: rev })),
  ];

  return (
    <>
      {/*
        Without this permission the version columns are empty for a reason no
        reader could infer from a dash, so the cause is named once here rather
        than left to look like missing data on every card.
      */}
      {status?.applicationsReadable === false && (
        <Box mt="4">
          <Alert
            status="warning"
            title="Chart and app versions are unavailable"
          />
          <Text variant="body-small" color="secondary">
            The service account cannot list Applications, which is where the
            versions are read from. Grant it get and list on{' '}
            <code>applications</code> in the <code>argoproj.io</code> API group.
            Everything else on this page is unaffected.
          </Text>
        </Box>
      )}

      <Box mt="4" p="3" className="appset-section-box">
        <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
          <Text variant="body-medium" weight="bold">
            Overview
          </Text>
          {status && (
            <TooltipTrigger delay={200}>
              <Button
                variant="tertiary"
                size="small"
                className={`appset-integration-badge ${status.slackConfigured ? 'appset-integration-connected' : 'appset-integration-disconnected'}`}
              >
                Webhook {status.slackConfigured ? 'Connected' : 'Not configured'}
              </Button>
              <Tooltip style={{ maxWidth: 280 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 700 }}>Slack Incoming Webhook</div>
                  <div>Status: {status.slackConfigured ? 'Configured' : 'Not configured'}</div>
                  <div>Usage: Sends non-HEAD revision alerts to Slack channel</div>
                  <div style={{ opacity: 0.7 }}>Last checked: {new Date().toLocaleString()}</div>
                </div>
              </Tooltip>
            </TooltipTrigger>
          )}
        </Flex>
        <div className="appset-summary-bar">
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalCount}</Text>
            <Text variant="body-x-small" color="secondary">ApplicationSets</Text>
          </div>
          <div className="appset-summary-card">
            <Text weight="bold" className="appset-summary-value">{totalApps}</Text>
            <Text variant="body-x-small" color="secondary">Total Apps</Text>
          </div>
          <div
            className={`appset-summary-card appset-summary-clickable ${overviewFilter === 'notHead' ? 'appset-summary-active' : ''}`}
            onClick={() => setOverviewFilter(prev => prev === 'notHead' ? 'all' : 'notHead')}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOverviewFilter(prev => prev === 'notHead' ? 'all' : 'notHead'); }}
          >
            <Text weight="bold" color={nonHeadCount > 0 ? 'warning' : undefined} className="appset-summary-value">
              {nonHeadCount}
            </Text>
            <Text variant="body-x-small" color="secondary">Not HEAD</Text>
          </div>
          <div
            className={`appset-summary-card appset-summary-clickable ${overviewFilter === 'upgrades' ? 'appset-summary-active' : ''}`}
            onClick={() => setOverviewFilter(prev => (prev === 'upgrades' ? 'all' : 'upgrades'))}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                setOverviewFilter(prev => (prev === 'upgrades' ? 'all' : 'upgrades'));
              }
            }}
          >
            <Text
              weight="bold"
              color={upgradableCount > 0 ? 'warning' : undefined}
              className="appset-summary-value"
            >
              {upgradableCount}
            </Text>
            <Text variant="body-x-small" color="secondary">Upgradable</Text>
          </div>
          <div
            className={`appset-summary-card appset-summary-clickable ${overviewFilter === 'muted' ? 'appset-summary-active' : ''}`}
            onClick={() => setOverviewFilter(prev => prev === 'muted' ? 'all' : 'muted')}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOverviewFilter(prev => prev === 'muted' ? 'all' : 'muted'); }}
          >
            <Text weight="bold" className="appset-summary-value">{mutedCount}</Text>
            <Text variant="body-x-small" color="secondary">Muted</Text>
            <TooltipTrigger delay={200}>
              <ButtonIcon
                size="small"
                variant="tertiary"
                icon={<RiInformationLine size={14} />}
                aria-label="Muted info"
                className="appset-muted-info-btn"
              />
              <Tooltip>{`ApplicationSets with ${MUTE_ANNOTATION} annotation are excluded from Slack notifications.`}</Tooltip>
            </TooltipTrigger>
          </div>
          {status && (
            <div className="appset-summary-card">
              <Text variant="body-x-small" weight="bold" className="appset-cron-badge">
                {status.cron}
              </Text>
              <Text variant="body-x-small" color="secondary">
                Schedule (UTC)
              </Text>
            </div>
          )}
          {status?.lastFetchedAt && (
            <div className="appset-summary-card">
              <Text variant="body-x-small" color="secondary">
                Last fetched {new Date(status.lastFetchedAt).toLocaleString()}
              </Text>
            </div>
          )}
        </div>
      </Box>

      <Box mt="3" p="3" className="appset-section-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <div className="appset-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by name..."
            size="small"
            value={searchQuery}
            onChange={setSearchQuery}
          />
          <Select
            label="Repository"
            size="small"
            options={repoOptions}
            selectedKey={repoFilter}
            onSelectionChange={key => setRepoFilter(key as string)}
          />
          <Select
            label="Target Revision"
            size="small"
            options={revisionOptions}
            selectedKey={revisionFilter}
            onSelectionChange={key => setRevisionFilter(key as string)}
          />
        </div>
      </Box>

      <Box mt="3" p="3" className="appset-section-box">
        <Flex justify="between" align="center" mb="3">
          <Text variant="body-medium" weight="bold">
            ApplicationSets
          </Text>
          <Flex align="center" gap="3">
            {scanError ? (
              <Text variant="body-small" color="danger">
                Could not start the check
              </Text>
            ) : (
              unreadable.length > 0 &&
              !scanning && (
                <span
                  className="appset-unreadable"
                  title={unreadable
                    .map(entry => `${entry.chart}: ${entry.reason}`)
                    .join('\n')}
                >
                  <Text variant="body-small" color="secondary">
                    Could not read {unreadableSummary(unreadable)}
                  </Text>
                </span>
              )
            )}
            <Button
              variant="secondary"
              size="small"
              onPress={handleScanUpstream}
              isDisabled={scanning || (scanStatus?.cooldownSeconds ?? 0) > 0}
            >
              {scanButtonLabel(scanStatus)}
            </Button>
            <Flex align="center" gap="2">
              <span className="appset-count-badge">
                {filteredAppSets.length !== totalCount
                  ? `${filteredAppSets.length} / ${totalCount}`
                  : totalCount}
              </span>
              <Text variant="body-small" color="secondary">results</Text>
            </Flex>
          </Flex>
        </Flex>

        {filteredAppSets.length === 0 ? (
          <div className="appset-empty-state">
            <Text variant="body-medium" color="secondary">
              No ApplicationSets match the current filters
            </Text>
          </div>
        ) : (
          <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
            {filteredAppSets.map(appSet => {
              const cardKey = `${appSet.namespace}/${appSet.name}`;
              const isMuting = mutingKey === cardKey;
              const chartVersions = appSet.chartVersions ?? [];
              const chartOrigins = chartVersionOrigins(appSet);
              const upgrades = appSetUpgrades(appSet, upstreamState);
              const versionGroups = appVersionGroups(appSet);
              const appVersions = versionGroups.map(group => group.version);

              return (
                <Grid.Item key={cardKey} className="appset-grid-item">
                  <Card className={`${appSet.isHeadRevision ? 'appset-card' : 'appset-card-warning'}${appSet.muted ? ' appset-card-muted' : ''}`}>
                    <CardBody className="appset-card-body">
                      <div>
                        <Text variant="body-medium" className="appset-card-name">
                          <HighlightText text={appSet.name} query={searchQuery} />
                        </Text>
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Repository
                        </Text>
                        {appSet.repoName ? (
                          appSet.repoUrl ? (
                            <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                              <Text variant="body-small">{appSet.repoName}</Text>
                            </Link>
                          ) : (
                            <Text variant="body-small">{appSet.repoName}</Text>
                          )
                        ) : (
                          <Text variant="body-small" color="secondary">-</Text>
                        )}
                      </div>

                      <div className="appset-version-row">
                        <div>
                          <Text variant="body-x-small" color="secondary" className="appset-field-label">
                            Chart Version
                          </Text>
                          <div className="appset-version-value-row">
                            <Text
                              variant="body-small"
                              color={chartVersions.length > 0 ? undefined : 'secondary'}
                            >
                              {chartVersions.length > 0 ? chartVersions.join(', ') : '-'}
                            </Text>
                            {chartOrigins.length > 0 && (
                              <DialogTrigger
                                isOpen={chartDetailKey === cardKey}
                                onOpenChange={open =>
                                  setChartDetailKey(open ? cardKey : null)
                                }
                              >
                                {/*
                                  One button, two meanings: an upgrade is worth
                                  flagging, so it replaces the plain detail icon
                                  rather than sitting beside it.
                                */}
                                <ButtonIcon
                                  size="small"
                                  variant="tertiary"
                                  icon={
                                    upgrades.length > 0 ? (
                                      <RiArrowUpCircleLine size={14} />
                                    ) : (
                                      <RiInformationLine size={14} />
                                    )
                                  }
                                  aria-label={
                                    upgrades.length > 0
                                      ? 'A newer chart version is available, view detail'
                                      : 'View chart version detail'
                                  }
                                  className={
                                    upgrades.length > 0
                                      ? 'appset-upgrade-btn'
                                      : 'appset-detail-btn'
                                  }
                                />
                                <Dialog className="appset-detail-dialog">
                                  <DialogHeader>Chart Version Detail</DialogHeader>
                                  <DialogBody>
                                    <div className="appset-chart-summary-scroll">
                                    <table className="appset-chart-summary">
                                      <thead>
                                        <tr>
                                          <th>Chart</th>
                                          <th>Current</th>
                                          <th>Upstream</th>
                                          <th>Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {chartTargets(appSet).map(target => {
                                          const key =
                                            target.upstreamChart && target.upstreamRepository
                                              ? `${target.upstreamRepository}|${target.upstreamChart}`
                                              : null;
                                          const state = key ? upstreamState[key] : undefined;
                                          const upstream =
                                            state && state !== 'loading' && state !== 'error'
                                              ? state
                                              : null;
                                          const comparison = describeUpstream(
                                            target.currentVersion,
                                            state,
                                          );

                                          return (
                                            <tr key={`${target.chart}-${target.currentVersion}`}>
                                              <td className="appset-chart-summary-name">
                                                {target.chart}
                                              </td>
                                              <td className="appset-chart-summary-version">
                                                {target.currentVersion}
                                              </td>
                                              <td
                                                className="appset-chart-summary-version"
                                                title={
                                                  upstream
                                                    ? upstream.unavailableReason ??
                                                      `Newest of ${upstream.versionCount} versions in ${upstream.repository}`
                                                    : undefined
                                                }
                                              >
                                                {comparison.version ? (
                                                  <>
                                                    <span aria-hidden="true">
                                                      {comparison.symbol}
                                                    </span>{' '}
                                                    {comparison.version}
                                                  </>
                                                ) : (
                                                  <span className="appset-chart-summary-muted">
                                                    -
                                                  </span>
                                                )}
                                              </td>
                                              <td className="appset-chart-summary-status">
                                                <div
                                                  className={`appset-chart-summary-status-${comparison.state}`}
                                                >
                                                  {comparison.status}
                                                </div>
                                                {upstream && (
                                                  <div
                                                    className="appset-chart-summary-checked"
                                                    title={new Date(
                                                      upstream.checkedAt,
                                                    ).toLocaleString()}
                                                  >
                                                    checked {relativeTime(upstream.checkedAt)}
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                    </div>
                                    <Flex direction="column" gap="4">
                                      {chartOrigins.map((group, i) => {
                                        // The line the version was read from is
                                        // the line an upgrade would change.
                                        const upgrade = upgrades.find(candidate =>
                                          group.charts.includes(candidate.chart),
                                        );
                                        /*
                                          Every highlighted line, not just the
                                          first: a version can be pinned on more
                                          than one line, and marking one of them
                                          would read as the others being current.
                                        */
                                        const annotations = upgrade
                                          ? Object.fromEntries(
                                              group.origin.highlightLines.map(line => [
                                                line,
                                                <>
                                                  <RiArrowUpCircleLine size={12} />
                                                  {upgrade.latestVersion} available
                                                </>,
                                              ]),
                                            )
                                          : undefined;

                                        return (
                                        <Flex key={i} direction="column" gap="1">
                                          <Text
                                            variant="body-x-small"
                                            color="secondary"
                                            weight="bold"
                                          >
                                            {originKindLabel(group.origin.kind)}
                                          </Text>
                                          {group.origin.url ? (
                                            <Link
                                              href={group.origin.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="appset-origin-location"
                                            >
                                              {group.origin.location}
                                            </Link>
                                          ) : (
                                            <div className="appset-origin-location">
                                              {group.origin.location}
                                            </div>
                                          )}
                                          <YamlBlock
                                            content={group.origin.content}
                                            highlightLines={group.origin.highlightLines}
                                            annotations={annotations}
                                          />
                                          <div className="appset-origin-apps">
                                            {group.applications.slice().sort().join(', ')}
                                          </div>
                                        </Flex>
                                        );
                                      })}
                                    </Flex>
                                  </DialogBody>
                                  <DialogFooter>
                                    <Flex justify="end">
                                      <Button
                                        variant="secondary"
                                        onPress={() => setChartDetailKey(null)}
                                      >
                                        Close
                                      </Button>
                                    </Flex>
                                  </DialogFooter>
                                </Dialog>
                              </DialogTrigger>
                            )}
                          </div>
                        </div>
                        <div>
                          <Text variant="body-x-small" color="secondary" className="appset-field-label">
                            App Version
                          </Text>
                          <div className="appset-version-value-row">
                            <Text
                              variant="body-small"
                              color={appVersions.length > 0 ? undefined : 'secondary'}
                            >
                              {appVersions.length > 0 ? appVersions.join(', ') : '-'}
                            </Text>
                            {appVersions.length > 1 && (
                              <TooltipTrigger delay={200}>
                                <ButtonIcon
                                  size="small"
                                  variant="tertiary"
                                  icon={<RiAlertLine size={14} />}
                                  aria-label="Applications are on different app versions"
                                  className="appset-warn-btn"
                                />
                                <Tooltip className="appset-apps-tooltip">
                                  <div className="appset-app-tooltip-body">
                                    <div className="appset-app-tooltip-title">
                                      Applications are not on the same app version
                                    </div>
                                    <div>
                                      {appVersions.length} versions are running across{' '}
                                      {appSet.applicationCount} applications. A rollout that
                                      stopped partway looks like this.
                                    </div>
                                    <div className="appset-app-tooltip-images">
                                      {versionGroups.map(group => (
                                        <div key={group.version}>
                                          {group.version}: {group.applications.join(', ')}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </Tooltip>
                              </TooltipTrigger>
                            )}
                          </div>
                        </div>
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Target Revision
                        </Text>
                        <div className="appset-revision-row">
                          <TagGroup>
                            {appSet.targetRevisions.map((rev, i) => (
                              <Tag key={i} id={`rev-${i}`} size="small">{rev}</Tag>
                            ))}
                          </TagGroup>
                          {isAdmin && (
                            <DialogTrigger
                              isOpen={editRevisionKey === cardKey}
                              onOpenChange={open => {
                                if (open) {
                                  setEditRevisionKey(cardKey);
                                  setEditRevisionValue(appSet.targetRevisions[0] ?? 'HEAD');
                                } else {
                                  setEditRevisionKey(null);
                                }
                              }}
                            >
                              <ButtonIcon
                                size="small"
                                variant="tertiary"
                                icon={<RiEditLine size={14} />}
                                aria-label="Edit target revision"
                                className="appset-edit-revision-btn"
                              />
                              <Dialog>
                                <DialogHeader>Edit Target Revision</DialogHeader>
                                <DialogBody>
                                  <Flex direction="column" gap="3">
                                    <Flex direction="column" gap="1">
                                      <Text variant="body-x-small" color="secondary" weight="bold">ApplicationSet</Text>
                                      {/*
                                        Namespaced here although the cards omit
                                        it: this dialog changes the resource, so
                                        it names exactly which one.
                                      */}
                                      <Text variant="body-medium">
                                        <Text as="span" variant="body-medium" color="secondary">
                                          {appSet.namespace}
                                        </Text>
                                        {' / '}
                                        {appSet.name}
                                      </Text>
                                    </Flex>
                                    <Flex direction="column" gap="1">
                                      <Text variant="body-x-small" color="secondary" weight="bold">Repository</Text>
                                      {appSet.repoUrl ? (
                                        <Link href={appSet.repoUrl} target="_blank" rel="noopener noreferrer">
                                          <Text variant="body-medium">{appSet.repoName}</Text>
                                        </Link>
                                      ) : (
                                        <Text variant="body-medium">{appSet.repoName || '-'}</Text>
                                      )}
                                    </Flex>
                                    <Flex direction="column" gap="1">
                                      <Flex align="center" gap="2">
                                        <Text variant="body-x-small" color="secondary" weight="bold">Target Revision <Text as="span" variant="body-x-small" color="danger">*</Text></Text>
                                        {branchesLoading ? (
                                          <Skeleton width={24} height={18} rounded />
                                        ) : !branchesFailed && (
                                          <span style={{
                                            fontSize: 11,
                                            lineHeight: '18px',
                                            padding: '0 6px',
                                            borderRadius: 9,
                                            backgroundColor: 'var(--bui-color-background-neutral)',
                                            color: 'var(--bui-color-text-secondary)',
                                          }}>
                                            {branches.length} branches
                                          </span>
                                        )}
                                      </Flex>
                                      {branchesLoading ? (
                                        <Skeleton width="100%" height={40} />
                                      ) : branchesFailed ? (
                                        <TextField
                                          aria-label="Target Revision"
                                          value={editRevisionValue}
                                          onChange={setEditRevisionValue}
                                          autoFocus
                                        />
                                      ) : (
                                        <Select
                                          aria-label="Target Revision"
                                          searchable
                                          options={[
                                            { value: 'HEAD', label: 'HEAD' },
                                            ...branches.map(b => ({
                                              value: b.name,
                                              label: b.isDefault
                                                ? `${b.name} (default)`
                                                : b.name,
                                            })),
                                          ]}
                                          selectedKey={editRevisionValue}
                                          onSelectionChange={key => setEditRevisionValue(key as string)}
                                        />
                                      )}
                                    </Flex>

                                    {/*
                                      HEAD resolves to the default branch, so the
                                      commit shown for it is that branch's tip.
                                    */}
                                    {(() => {
                                      const selectedName =
                                        editRevisionValue === 'HEAD'
                                          ? defaultBranch
                                          : editRevisionValue;
                                      const branch = branches.find(
                                        b => b.name === selectedName,
                                      );
                                      if (!branch?.commit) return null;
                                      const commit = branch.commit;

                                      return (
                                        <Flex direction="column" gap="1">
                                          <Text
                                            variant="body-x-small"
                                            color="secondary"
                                            weight="bold"
                                          >
                                            Last Commit on {branch.name}
                                            {editRevisionValue === 'HEAD'
                                              ? ' (HEAD)'
                                              : ''}
                                          </Text>
                                          <div className="appset-commit-box">
                                            <div className="appset-commit-main">
                                              <Text
                                                variant="body-small"
                                                className="appset-commit-title"
                                              >
                                                {commit.title}
                                              </Text>
                                              <div className="appset-commit-meta">
                                                <span>{commit.authorName}</span>
                                                <span
                                                  title={new Date(
                                                    commit.committedDate,
                                                  ).toLocaleString()}
                                                >
                                                  {relativeTime(commit.committedDate)}
                                                </span>
                                              </div>
                                            </div>
                                            {/* Short SHA reads better, the full one
                                                is what gets pasted. */}
                                            <div className="appset-commit-ref">
                                              {commit.webUrl ? (
                                                <Link
                                                  href={commit.webUrl}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="appset-commit-sha"
                                                >
                                                  <Text variant="body-small">
                                                    {commit.shortId}
                                                  </Text>
                                                </Link>
                                              ) : (
                                                <Text variant="body-small">
                                                  {commit.shortId}
                                                </Text>
                                              )}
                                              <CopyButton
                                                value={commit.id}
                                                subject="commit SHA"
                                                className="appset-commit-copy-btn"
                                                iconSize={12}
                                              />
                                            </div>
                                          </div>
                                        </Flex>
                                      );
                                    })()}
                                  </Flex>
                                </DialogBody>
                                <DialogFooter>
                                  <Flex gap="2" justify="end">
                                    <Button
                                      variant="secondary"
                                      onPress={() => setEditRevisionKey(null)}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      variant="primary"
                                      onPress={() => handleSaveTargetRevision(appSet.namespace, appSet.name)}
                                      isDisabled={savingRevisionKey === cardKey || editRevisionValue.trim() === ''}
                                    >
                                      {savingRevisionKey === cardKey ? 'Saving...' : 'Save'}
                                    </Button>
                                  </Flex>
                                </DialogFooter>
                              </Dialog>
                            </DialogTrigger>
                          )}
                        </div>
                        {!appSet.isHeadRevision && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#f59e0b', fontSize: 12, marginTop: 4 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                            </svg>
                            Not HEAD
                          </span>
                        )}
                      </div>

                      <div>
                        <Text variant="body-x-small" color="secondary" className="appset-field-label">
                          Applications ({appSet.syncedCount} / {appSet.applicationCount} Synced)
                        </Text>
                        {appSet.applications.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {appSet.applications.map(app => {
                              const status = appSet.applicationStatuses?.[app] ?? 'Unknown';
                              const info = appSet.applicationInfos?.[app];
                              const badgeClass =
                                status === 'Synced' ? 'appset-app-synced'
                                : status === 'OutOfSync' ? 'appset-app-outofsync'
                                : 'appset-app-unknown';
                              const appKey = `${cardKey}|${app}`;

                              // The scan's answer for this application's own
                              // chart, so the dialog says the same thing the
                              // card and the chart dialog do.
                              const upstreamEntry =
                                info?.upstreamRepository && info?.upstreamChart
                                  ? upstreamState[
                                      `${info.upstreamRepository}|${info.upstreamChart}`
                                    ]
                                  : undefined;
                              const upstreamRead =
                                upstreamEntry &&
                                upstreamEntry !== 'loading' &&
                                upstreamEntry !== 'error'
                                  ? upstreamEntry
                                  : null;
                              const chartComparison = info?.chartVersion
                                ? describeUpstream(info.chartVersion, upstreamEntry)
                                : null;

                              /*
                                A dialog rather than a tooltip: the image list
                                carries copy buttons, and a tooltip dismisses as
                                soon as the pointer leaves the badge, so nothing
                                inside one can be clicked.
                              */
                              return (
                                <DialogTrigger
                                  key={app}
                                  isOpen={appDetailKey === appKey}
                                  onOpenChange={open =>
                                    setAppDetailKey(open ? appKey : null)
                                  }
                                >
                                  <ButtonIcon
                                    size="small"
                                    variant="tertiary"
                                    className={`appset-app-badge ${badgeClass}`}
                                    icon={<span>{app.charAt(0).toUpperCase()}</span>}
                                    aria-label={`${app} (${status}), view detail`}
                                  />
                                  <Dialog className="appset-app-dialog">
                                    <DialogHeader>{app}</DialogHeader>
                                    <DialogBody>
                                      <Flex direction="column" gap="3">
                                        <table className="appset-app-detail">
                                          <tbody>
                                            <tr>
                                              <th>Sync</th>
                                              <td>{status}</td>
                                            </tr>
                                            {info?.healthStatus &&
                                              info.healthStatus !== 'Unknown' && (
                                                <tr>
                                                  <th>Health</th>
                                                  <td>{info.healthStatus}</td>
                                                </tr>
                                              )}
                                            {info?.chart && (
                                              <tr>
                                                <th>Chart</th>
                                                <td>
                                                  {info.chart}
                                                  {info.chartVersion
                                                    ? ` ${info.chartVersion}`
                                                    : ''}
                                                </td>
                                              </tr>
                                            )}
                                            {chartComparison && (
                                              <tr>
                                                <th>Upstream</th>
                                                <td>
                                                  <span
                                                    className={`appset-chart-summary-status-${chartComparison.state}`}
                                                  >
                                                    {chartComparison.state === 'upgrade' && (
                                                      <RiArrowUpCircleLine
                                                        size={12}
                                                        className="appset-inline-icon"
                                                      />
                                                    )}
                                                    {chartComparison.version
                                                      ? `${chartComparison.version} `
                                                      : ''}
                                                    {chartComparison.status}
                                                  </span>
                                                  {upstreamRead && (
                                                    <span
                                                      className="appset-app-tooltip-source"
                                                      title={new Date(
                                                        upstreamRead.checkedAt,
                                                      ).toLocaleString()}
                                                    >
                                                      checked{' '}
                                                      {relativeTime(upstreamRead.checkedAt)}
                                                      {upstreamRead.unavailableReason
                                                        ? `, ${upstreamRead.unavailableReason}`
                                                        : ''}
                                                    </span>
                                                  )}
                                                </td>
                                              </tr>
                                            )}
                                            {info?.appVersion && (
                                              <tr>
                                                <th>App version</th>
                                                <td>
                                                  {info.appVersion}
                                                  {info.appVersionSource && (
                                                    <span className="appset-app-tooltip-source">
                                                      from{' '}
                                                      {info.appVersionSource === 'image-tag'
                                                        ? 'image tag'
                                                        : 'Chart.yaml appVersion'}
                                                    </span>
                                                  )}
                                                </td>
                                              </tr>
                                            )}
                                            {info?.revision && (
                                              <tr>
                                                <th>Revision</th>
                                                <td>
                                                  <span className="appset-app-detail-mono">
                                                    {info.revision.slice(0, 7)}
                                                  </span>
                                                </td>
                                              </tr>
                                            )}
                                          </tbody>
                                        </table>

                                        {info && info.images.length > 0 && (
                                          <Flex direction="column" gap="1">
                                            <Text
                                              variant="body-x-small"
                                              color="secondary"
                                              weight="bold"
                                            >
                                              Running images ({info.images.length})
                                            </Text>
                                            <div className="appset-app-tooltip-source">
                                              From the Application's
                                              status.summary.images
                                            </div>
                                            <div className="appset-image-list">
                                              {info.images.map(image => (
                                                <div
                                                  key={image}
                                                  className="appset-image-row"
                                                >
                                                  <span
                                                    className="appset-image-name"
                                                    title={image}
                                                  >
                                                    {shortImageRef(image)}
                                                  </span>
                                                  {/* Copies the full reference,
                                                      not the shortened label. */}
                                                  <CopyButton
                                                    value={image}
                                                    subject="image reference"
                                                    className="appset-image-copy-btn"
                                                    iconSize={12}
                                                  />
                                                </div>
                                              ))}
                                            </div>
                                          </Flex>
                                        )}
                                      </Flex>
                                    </DialogBody>
                                    <DialogFooter>
                                      <Flex justify="end">
                                        <Button
                                          variant="secondary"
                                          onPress={() => setAppDetailKey(null)}
                                        >
                                          Close
                                        </Button>
                                      </Flex>
                                    </DialogFooter>
                                  </Dialog>
                                </DialogTrigger>
                              );
                            })}
                          </div>
                        ) : (
                          <Text variant="body-small" color="secondary">-</Text>
                        )}
                      </div>

                    </CardBody>

                    <CardFooter className="appset-card-footer">
                      <Text variant="body-x-small" color="secondary">
                        Created {formatDate(appSet.createdAt)}
                      </Text>
                      <Flex align="center" gap="0">
                        <TooltipTrigger>
                          <Link href={`/argocd-appset/audit-logs/${encodeURIComponent(appSet.namespace)}/${encodeURIComponent(appSet.name)}`}>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={<RiHistoryLine size={18} />}
                              aria-label="View change history"
                            />
                          </Link>
                          <Tooltip>View change history</Tooltip>
                        </TooltipTrigger>
                        {isAdmin && (
                          <TooltipTrigger>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={
                                isMuting
                                  ? <Skeleton width={18} height={18} rounded />
                                  : appSet.muted
                                    ? <RiNotificationOffLine size={18} />
                                    : <RiNotificationLine size={18} />
                              }
                              onPress={() => handleToggleMute(appSet.namespace, appSet.name, appSet.muted)}
                              isDisabled={isMuting}
                              aria-label={appSet.muted ? 'Unmute notifications' : 'Mute notifications'}
                            />
                            <Tooltip>{appSet.muted ? 'Unmute notifications' : 'Mute notifications'}</Tooltip>
                          </TooltipTrigger>
                        )}
                      </Flex>
                    </CardFooter>
                  </Card>
                </Grid.Item>
              );
            })}
          </Grid.Root>
        )}
      </Box>

    </>
  );
};
