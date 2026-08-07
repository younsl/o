import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import { GitlabProject, GitlabBranch, CoverageResponse, GroupCoverage, SubmitCatalogInfoRequest, SubmitCatalogInfoResponse } from './types';
import { CoverageHistoryStore } from './CoverageHistoryStore';

export class CatalogHealthService {
  private readonly config: Config;
  private readonly logger: LoggerService;
  private readonly historyStore?: CoverageHistoryStore;
  private projects: GitlabProject[] = [];
  private lastScannedAt: string | null = null;
  private scanning = false;

  constructor(options: { config: Config; logger: LoggerService; historyStore?: CoverageHistoryStore }) {
    this.config = options.config;
    this.logger = options.logger;
    this.historyStore = options.historyStore;
  }

  private getGitlabConfig(): { apiBaseUrl: string; token: string; host: string } {
    const gitlabConfigs = this.config.getOptionalConfigArray('integrations.gitlab') ?? [];
    if (gitlabConfigs.length === 0) {
      throw new Error('No GitLab integration configured in integrations.gitlab');
    }

    const cfg = gitlabConfigs[0];
    const host = cfg.getString('host');
    const token = cfg.getString('token');
    const apiBaseUrl = cfg.getOptionalString('apiBaseUrl') ?? `https://${host}/api/v4`;

    return { apiBaseUrl, token, host };
  }

