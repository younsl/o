import * as k8s from '@kubernetes/client-node';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import { ApplicationSetResponse, MUTE_ANNOTATION } from './types';

export class ApplicationSetService {
  private readonly config: Config;
  private readonly logger: LoggerService;

  constructor(options: { config: Config; logger: LoggerService }) {
    this.config = options.config;
    this.logger = options.logger;
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

      return items.map(item => this.mapApplicationSet(item));
    } catch (error) {
      this.logger.error(`Failed to list ApplicationSets: ${error}`);
      throw error;
    }
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

  private mapApplicationSet(item: any): ApplicationSetResponse {
    const metadata = item.metadata ?? {};
    const spec = item.spec ?? {};
    const status = item.status ?? {};

    const generators: string[] = (spec.generators ?? []).map(
      (gen: Record<string, unknown>) => Object.keys(gen)[0] ?? 'unknown',
    );

    const targetRevisions: string[] = this.extractTargetRevisions(spec);
    const applicationCount: number = (status.resources ?? []).length;

    // Go template expressions (e.g. {{.branch}}) are resolved dynamically by ArgoCD
    const isDynamic = (rev: string) => /\{\{.*\}\}/.test(rev);

    const isHeadRevision = targetRevisions.length === 0 || targetRevisions.every(
      rev => rev === 'HEAD' || rev === '' || isDynamic(rev),
    );

    const annotations = metadata.annotations ?? {};
    const muted = annotations[MUTE_ANNOTATION] === 'true';

    const repoUrl = this.extractRepoUrl(spec);
    const repoName = this.deriveRepoName(repoUrl);

    return {
      name: metadata.name ?? '',
      namespace: metadata.namespace ?? '',
      generators,
      applicationCount,
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
