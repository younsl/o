import { Router } from 'express';
import express from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { Kafka, SASLOptions, ConfigResourceTypes, logLevel as KafkaLogLevel } from 'kafkajs';
import { TopicRequestStore } from './TopicRequestStore';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  httpAuth: HttpAuthService;
  store: TopicRequestStore;
}

interface TopicConfigEntry {
  numPartitions: number;
  replicationFactor: number;
  configEntries: Record<string, string>;
}

interface ClusterConfig {
  name: string;
  brokers: string[];
  tls: boolean;
  sasl?: SASLOptions;
  requiresApproval: boolean;
  topicConfig: Record<string, TopicConfigEntry>;
}

function readConfigEntries(tc: Config): Record<string, string> {
  const configEntries: Record<string, string> = {};
  const arr = tc.getOptionalConfigArray('configEntries');
  if (arr) {
    for (const entry of arr) {
      const name = entry.getString('name');
      const value = entry.getString('value');
      configEntries[name] = value;
    }
  }
  return configEntries;
}

function readClusters(config: Config, logger: LoggerService): ClusterConfig[] {
  const clusterConfig = config.getOptionalConfig('kafka.clusters');
  if (!clusterConfig) {
    logger.warn('No kafka.clusters config found');
    return [];
  }

  const clusters: ClusterConfig[] = [];

  for (const clusterName of clusterConfig.keys()) {
    try {
      const cluster = clusterConfig.getConfig(clusterName);
      const rawBrokers = cluster.getOptionalStringArray('brokers');
      const brokers = rawBrokers?.filter(b => b.trim() !== '') ?? [];
      if (brokers.length === 0) {
        continue;
      }

      const tls = cluster.getOptionalBoolean('tls') ?? false;
      const requiresApproval = cluster.getOptionalBoolean('requiresApproval') ?? false;

      const topicConfigSection = cluster.getOptionalConfig('topicConfig');
      const topicConfig: Record<string, TopicConfigEntry> = {};

      if (topicConfigSection) {
        for (const key of topicConfigSection.keys()) {
          const tc = topicConfigSection.getConfig(key);
          topicConfig[key] = {
            numPartitions: tc.getNumber('numPartitions'),
            replicationFactor: tc.getNumber('replicationFactor'),
            configEntries: readConfigEntries(tc),
          };
        }
      }

      clusters.push({ name: clusterName, brokers, tls, requiresApproval, topicConfig });
    } catch (e) {
      logger.warn(`Skipping kafka cluster '${clusterName}': ${e}`);
    }
  }

  return clusters;
}

/**
 * Auto-apply Kafka best practices to topic config entries.
 * - min.insync.replicas = replicationFactor - 1 (minimum 1)
 */
function applyBestPractices(tc: TopicConfigEntry): TopicConfigEntry {
  const entries = { ...tc.configEntries };
  if (!entries['min.insync.replicas']) {
    entries['min.insync.replicas'] = String(Math.max(1, tc.replicationFactor - 1));
  }
  return { ...tc, configEntries: entries };
}

