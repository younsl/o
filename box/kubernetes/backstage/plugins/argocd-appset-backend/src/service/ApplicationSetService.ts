import * as k8s from '@kubernetes/client-node';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  ApplicationInfo,
  ApplicationSetResponse,
  BranchCommit,
  BranchListResponse,
  MUTE_ANNOTATION,
  VersionOrigin,
} from './types';
import { ChartMetadataStore, findVersionLines } from './ChartMetadataStore';
import { gitLabFileUrl, resolveGitLabApi } from './gitlab';

/** Parallel GitLab reads per refresh. Bounded to stay a polite API client. */
const CHART_FETCH_CONCURRENCY = 8;

/** The chart directory an Application renders, when it renders one at all. */
interface ChartRef {
  repoUrl: string;
  path: string;
  /** The Application's targetRevision, not its synced commit */
  ref: string | null;
}

/**
 * Normalizes the commit a GitLab branch listing embeds. `title` is already the
 * first line of the message, so the full body is not carried.
 */
export function mapBranchCommit(commit: any): BranchCommit | null {
  if (!commit?.id) return null;

  return {
    id: String(commit.id),
    shortId: commit.short_id ?? String(commit.id).slice(0, 8),
    title: commit.title ?? '',
    authorName: commit.author_name ?? 'unknown',
    committedDate: commit.committed_date ?? commit.created_at ?? '',
    webUrl: commit.web_url ?? null,
  };
}

export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/**
 * Split an image reference into its repository path and tag.
 *
 * Handles registry ports (`registry:5000/app:1.0`) by only treating a colon in
 * the last path segment as the tag separator, and digest pins
 * (`app@sha256:...`), which carry no tag at all.
 */
export function parseImageRef(ref: string): { repo: string; tag: string | null } {
  const withoutDigest = ref.split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastSegment = withoutDigest.slice(lastSlash + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon === -1) {
    return { repo: withoutDigest, tag: null };
  }
  return {
    repo: withoutDigest.slice(0, lastSlash + 1) + lastSegment.slice(0, colon),
    tag: lastSegment.slice(colon + 1),
  };
}

/**
 * Last segment of a source path, which for a chart source is the chart's own
 * directory name. `.` and an empty path address the repository root and name
 * nothing.
 */
