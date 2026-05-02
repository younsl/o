import { Router } from 'express';
import express from 'express';
import { LoggerService, AuditorService } from '@backstage/backend-plugin-api';
import { OpenApiRegistryService } from './OpenApiRegistryService';
import { RegisterApiRequest } from './types';

export interface RouterOptions {
  service: OpenApiRegistryService;
  logger: LoggerService;
  auditor: AuditorService;
  baseUrl?: string;
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { service, logger, auditor } = options;

  const router = Router();
  router.use(express.json());

  // Health check
  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  // Serve entity YAML for catalog to fetch
  router.get('/entity/:name', async (req, res) => {
    const { name } = req.params;
    logger.info(`Entity YAML requested for: ${name}`);

    try {
      const entityYaml = await service.getEntityYaml(name);
      if (!entityYaml) {
        logger.warn(`Entity not found for name: ${name}`);
        res.status(404).send('Entity not found');
        return;
      }
      logger.info(`Serving entity YAML for: ${name}, length: ${entityYaml.length}`);
      logger.debug(`Entity YAML content:\n${entityYaml}`);
      res.setHeader('Content-Type', 'application/x-yaml');
      res.send(entityYaml);
    } catch (error) {
      logger.error(`Failed to get entity YAML for ${name}: ${error}`);
      res.status(500).send('Internal server error');
    }
  });

  // Preview an OpenAPI spec before registering
  router.post('/preview', async (req, res) => {
    const { specUrl } = req.body as { specUrl: string };

    if (!specUrl) {
      res.status(400).json({ error: 'specUrl is required' });
      return;
    }

    try {
      const result = await service.previewSpec(specUrl);
      res.json(result);
    } catch (error) {
      logger.error(`Failed to preview spec: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Register a new API
  router.post('/register', async (req, res) => {
    const request = req.body as RegisterApiRequest;

    if (!request.specUrl || !request.name || !request.owner || !request.lifecycle) {
      res.status(400).json({
        error: 'specUrl, name, owner, and lifecycle are required',
      });
      return;
    }

    const auditorEvent = await auditor.createEvent({
      eventId: 'api-register',
      request: req as any,
      severityLevel: 'medium',
      meta: {
        actionType: 'create',
        apiName: request.name,
        specUrl: request.specUrl,
        owner: request.owner,
      },
    });

    try {
      const registration = await service.registerApi(request);
      await auditorEvent.success({ meta: { registrationId: registration.id } });
      res.status(201).json(registration);
    } catch (error) {
      logger.error(`Failed to register API: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('already registered') || message.includes('already exists')) {
        res.status(409).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // List all registrations
  router.get('/registrations', async (_, res) => {
    try {
      const registrations = await service.listRegistrations();
      res.json(registrations);
    } catch (error) {
      logger.error(`Failed to list registrations: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get a single registration
  router.get('/registrations/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const registration = await service.getRegistration(id);
      if (!registration) {
        res.status(404).json({ error: 'Registration not found' });
        return;
      }
      res.json(registration);
    } catch (error) {
      logger.error(`Failed to get registration: ${error}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Refresh an API (re-fetch spec and update entity)
  router.post('/refresh/:id', async (req, res) => {
    const { id } = req.params;

    const auditorEvent = await auditor.createEvent({
      eventId: 'api-refresh',
      request: req as any,
      severityLevel: 'low',
      meta: {
        actionType: 'refresh',
        registrationId: id,
      },
    });

    try {
      const registration = await service.refreshApi(id);
      await auditorEvent.success();
      res.json(registration);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`Failed to refresh API: ${message}`, { stack });
      await auditorEvent.fail({ error: error as Error });
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message, details: stack });
      }
    }
  });

  // Delete a registration
  router.delete('/registrations/:id', async (req, res) => {
    const { id } = req.params;

    const auditorEvent = await auditor.createEvent({
      eventId: 'api-delete',
      request: req as any,
      severityLevel: 'medium',
      meta: {
        actionType: 'delete',
        registrationId: id,
      },
    });

    try {
      await service.deleteRegistration(id);
      await auditorEvent.success();
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to delete registration: ${error}`);
      await auditorEvent.fail({ error: error as Error });
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  return router;
}
