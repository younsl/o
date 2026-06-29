import {
  OpenSearchClient,
  ListDomainNamesCommand,
  ListInstanceTypeDetailsCommand,
  DescribeDomainCommand,
  DescribeDomainsCommand,
  DescribeDomainConfigCommand,
  DescribeDomainChangeProgressCommand,
  UpdateDomainConfigCommand,
} from '@aws-sdk/client-opensearch';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { Config } from '@backstage/config';
import { LoggerService } from '@backstage/backend-plugin-api';

export interface DomainConfigSummary {
  name: string;
  instanceType: string | null;
  instanceCount: number | null;
  volumeSizeGb: number | null;
  /** Engine version (e.g. "OpenSearch_2.13"), needed to list valid instance types. */
  engineVersion: string | null;
  /** Domain-level config change is running (blue/green deployment). */
  processing: boolean;
  /** A version (engine) upgrade is running. */
  upgradeProcessing: boolean;
}

export interface ScalingTarget {
  instanceType: string;
  instanceCount: number;
  volumeSizeGb: number;
}

export interface DomainSummary {
  name: string;
  engineVersion: string | null;
}

// DescribeDomains accepts at most 5 domain names per call.
const DESCRIBE_DOMAINS_CHUNK = 5;

const ROLE_SESSION_NAME = 'backstage-opensearch-scaling';

/**
 * Thin wrapper over the AWS OpenSearch Service control-plane API. Mirrors the
 * AssumeRole credential-refresh pattern used by IamUserService (5-minute buffer).
 */
export class OpenSearchServiceClient {
  private client: OpenSearchClient;
  private credentialExpiry: Date | null = null;

  private constructor(
    private readonly config: Config,
    private readonly logger: LoggerService,
    private readonly region: string,
  ) {
    this.client = new OpenSearchClient({ region });
  }

  static fromConfig(
    config: Config,
    logger: LoggerService,
  ): OpenSearchServiceClient {
    const region =
      config.getOptionalString('opensearchScaling.region') ?? 'us-east-1';
    return new OpenSearchServiceClient(config, logger, region);
  }