export function lastPathSegment(path: string | undefined | null): string | null {
  if (!path) return null;
  const segments = path.split('/').filter(segment => segment && segment !== '.');
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * Pick the image that represents the app itself. A chart often deploys
 * sidecars (exporters, config reloaders, init images), so prefer the image
 * whose repository basename matches one of the hints and only fall back to the
 * sole image when there is exactly one. Hints are tried in order, so pass the
 * most specific name first.
 */
export function deriveAppVersion(
  images: string[],
  hints: (string | null)[],
): string | null {
  const parsed = images.map(parseImageRef).filter(p => p.tag !== null);
  if (parsed.length === 0) return null;

  for (const hint of hints) {
    if (!hint) continue;
    const match = parsed.find(p => {
      const basename = p.repo.slice(p.repo.lastIndexOf('/') + 1);
      return basename === hint;
    });
    if (match) return match.tag;
  }

  return parsed.length === 1 ? parsed[0].tag : null;
}

export class ApplicationSetService {
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly chartMetadata: ChartMetadataStore | null;
  /**
   * Whether the last attempt to list Applications succeeded. Null until one has
   * been made. Reading Applications needs a permission that listing
   * ApplicationSets does not, and without it every version field is empty for a
   * reason no reader could guess, so the outcome is reported rather than logged
   * and forgotten.
   */
  private applicationsReadable: boolean | null = null;

  constructor(options: {
    config: Config;
    logger: LoggerService;
    chartMetadata?: ChartMetadataStore | null;
  }) {
    this.config = options.config;
    this.logger = options.logger;
    this.chartMetadata = options.chartMetadata ?? null;
  }

  /** Null before the first fetch, false when the permission is missing. */
  isApplicationsReadable(): boolean | null {
    return this.applicationsReadable;
  }

  private getKubeConfig(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();

    const token = this.config.getOptionalString(
      'argocdApplicationSet.kubernetes.serviceAccountToken',
    );

    if (token) {
      const cluster = {
        name: 'in-cluster',
        server: 'https://kubernetes.default.svc',
        skipTLSVerify: true,
      };
      const user = {
        name: 'backstage',
        token,
      };
      kc.loadFromClusterAndUser(cluster, user);
    } else {
      try {
        kc.loadFromDefault();
      } catch {
        kc.loadFromCluster();
      }
    }

    return kc;
  }

  private getNamespace(): string {
    return this.config.getOptionalString(
      'argocdApplicationSet.kubernetes.namespace',
    ) ?? 'argocd';
  }

  async listApplicationSets(): Promise<ApplicationSetResponse[]> {
    const kc = this.getKubeConfig();
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

    try {
      const response = await customApi.listNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: this.getNamespace(),
        plural: 'applicationsets',
      });

      const body = response as any;
      const items: any[] = body?.items ?? [];

      const appsByOwner = await this.listApplicationsByOwner(customApi);

      return items.map(item => {
        const key = `${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`;
        return this.mapApplicationSet(item, appsByOwner.get(key) ?? []);
      });
    } catch (error) {
      this.logger.error(`Failed to list ApplicationSets: ${error}`);
      throw error;
    }
  }

  /**
   * Applications are read separately because ApplicationSet `status.resources`
   * has no chart or image data. A failure here must not hide the
   * ApplicationSets themselves, so the error is logged and an empty map
   * returned: the UI then simply shows no version detail.
   */
  private async listApplicationsByOwner(
    customApi: k8s.CustomObjectsApi,
  ): Promise<Map<string, ApplicationInfo[]>> {
    const byOwner = new Map<string, ApplicationInfo[]>();

    let items: any[];
    try {
      const response = await customApi.listNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: this.getNamespace(),
        plural: 'applications',
      });
      items = (response as any)?.items ?? [];
      this.applicationsReadable = true;
    } catch (error) {
      this.applicationsReadable = false;
      this.logger.warn(
        `Failed to list Applications, version detail unavailable: ${error}`,
      );
      return byOwner;
    }

    const chartRefs: { info: ApplicationInfo; chartRef: ChartRef }[] = [];

    for (const item of items) {
      const metadata = item.metadata ?? {};
      const owner = (metadata.ownerReferences ?? []).find(
        (ref: any) => ref.kind === 'ApplicationSet',
      );
      if (!owner?.name) continue;

      // ownerReferences are always same-namespace, so the owning
      // ApplicationSet shares the Application's namespace.
      const key = `${metadata.namespace ?? ''}/${owner.name}`;
      const list = byOwner.get(key) ?? [];
      const { info, chartRef } = this.mapApplication(item);
      list.push(info);
      byOwner.set(key, list);
      if (chartRef) {
        chartRefs.push({ info, chartRef });
      }
    }

    await this.enrichFromChartYaml(chartRefs);

    return byOwner;
  }

  /**
   * Fills in what the Application CR cannot carry: for a chart living in a git
   * path, the upstream chart version and the declared app version exist only in
   * the repository's Chart.yaml. Enrichment mutates the already-returned infos
   * in place, and a repository the store cannot reach simply leaves them as the
   * cluster reported them.
   */
  private async enrichFromChartYaml(
    entries: { info: ApplicationInfo; chartRef: ChartRef }[],
  ): Promise<void> {
    const store = this.chartMetadata;
    if (!store || entries.length === 0) return;

    const supported = entries.filter(entry => store.isSupported(entry.chartRef.repoUrl));
    if (supported.length === 0) return;

    await mapWithConcurrency(supported, CHART_FETCH_CONCURRENCY, async ({ info, chartRef }) => {
      const metadata = await store.get(chartRef.repoUrl, chartRef.path, chartRef.ref);
      if (!metadata) return;

      info.chart = metadata.name ?? info.chart;
      info.deprecated = metadata.deprecated;

      if (!info.chartVersion && metadata.upstreamVersion) {
        // With no dependencies the version is the chart's own, at column zero.
        const highlightLines = findVersionLines(
          metadata.raw,
          metadata.upstreamVersion,
          metadata.dependencies.length === 0,
        );
        const filePath = `${chartRef.path}/Chart.yaml`;

        info.chartVersion = metadata.upstreamVersion;
        info.chartVersionOrigin = {
          kind: 'chart-yaml',
          location: `${filePath} @ ${chartRef.ref ?? 'default branch'}`,
          url: gitLabFileUrl(
            chartRef.repoUrl,
            chartRef.ref ?? 'HEAD',
            filePath,
            highlightLines[0],
          ),
          content: metadata.raw,
          highlightLines,
        };
      }

      // The dependency name is the upstream chart's own name, which the
      // Application never records. It is the best hint available for matching
      // an image, since a wrapper is often named differently from what it wraps.
      const dependencyNames = metadata.dependencies.map(dep => dep.name);
      const soleDependency =
        metadata.dependencies.length === 1 ? metadata.dependencies[0] : null;
      info.upstreamChart = soleDependency?.name ?? null;
      info.upstreamRepository = soleDependency?.repository ?? null;

      if (!info.appVersion) {
        // The dependency name is a hint the Application never carries, so an
        // image can still match here. Only if none does is the declared
        // appVersion used, which is a claim rather than an observation.
        const fromImage = deriveAppVersion(info.images, dependencyNames);
        info.appVersion = fromImage ?? metadata.appVersion;
        info.appVersionSource = fromImage
          ? 'image-tag'
          : metadata.appVersion
            ? 'chart-yaml'
            : null;
      }
    });
  }

  private mapApplication(item: any): { info: ApplicationInfo; chartRef: ChartRef | null } {
    const metadata = item.metadata ?? {};
    const spec = item.spec ?? {};
    const status = item.status ?? {};

    const name: string = metadata.name ?? '';
    const source = this.findChartSource(spec);
    const pathName = lastPathSegment(source?.path);
    const releaseName: string | null = source?.helm?.releaseName ?? null;

    // A chart pulled from a Helm repository names itself in `chart` and pins
    // its version in `targetRevision`. A wrapper chart in a git path has
    // neither: `targetRevision` is the git revision, and the upstream version
    // lives in the wrapper's Chart.yaml, which enrichment reads separately.
    const chart: string | null = source?.chart ?? pathName ?? releaseName;
    const chartVersion: string | null = source?.chart
      ? source.targetRevision ?? null
      : null;
    const sourceLines: string[] = chartVersion
      ? [
          'source:',
          ...(source.repoURL ? [`  repoURL: ${source.repoURL}`] : []),
          `  chart: ${source.chart}`,
          `  targetRevision: ${chartVersion}`,
        ]
      : [];
    const chartVersionOrigin: VersionOrigin | null = chartVersion
      ? {
          kind: 'helm-repository',
          location: `${name} spec.source`,
          // The source block is a field of a cluster resource, not a file.
          url: null,
          content: sourceLines.join('\n'),
          // targetRevision is rendered last, and is the version itself.
          highlightLines: [sourceLines.length],
        }
      : null;

    // ArgoCD fills status.summary.images from the live resources the
    // Application owns, so these are the tags actually running.
    const images: string[] = status.summary?.images ?? [];
    const appVersion = deriveAppVersion(images, [
      source?.chart ?? null,
      pathName,
      releaseName,
      name,
    ]);

    const info: ApplicationInfo = {
      name,
      chart,
      chartVersion,
      chartVersionOrigin,
      upstreamChart: null,
      upstreamRepository: null,
      appVersion,
      appVersionSource: appVersion ? 'image-tag' : null,
      // Set by enrichment, which is the only step that sees a Chart.yaml.
      deprecated: false,
      images,
      syncStatus: status.sync?.status ?? 'Unknown',
      healthStatus: status.health?.status ?? 'Unknown',
      revision: status.sync?.revision ?? null,
    };

    // Only a git path can hold a Chart.yaml. A chart named in `chart` already
    // comes from a Helm repository with its version pinned in targetRevision.
    const chartRef: ChartRef | null =
      !source?.chart && source?.path && source?.repoURL
        ? {
            repoUrl: source.repoURL,
            path: source.path,
            ref: source.targetRevision ?? null,
          }
        : null;

    return { info, chartRef };
  }

  /**
   * The source that renders a chart: either one naming a `chart` in a Helm
   * repository, or one with a `helm` block, which means the path holds a chart.
   * A plain manifest or kustomize source has neither, and its path is not a
   * chart name.
   */
  private findChartSource(spec: any): any | null {
    const candidates = [spec.source, ...(spec.sources ?? [])].filter(Boolean);

    return (
      candidates.find(source => source.chart) ??
      candidates.find(source => source.helm) ??
      null
    );
  }

  async setMuted(namespace: string, name: string, muted: boolean): Promise<void> {
    const kc = this.getKubeConfig();
    const objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);

    const patch: k8s.KubernetesObject = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'ApplicationSet',
      metadata: {
        name,
        namespace,
        annotations: muted
          ? { [MUTE_ANNOTATION]: 'true' }
          : { [MUTE_ANNOTATION]: null as any },
      },
    };

    try {
      await objectApi.patch(
        patch,
        undefined, // pretty
        undefined, // dryRun
        undefined, // fieldManager
        undefined, // force
        k8s.PatchStrategy.MergePatch,
      );
    } catch (error) {
      this.logger.error(`Failed to ${muted ? 'mute' : 'unmute'} ${namespace}/${name}: ${error}`);
      throw error;
    }
  }

  async listBranches(repoUrl: string): Promise<BranchListResponse> {
    const api = resolveGitLabApi(this.config, repoUrl);

    const response = await fetch(
      api.url(`projects/${api.encodedPath}/repository/branches`, {
        per_page: '100',
      }),
      { headers: { 'PRIVATE-TOKEN': api.token } },
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    // The branches endpoint already embeds each branch's tip commit, so the
    // commit detail costs no extra request.
    const branches: any[] = await response.json();

    return {
      branches: branches.map(branch => ({
        name: branch.name,
        isDefault: !!branch.default,
        commit: mapBranchCommit(branch.commit),
      })),
      defaultBranch: branches.find(branch => branch.default)?.name ?? null,
    };
  }

  async setTargetRevision(namespace: string, name: string, targetRevision: string): Promise<void> {
    const kc = this.getKubeConfig();
    const objectApi = k8s.KubernetesObjectApi.makeApiClient(kc);

    const patch = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'ApplicationSet',
      metadata: { name, namespace },
      spec: {
        template: {
          spec: {
            source: { targetRevision },
          },
        },
      },
    } as k8s.KubernetesObject;

    try {
      await objectApi.patch(
        patch,
        undefined, // pretty
        undefined, // dryRun
        undefined, // fieldManager
        undefined, // force
        k8s.PatchStrategy.MergePatch,
      );
    } catch (error) {
      this.logger.error(`Failed to set targetRevision for ${namespace}/${name}: ${error}`);
      throw error;
    }
  }

  private mapApplicationSet(
    item: any,
    apps: ApplicationInfo[],
  ): ApplicationSetResponse {
    const metadata = item.metadata ?? {};
    const spec = item.spec ?? {};
    const status = item.status ?? {};

    const generators: string[] = (spec.generators ?? []).map(
      (gen: Record<string, unknown>) => Object.keys(gen)[0] ?? 'unknown',
    );

    const targetRevisions: string[] = this.extractTargetRevisions(spec);
    const resources: any[] = status.resources ?? [];
    const applicationCount: number = resources.length;
    const syncedCount: number = resources.filter(
      (r: any) => r.status === 'Synced',
    ).length;
    const applications: string[] = resources
      .map((r: any) => r.name as string)
      .filter(Boolean)
      .sort();
    const syncedApplications: string[] = resources
      .filter((r: any) => r.status === 'Synced' && r.name)
      .map((r: any) => r.name as string);
    const applicationStatuses: Record<string, string> = {};
    for (const r of resources) {
      if (r.name) {
        applicationStatuses[r.name as string] = (r.status as string) ?? 'Unknown';
      }
    }

    // Go template expressions (e.g. {{.branch}}) are resolved dynamically by ArgoCD
    const isDynamic = (rev: string) => /\{\{.*\}\}/.test(rev);

    const isHeadRevision = targetRevisions.length === 0 || targetRevisions.every(
      rev => rev === 'HEAD' || rev === '' || isDynamic(rev),
    );

    const annotations = metadata.annotations ?? {};
    const muted = annotations[MUTE_ANNOTATION] === 'true';

    const repoUrl = this.extractRepoUrl(spec);
    const repoName = this.deriveRepoName(repoUrl);

    const applicationInfos: Record<string, ApplicationInfo> = {};
    for (const app of apps) {
      if (app.name) {
        applicationInfos[app.name] = app;
      }
    }
    const charts = [...new Set(apps.map(a => a.chart).filter((c): c is string => !!c))].sort();
    const chartVersions = [
      ...new Set(apps.map(a => a.chartVersion).filter((v): v is string => !!v)),
    ].sort();

    return {
      name: metadata.name ?? '',
      namespace: metadata.namespace ?? '',
      generators,
      applicationCount,
      syncedCount,
      applications,
      syncedApplications,
      applicationStatuses,
      applicationInfos,
      charts,
      chartVersions,
      repoUrl,
      repoName,
      targetRevisions: targetRevisions.length > 0 ? targetRevisions : ['HEAD'],
      isHeadRevision,
      muted,
      createdAt: metadata.creationTimestamp ?? '',
    };
  }

  private extractTargetRevisions(spec: any): string[] {
    const revisions: string[] = [];

    const templateRevision = spec.template?.spec?.source?.targetRevision;
    if (templateRevision) {
      revisions.push(templateRevision);
    }

    const templateSources = spec.template?.spec?.sources ?? [];
    for (const source of templateSources) {
      if (source.targetRevision) {
        revisions.push(source.targetRevision);
      }
    }

    for (const gen of spec.generators ?? []) {
      if (gen.git?.template?.spec?.source?.targetRevision) {
        revisions.push(gen.git.template.spec.source.targetRevision);
      }
    }

    return [...new Set(revisions)];
  }

  private extractRepoUrl(spec: any): string {
    // Single source
    const singleSource = spec.template?.spec?.source?.repoURL;
    if (singleSource) return singleSource;

    // Multi-source: return the first repoURL found
    const sources = spec.template?.spec?.sources ?? [];
    for (const source of sources) {
      if (source.repoURL) return source.repoURL;
    }

    return '';
  }

  private deriveRepoName(repoUrl: string): string {
    if (!repoUrl) return '';
    try {
      const pathname = new URL(repoUrl).pathname;
      // Remove leading slash and trailing .git
      return pathname.replace(/^\//, '').replace(/\.git$/, '');
    } catch {
      // Fallback for non-URL formats (e.g. SSH)
      const match = repoUrl.match(/:(.+?)(?:\.git)?$/);
      return match?.[1] ?? repoUrl;
    }
  }
}
