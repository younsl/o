export const MUTE_ANNOTATION = 'backstage.io/muted';

/**
 * Where a reported version was read from, so the UI can say why it shows what
 * it shows. A chart version comes from two very different places depending on
 * how the Application is sourced, and the numbers alone do not reveal which.
 */
export interface VersionOrigin {
  kind: 'helm-repository' | 'chart-yaml';
  /** The field or file the value was read from */
  location: string;
  /** Link to that file in the git host, anchored to the line, when it is one */
  url: string | null;
  /**
   * What was read, verbatim: the Chart.yaml exactly as the repository has it,
   * or the Application's own source block rendered as the equivalent YAML.
   */
  content: string;
  /**
   * 1-indexed lines of `content` the reported version was taken from, so a
   * reader can see which line in a file of several versions was the one used.
   */
  highlightLines: number[];
}

/**
 * Per-Application detail read from the Application CR that an ApplicationSet
 * generated. ApplicationSet `status.resources` only carries name and sync
 * status, so chart and app version require reading the Applications themselves.
 */
export interface ApplicationInfo {
  name: string;
  /** Chart name: from the Helm source, the chart directory, or the release */
  chart: string | null;
  /**
   * Upstream chart version: the pinned targetRevision for a Helm repository
   * source, or the wrapped dependency's version read from Chart.yaml.
   */
  chartVersion: string | null;
  /** Provenance of `chartVersion`, null when no version could be read */
  chartVersionOrigin: VersionOrigin | null;
  /** Name of the single upstream chart a wrapper depends on, if there is one */
  upstreamChart: string | null;
  /** Repository that chart is pulled from, needed to look up newer versions */
  upstreamRepository: string | null;
  /** Running app version, from the image tag or the Chart.yaml appVersion */
  appVersion: string | null;
  /**
   * Which of the two the app version came from. `image-tag` is the tag ArgoCD
   * reports in `status.summary.images`, so it is what is actually running.
   * `chart-yaml` is the wrapper chart's declared appVersion, used only when no
   * image could be matched, and can be stale.
   */
  appVersionSource: 'image-tag' | 'chart-yaml' | null;
  /** Full image references from `status.summary.images` */
  images: string[];
  syncStatus: string;
  healthStatus: string;
  /** Git SHA of the last synced revision */
  revision: string | null;
}

export interface ApplicationSetResponse {
  name: string;
  namespace: string;
  generators: string[];
  applicationCount: number;
  syncedCount: number;
  applications: string[];
  syncedApplications: string[];
  applicationStatuses: Record<string, string>;
  /** Keyed by application name. Empty when the Application CRs cannot be read. */
  applicationInfos: Record<string, ApplicationInfo>;
  /** Unique `chart` values across the generated Applications */
  charts: string[];
  /** Unique `chartVersion` values across the generated Applications */
  chartVersions: string[];
  repoUrl: string;
  repoName: string;
  targetRevisions: string[];
  isHeadRevision: boolean;
  muted: boolean;
  createdAt: string;
}

/** Tip commit of a branch, as the branch listing reports it */
export interface BranchCommit {
  /** Full SHA, which is what a reader copying it wants to paste */
  id: string;
  shortId: string;
  /** First line of the commit message */
  title: string;
  authorName: string;
  /** ISO timestamp, for rendering how long ago the commit landed */
  committedDate: string;
  webUrl: string | null;
}

export interface BranchInfo {
  name: string;
  isDefault: boolean;
  commit: BranchCommit | null;
}

export interface BranchListResponse {
  branches: BranchInfo[];
  defaultBranch: string | null;
}

export interface AuditLogEntry {
  id: string;
  seq: number;
  action: 'mute' | 'unmute' | 'set_target_revision';
  appsetNamespace: string;
  appsetName: string;
  userRef: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}