function createKafkaClient(cluster: ClusterConfig, logger: LoggerService): Kafka {
  return new Kafka({
    clientId: 'backstage-kafka-topic',
    brokers: cluster.brokers,
    ssl: cluster.tls ? true : undefined,
    sasl: cluster.sasl,
    logLevel: KafkaLogLevel.WARN,
    logCreator: () => ({ namespace, level, log }) => {
      const msg = `[kafkajs:${namespace}] ${log.message}`;
      if (level <= KafkaLogLevel.ERROR) {
        logger.error(msg);
      } else if (level <= KafkaLogLevel.WARN) {
        logger.warn(msg);
      } else {
        logger.debug(msg);
      }
    },
  });
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { logger, config, httpAuth, store } = options;

  const admins = config.getOptionalStringArray('permission.admins') ?? [];
  const isDevMode =
    config.getOptionalBoolean('backend.auth.dangerouslyDisableDefaultAuthPolicy') ?? false;

  async function tryGetUserRef(
    req: express.Request,
  ): Promise<string | undefined> {
    try {
      const credentials = await httpAuth.credentials(req as any, {
        allow: ['user'],
      });
      return credentials.principal.userEntityRef;
    } catch {
      if (isDevMode) {
        return 'user:development/guest';
      }
      return undefined;
    }
  }

  function getClusters(): ClusterConfig[] {
    return readClusters(config, logger);
  }

  async function executeTopicCreation(
    cluster: ClusterConfig,
    topicName: string,
    tc: TopicConfigEntry,
    cleanupPolicy: string,
  ): Promise<void> {
    const finalConfigEntries = { ...tc.configEntries, 'cleanup.policy': cleanupPolicy };

    const kafka = createKafkaClient(cluster, logger);
    const admin = kafka.admin();
    await admin.connect();

    try {
      const existingTopics = await admin.listTopics();
      if (existingTopics.includes(topicName)) {
        throw Object.assign(new Error(`Topic '${topicName}' already exists`), { statusCode: 409 });
      }

      await admin.createTopics({
        topics: [
          {
            topic: topicName,
            numPartitions: tc.numPartitions,
            replicationFactor: tc.replicationFactor,
            configEntries: Object.entries(finalConfigEntries).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        ],
      });

      logger.info(`Created topic '${topicName}' in ${cluster.name} (cleanup: ${cleanupPolicy})`);
    } finally {
      await admin.disconnect();
    }
  }

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/user-role', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    res.json({ isAdmin: !!userRef && admins.includes(userRef), admins });
  });

  router.get('/clusters', (_, res) => {
    const clusterList = getClusters().map(c => {
      const topicConfig: Record<string, TopicConfigEntry> = {};
      for (const [key, tc] of Object.entries(c.topicConfig)) {
        topicConfig[key] = applyBestPractices(tc);
      }
      return { name: c.name, brokers: c.brokers, requiresApproval: c.requiresApproval, topicConfig };
    });
    res.json(clusterList);
  });

  router.get('/clusters/:cluster/metadata', async (req, res) => {
    const { cluster: clusterName } = req.params;
    const cluster = getClusters().find(c => c.name === clusterName);
    if (!cluster) {
      res.status(404).json({ error: `Cluster '${clusterName}' not found` });
      return;
    }

    try {
      const kafka = createKafkaClient(cluster, logger);
      const admin = kafka.admin();
      await admin.connect();

      try {
        const clusterInfo = await admin.describeCluster();

        let version: string | null = null;
        try {
          const brokerId = String(clusterInfo.controller ?? clusterInfo.brokers[0]?.nodeId ?? 0);
          const configs = await admin.describeConfigs({
            includeSynonyms: false,
            resources: [{
              type: ConfigResourceTypes.BROKER,
              name: brokerId,
              configNames: ['inter.broker.protocol.version'],
            }],
          });
          const entry = configs.resources[0]?.configEntries?.find(
            e => e.configName === 'inter.broker.protocol.version',
          );
          version = entry?.configValue ?? null;
        } catch {
          logger.debug(`Could not fetch broker version for ${clusterName}`);
        }

        const activeBrokerHosts = new Set(
          clusterInfo.brokers.map(b => `${b.host}:${b.port}`),
        );

        const brokers = cluster.brokers.map(addr => {
          const active = activeBrokerHosts.has(addr);
          const brokerInfo = clusterInfo.brokers.find(
            b => `${b.host}:${b.port}` === addr,
          );
          return {
            address: addr,
            status: active ? ('online' as const) : ('offline' as const),
            nodeId: brokerInfo?.nodeId ?? null,
            isController: brokerInfo?.nodeId != null && brokerInfo.nodeId === clusterInfo.controller,
          };
        });

        // Include any active brokers not in the configured list
        for (const b of clusterInfo.brokers) {
          const addr = `${b.host}:${b.port}`;
          if (!cluster.brokers.includes(addr)) {
            brokers.push({
              address: addr,
              status: 'online' as const,
              nodeId: b.nodeId,
              isController: b.nodeId === clusterInfo.controller,
            });
          }
        }

        res.json({
          clusterId: clusterInfo.clusterId,
          brokerCount: clusterInfo.brokers.length,
          controller: clusterInfo.controller,
          version,
          brokers,
        });
      } finally {
        await admin.disconnect();
      }
    } catch (error) {
      logger.error(`Failed to get metadata for ${clusterName}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/topics/:cluster', async (req, res) => {
    const { cluster: clusterName } = req.params;
    const cluster = getClusters().find(c => c.name === clusterName);
    if (!cluster) {
      res.status(404).json({ error: `Cluster '${clusterName}' not found` });
      return;
    }

    try {
      const kafka = createKafkaClient(cluster, logger);
      const admin = kafka.admin();
      await admin.connect();

      try {
        const topics = await admin.listTopics();
        const metadata = await admin.fetchTopicMetadata({ topics });

        let isrMap: Record<string, string> = {};
        try {
          const configs = await admin.describeConfigs({
            includeSynonyms: false,
            resources: topics.map(name => ({
              type: ConfigResourceTypes.TOPIC,
              name,
              configNames: ['min.insync.replicas'],
            })),
          });
          for (const resource of configs.resources) {
            const entry = resource.configEntries?.find(
              e => e.configName === 'min.insync.replicas',
            );
            if (entry) {
              isrMap[resource.resourceName] = entry.configValue;
            }
          }
        } catch {
          logger.debug(`Could not fetch topic configs for ${clusterName}`);
        }

        const result = metadata.topics.map(t => ({
          name: t.name,
          partitions: t.partitions.length,
          replicationFactor: t.partitions[0]?.replicas?.length ?? 0,
          minInsyncReplicas: isrMap[t.name] ?? null,
        }));

        result.sort((a, b) => a.name.localeCompare(b.name));
        res.json(result);
      } finally {
        await admin.disconnect();
      }
    } catch (error) {
      logger.error(`Failed to list topics for ${clusterName}: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/topics/:cluster', async (req, res) => {
    const { cluster: clusterName } = req.params;
    const { appName, eventName, action, trafficLevel, cleanupPolicy } = req.body ?? {};

    if (!appName || typeof appName !== 'string' || appName.trim() === '') {
      res.status(400).json({ error: 'appName is required' });
      return;
    }
    if (!eventName || typeof eventName !== 'string' || eventName.trim() === '') {
      res.status(400).json({ error: 'eventName is required' });
      return;
    }

    const cluster = getClusters().find(c => c.name === clusterName);
    if (!cluster) {
      res.status(404).json({ error: `Cluster '${clusterName}' not found` });
      return;
    }

    const parts = [appName.trim(), eventName.trim()];
    if (action && typeof action === 'string' && action.trim() !== '') {
      parts.push(action.trim());
    }
    const topicName = parts.join('-');

    const topicConfigKeys = Object.keys(cluster.topicConfig);
    const configKey = trafficLevel && cluster.topicConfig[trafficLevel]
      ? trafficLevel
      : topicConfigKeys[0];
    const rawTc = cluster.topicConfig[configKey];
    if (!rawTc) {
      res.status(400).json({ error: `No topic config found for '${configKey}'` });
      return;
    }
    const tc = applyBestPractices(rawTc);

    const finalCleanupPolicy = (typeof cleanupPolicy === 'string' && cleanupPolicy.trim() !== '')
      ? cleanupPolicy.trim()
      : 'delete';

    const requester = await tryGetUserRef(req) ?? 'unknown';

    // If cluster requires approval, store as pending request
    if (cluster.requiresApproval) {
      const request = await store.addRequest({
        cluster: clusterName,
        topicName,
        numPartitions: tc.numPartitions,
        replicationFactor: tc.replicationFactor,
        cleanupPolicy: finalCleanupPolicy,
        trafficLevel: configKey,
        configEntries: { ...tc.configEntries, 'cleanup.policy': finalCleanupPolicy },
        requester,
        reviewer: null,
        reason: null,
        status: 'pending',
      });

      logger.info(`Topic request '${topicName}' in ${clusterName} queued for approval by ${requester} (id: ${request.id})`);

      res.status(202).json({
        topicName,
        partitions: tc.numPartitions,
        replicationFactor: tc.replicationFactor,
        status: 'pending',
        requester,
      });
      return;
    }

    // Direct creation (no approval required)
    try {
      await executeTopicCreation(cluster, topicName, tc, finalCleanupPolicy);

      const request = await store.addRequest({
        cluster: clusterName,
        topicName,
        numPartitions: tc.numPartitions,
        replicationFactor: tc.replicationFactor,
        cleanupPolicy: finalCleanupPolicy,
        trafficLevel: configKey,
        configEntries: { ...tc.configEntries, 'cleanup.policy': finalCleanupPolicy },
        requester,
        reviewer: null,
        reason: null,
        status: 'created',
      });

      logger.info(`Created topic '${topicName}' in ${clusterName} by ${requester} (id: ${request.id})`);

      res.status(201).json({
        topicName,
        partitions: tc.numPartitions,
        replicationFactor: tc.replicationFactor,
        status: 'created',
        requester,
      });
    } catch (error: any) {
      const statusCode = error.statusCode ?? 500;
      logger.error(`Failed to create topic '${topicName}' in ${clusterName}: ${error}`);
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.get('/requests', async (_, res) => {
    const all = await store.listRequests();
    res.json(all);
  });

  router.get('/requests/:id', async (req, res) => {
    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(request);
  });

  router.post('/requests/:id/approve', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!userRef || !admins.includes(userRef)) {
      res.status(403).json({ error: 'Only admins can approve requests' });
      return;
    }

    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(400).json({ error: `Request already ${request.status}` });
      return;
    }

    const cluster = getClusters().find(c => c.name === request.cluster);
    if (!cluster) {
      res.status(404).json({ error: `Cluster '${request.cluster}' not found` });
      return;
    }

    try {
      const tc: TopicConfigEntry = {
        numPartitions: request.numPartitions,
        replicationFactor: request.replicationFactor,
        configEntries: { ...request.configEntries },
      };
      // Remove cleanup.policy from configEntries since executeTopicCreation adds it
      delete tc.configEntries['cleanup.policy'];

      await executeTopicCreation(cluster, request.topicName, tc, request.cleanupPolicy);

      const updated = await store.updateStatus(request.id, 'approved', {
        reviewer: userRef,
        reason: reason.trim(),
      });

      logger.info(`Approved and created topic '${request.topicName}' in ${request.cluster} by ${userRef}`);
      res.json(updated);
    } catch (error: any) {
      const statusCode = error.statusCode ?? 500;
      logger.error(`Failed to approve request ${request.id}: ${error}`);
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/requests/:id/reject', async (req, res) => {
    const userRef = await tryGetUserRef(req);
    if (!userRef || !admins.includes(userRef)) {
      res.status(403).json({ error: 'Only admins can reject requests' });
      return;
    }

    const { reason } = req.body ?? {};
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const request = await store.getRequest(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(400).json({ error: `Request already ${request.status}` });
      return;
    }

    const updated = await store.updateStatus(request.id, 'rejected', {
      reviewer: userRef,
      reason: reason.trim(),
    });

    logger.info(`Rejected topic request '${request.topicName}' in ${request.cluster} by ${userRef}`);
    res.json(updated);
  });

  return router;
}