  private async refreshClient(): Promise<void> {
    const assumeRoleArn = this.config.getOptionalString(
      'opensearchScaling.assumeRoleArn',
    );
    if (!assumeRoleArn) {
      this.logger.debug('No assumeRoleArn configured, using default credentials');
      return;
    }

    // Reuse credentials if not yet expired (5 min buffer).
    if (
      this.credentialExpiry &&
      this.credentialExpiry.getTime() - Date.now() > 5 * 60 * 1000
    ) {
      return;
    }

    this.logger.info(`Assuming role: ${assumeRoleArn}`);
    const sts = new STSClient({ region: this.region });
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: assumeRoleArn,
        RoleSessionName: ROLE_SESSION_NAME,
        DurationSeconds: 3600,
      }),
    );
    const creds = response.Credentials!;
    this.client = new OpenSearchClient({
      region: this.region,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken!,
      },
    });
    this.credentialExpiry = creds.Expiration ?? null;
    this.logger.info(
      `Assumed role ${assumeRoleArn} (expires ${this.credentialExpiry?.toISOString()})`,
    );
  }

  async listDomains(): Promise<DomainSummary[]> {
    await this.refreshClient();
    const res = await this.client.send(new ListDomainNamesCommand({}));
    const names = (res.DomainNames ?? [])
      .map(d => d.DomainName!)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return [];

    // Resolve engine versions in batches (DescribeDomains caps at 5 names).
    const versions = new Map<string, string | null>();
    for (let i = 0; i < names.length; i += DESCRIBE_DOMAINS_CHUNK) {
      const chunk = names.slice(i, i + DESCRIBE_DOMAINS_CHUNK);
      try {
        const detail = await this.client.send(
          new DescribeDomainsCommand({ DomainNames: chunk }),
        );
        for (const d of detail.DomainStatusList ?? []) {
          if (d.DomainName) versions.set(d.DomainName, d.EngineVersion ?? null);
        }
      } catch (e) {
        this.logger.debug(`DescribeDomains failed for [${chunk}]: ${e}`);
      }
    }
    return names.map(name => ({
      name,
      engineVersion: versions.get(name) ?? null,
    }));
  }

  /**
   * Current data-node cluster config plus the two "change running" flags.
   * Reads DescribeDomain (status flags) and DescribeDomainConfig (live values).
   */
  async describeDomain(name: string): Promise<DomainConfigSummary> {
    await this.refreshClient();
    const [domain, domainConfig] = await Promise.all([
      this.client.send(new DescribeDomainCommand({ DomainName: name })),
      this.client.send(new DescribeDomainConfigCommand({ DomainName: name })),
    ]);

    const status = domain.DomainStatus;
    const cluster = domainConfig.DomainConfig?.ClusterConfig?.Options;
    const ebs = domainConfig.DomainConfig?.EBSOptions?.Options;

    return {
      name,
      instanceType: cluster?.InstanceType ?? status?.ClusterConfig?.InstanceType ?? null,
      instanceCount:
        cluster?.InstanceCount ?? status?.ClusterConfig?.InstanceCount ?? null,
      volumeSizeGb: ebs?.VolumeSize ?? status?.EBSOptions?.VolumeSize ?? null,
      engineVersion: status?.EngineVersion ?? null,
      processing: Boolean(status?.Processing),
      upgradeProcessing: Boolean(status?.UpgradeProcessing),
    };
  }

  /**
   * Valid data-node instance types for the given engine version (and domain),
   * fetched from the OpenSearch Service API instead of a hardcoded list.
   * Pages through results and keeps types eligible for the data role.
   */
  async listInstanceTypes(
    engineVersion: string,
    domainName?: string,
  ): Promise<string[]> {
    await this.refreshClient();
    const types = new Set<string>();
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListInstanceTypeDetailsCommand({
          EngineVersion: engineVersion,
          DomainName: domainName,
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      for (const detail of res.InstanceTypeDetails ?? []) {
        if (!detail.InstanceType) continue;
        // InstanceRole lists eligible roles (data/master/ultrawarm). Keep
        // data-eligible types; include when role info is absent.
        const roles = detail.InstanceRole;
        if (!roles || roles.length === 0 || roles.includes('data')) {
          types.add(detail.InstanceType);
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Core pre-validation: true when a config change or version upgrade is in
   * flight, in which case a new UpdateDomainConfig would be rejected by AWS.
   */
  async isChangeInProgress(name: string): Promise<boolean> {
    const summary = await this.describeDomain(name);
    if (summary.processing || summary.upgradeProcessing) return true;

    // Defense in depth: DescribeDomainChangeProgress reflects an active change.
    try {
      const res = await this.client.send(
        new DescribeDomainChangeProgressCommand({ DomainName: name }),
      );
      const s = res.ChangeProgressStatus?.Status;
      return s === 'PENDING' || s === 'PROCESSING';
    } catch (e) {
      // No active change ID -> AWS may return an error; treat as not-in-progress.
      this.logger.debug(`change-progress check for '${name}': ${e}`);
      return false;
    }
  }

  async updateScaling(name: string, target: ScalingTarget): Promise<void> {
    await this.refreshClient();
    await this.client.send(
      new UpdateDomainConfigCommand({
        DomainName: name,
        ClusterConfig: {
          InstanceType: target.instanceType as any,
          InstanceCount: target.instanceCount,
        },
        EBSOptions: {
          EBSEnabled: true,
          VolumeSize: target.volumeSizeGb,
        },
      }),
    );
    this.logger.info(
      `Submitted scaling for '${name}': ${target.instanceType} x${target.instanceCount}, ${target.volumeSizeGb}GB`,
    );
  }

  /**
   * Dry-run the scaling change so AWS reports how it would be applied without
   * touching the domain. DeploymentType is "Blue/Green", "DynamicUpdate",
   * "None", or "Undetermined".
   */
  async dryRunScaling(
    name: string,
    target: ScalingTarget,
  ): Promise<{ deploymentType: string | null; message: string | null }> {
    await this.refreshClient();
    const res = await this.client.send(
      new UpdateDomainConfigCommand({
        DomainName: name,
        DryRun: true,
        DryRunMode: 'Basic',
        ClusterConfig: {
          InstanceType: target.instanceType as any,
          InstanceCount: target.instanceCount,
        },
        EBSOptions: {
          EBSEnabled: true,
          VolumeSize: target.volumeSizeGb,
        },
      }),
    );
    return {
      deploymentType: res.DryRunResults?.DeploymentType ?? null,
      message: res.DryRunResults?.Message ?? null,
    };
  }
}