  async scan(): Promise<void> {
    if (this.scanning) {
      this.logger.info('Scan already in progress, skipping');
      return;
    }

    this.scanning = true;
    this.logger.info('Starting GitLab catalog-info.yaml coverage scan');

    try {
      const { apiBaseUrl, token } = this.getGitlabConfig();
      const allProjects = await this.fetchAllProjects(apiBaseUrl, token);

      this.logger.info(`Found ${allProjects.length} projects, checking catalog-info.yaml`);

      const concurrency = this.config.getOptionalNumber('catalogHealth.concurrency') ?? 10;
      const results: GitlabProject[] = [];

      for (let i = 0; i < allProjects.length; i += concurrency) {
        const batch = allProjects.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(project => this.checkCatalogInfo(apiBaseUrl, token, project)),
        );
        results.push(...batchResults);
      }

      this.projects = results;
      this.lastScannedAt = new Date().toISOString();

      // Save coverage snapshot for trend tracking
      if (this.historyStore) {
        const ignoreTopic = CatalogHealthService.IGNORE_TOPIC;
        const activeProjects = results.filter(p => !p.topics.includes(ignoreTopic));
        const registered = activeProjects.filter(p => p.hasCatalogInfo).length;
        const ignored = results.filter(p => p.topics.includes(ignoreTopic)).length;
        const total = activeProjects.length;
        const percent = total > 0 ? Math.round((registered / total) * 100) : 0;
        await this.historyStore.addSnapshot({ total, registered, ignored, percent });
      }

      this.logger.info(
        `Scan complete: ${results.filter(p => p.hasCatalogInfo).length}/${results.length} projects have catalog-info.yaml`,
      );
    } catch (error) {
      this.logger.error(`Scan failed: ${error}`);
      throw error;
    } finally {
      this.scanning = false;
    }
  }

  private async fetchAllProjects(
    apiBaseUrl: string,
    token: string,
  ): Promise<Array<{ id: number; name: string; path_with_namespace: string; web_url: string; default_branch: string | null; namespace: { full_path: string }; topics: string[]; last_activity_at: string; archived: boolean }>> {
    const projects: Array<any> = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const url = `${apiBaseUrl}/projects?per_page=${perPage}&page=${page}&simple=true&membership=false&order_by=id&sort=asc`;
      const response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': token },
      });

      if (!response.ok) {
        throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) break;

      projects.push(...data);

      const totalPages = parseInt(response.headers.get('x-total-pages') ?? '1', 10);
      if (page >= totalPages) break;
      page++;
    }

    return projects;
  }

  private async checkCatalogInfo(
    apiBaseUrl: string,
    token: string,
    project: any,
  ): Promise<GitlabProject> {
    const defaultBranch = project.default_branch;
    let hasCatalogInfo = false;
    let catalogInfoContent: string | null = null;

    if (defaultBranch) {
      try {
        const encodedPath = encodeURIComponent('catalog-info.yaml');
        const url = `${apiBaseUrl}/projects/${project.id}/repository/files/${encodedPath}?ref=${encodeURIComponent(defaultBranch)}`;
        const response = await fetch(url, {
          headers: { 'PRIVATE-TOKEN': token },
        });
        if (response.ok) {
          hasCatalogInfo = true;
          const data = await response.json() as { content: string; encoding: string };
          if (data.encoding === 'base64' && data.content) {
            catalogInfoContent = Buffer.from(data.content, 'base64').toString('utf-8');
          }
        }
      } catch {
        // File doesn't exist or error
      }
    }

    // Fetch members with Owner role (access_level = 50)
    let owners: string[] = [];
    try {
      const membersUrl = `${apiBaseUrl}/projects/${project.id}/members?per_page=100`;
      const membersRes = await fetch(membersUrl, {
        headers: { 'PRIVATE-TOKEN': token },
      });
      if (membersRes.ok) {
        const members = await membersRes.json() as Array<{ username: string; access_level: number }>;
        owners = members.filter(m => m.access_level === 50).map(m => m.username);
      }
    } catch {
      // ignore
    }

    return {
      id: project.id,
      name: project.name,
      pathWithNamespace: project.path_with_namespace,
      webUrl: project.web_url,
      defaultBranch,
      namespace: project.namespace?.full_path ?? '',
      hasCatalogInfo,
      catalogInfoContent,
      owners,
      topics: Array.isArray(project.topics) ? project.topics : [],
      lastActivityAt: project.last_activity_at,
      archived: project.archived ?? false,
    };
  }

  private static readonly IGNORE_TOPIC = 'backstage-ignore';

  getCoverage(): CoverageResponse {
    const activeProjects = this.projects.filter(p => !p.topics.includes(CatalogHealthService.IGNORE_TOPIC));
    const covered = activeProjects.filter(p => p.hasCatalogInfo).length;
    const total = activeProjects.length;

    let gitlabHost: string | null = null;
    try {
      const { host } = this.getGitlabConfig();
      gitlabHost = host;
    } catch {
      // no config
    }

    const scanCron = this.config.getOptionalString('catalogHealth.schedule.cron') ?? '0 */1 * * *';

    return {
      total,
      covered,
      uncovered: total - covered,
      percent: total > 0 ? Math.round((covered / total) * 100) : 0,
      projects: this.projects,
      lastScannedAt: this.lastScannedAt,
      scanning: this.scanning,
      gitlabHost,
      scanCron,
    };
  }

  getGroupCoverage(): GroupCoverage[] {
    const groups = new Map<string, { total: number; covered: number }>();

    for (const project of this.projects) {
      if (project.topics.includes(CatalogHealthService.IGNORE_TOPIC)) continue;
      const ns = project.namespace || '(root)';
      const entry = groups.get(ns) ?? { total: 0, covered: 0 };
      entry.total++;
      if (project.hasCatalogInfo) entry.covered++;
      groups.set(ns, entry);
    }

    return Array.from(groups.entries())
      .map(([namespace, { total, covered }]) => ({
        namespace,
        total,
        covered,
        percent: total > 0 ? Math.round((covered / total) * 100) : 0,
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));
  }

  async toggleIgnore(projectId: number): Promise<{ ignored: boolean }> {
    const { apiBaseUrl, token } = this.getGitlabConfig();
    const IGNORE_TOPIC = CatalogHealthService.IGNORE_TOPIC;

    // Fetch current topics
    const getRes = await fetch(`${apiBaseUrl}/projects/${projectId}`, {
      headers: { 'PRIVATE-TOKEN': token },
    });
    if (!getRes.ok) {
      throw new Error(`Failed to fetch project: ${getRes.status} ${getRes.statusText}`);
    }
    const project = await getRes.json() as { topics: string[] };
    const currentTopics: string[] = Array.isArray(project.topics) ? project.topics : [];

    const hasIgnore = currentTopics.includes(IGNORE_TOPIC);
    const newTopics = hasIgnore
      ? currentTopics.filter(t => t !== IGNORE_TOPIC)
      : [...currentTopics, IGNORE_TOPIC];

    const putRes = await fetch(`${apiBaseUrl}/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics: newTopics }),
    });
    if (!putRes.ok) {
      throw new Error(`Failed to update topics: ${putRes.status} ${putRes.statusText}`);
    }

    // Update local cache
    const cached = this.projects.find(p => p.id === projectId);
    if (cached) {
      cached.topics = newTopics;
    }

    const ignored = !hasIgnore;
    this.logger.info(`Project ${projectId} ${ignored ? 'ignored' : 'unignored'}`);
    return { ignored };
  }

  async getBranches(projectId: number): Promise<GitlabBranch[]> {
    const { apiBaseUrl, token } = this.getGitlabConfig();
    const branches: GitlabBranch[] = [];
    let page = 1;

    while (true) {
      const url = `${apiBaseUrl}/projects/${projectId}/repository/branches?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': token },
      });
      if (!response.ok) break;

      const data = await response.json() as Array<{ name: string; default: boolean }>;
      if (!Array.isArray(data) || data.length === 0) break;

      branches.push(...data.map(b => ({ name: b.name, default: b.default })));

      const totalPages = parseInt(response.headers.get('x-total-pages') ?? '1', 10);
      if (page >= totalPages) break;
      page++;
    }

    return branches;
  }

  async submitCatalogInfo(req: SubmitCatalogInfoRequest): Promise<SubmitCatalogInfoResponse> {
    const { apiBaseUrl, token } = this.getGitlabConfig();
    const { projectId, name, description, type, lifecycle, owner, tags, targetBranch } = req;

    const project = this.projects.find(p => p.id === projectId);
    const defaultBranch = targetBranch || project?.defaultBranch || 'main';
    const branchName = 'backstage/add-catalog-info';

    const lines = [
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      `  name: ${name}`,
      `  description: ${description}`,
    ];
    if (tags && tags.length > 0) {
      lines.push('  tags:');
      tags.forEach(t => lines.push(`    - ${t}`));
    }
    lines.push(
      'spec:',
      `  type: ${type}`,
      `  lifecycle: ${lifecycle}`,
      `  owner: ${owner}`,
      '',
    );
    const yaml = lines.join('\n');

    // 1. Create branch
    const branchRes = await fetch(`${apiBaseUrl}/projects/${projectId}/repository/branches`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: branchName, ref: defaultBranch }),
    });

    if (!branchRes.ok && branchRes.status !== 400) {
      throw new Error(`Failed to create branch: ${branchRes.status} ${branchRes.statusText}`);
    }

    // 2. Create file on branch
    const encodedPath = encodeURIComponent('catalog-info.yaml');
    const fileRes = await fetch(`${apiBaseUrl}/projects/${projectId}/repository/files/${encodedPath}`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: branchName,
        content: yaml,
        commit_message: 'Add catalog-info.yaml for Backstage',
      }),
    });

    if (!fileRes.ok) {
      if (fileRes.status === 400) {
        const updateRes = await fetch(`${apiBaseUrl}/projects/${projectId}/repository/files/${encodedPath}`, {
          method: 'PUT',
          headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branch: branchName,
            content: yaml,
            commit_message: 'Update catalog-info.yaml for Backstage',
          }),
        });
        if (!updateRes.ok) {
          throw new Error(`Failed to update file: ${updateRes.status} ${updateRes.statusText}`);
        }
      } else {
        throw new Error(`Failed to create file: ${fileRes.status} ${fileRes.statusText}`);
      }
    }

    // 3. Create merge request
    const mrRes = await fetch(`${apiBaseUrl}/projects/${projectId}/merge_requests`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_branch: branchName,
        target_branch: defaultBranch,
        title: 'Add catalog-info.yaml for Backstage',
        description: 'This MR adds a `catalog-info.yaml` file to register this repository in the Backstage software catalog.',
      }),
    });

    if (!mrRes.ok) {
      throw new Error(`Failed to create merge request: ${mrRes.status} ${mrRes.statusText}`);
    }

    const mrData = await mrRes.json() as { web_url: string };
    this.logger.info(`Created MR for project ${projectId}: ${mrData.web_url}`);

    return { mergeRequestUrl: mrData.web_url };
  }
}
