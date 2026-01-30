/**
 * Backstage Backend Entry Point
 *
 * This backend includes:
 * - GitLab catalog discovery (auto-discovers catalog-info.yaml files)
 * - GitLab org discovery (discovers users/groups from GitLab)
 * - GitLab CI/CD plugin (pipelines, MRs, releases)
 * - TechDocs for documentation
 * - Search functionality
 * - Scaffolder for templates
 *
 * Environment variables:
 * - DISABLE_GITLAB: Set to 'true' to disable GitLab integration (for local testing)
 */

import { createBackend } from '@backstage/backend-defaults';
import {
  gitlabPlugin,
  catalogPluginGitlabFillerProcessorModule,
} from '@immobiliarelabs/backstage-plugin-gitlab-backend';

const backend = createBackend();

// Check if GitLab should be disabled (for local development without GitLab access)
const disableGitlab = process.env.DISABLE_GITLAB === 'true';

// Core plugins
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// Auth plugins
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));

// Catalog plugins
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'));

// GitLab discovery plugins - auto-discovers catalog-info.yaml from GitLab repos
// Only load if GitLab is not explicitly disabled
if (!disableGitlab) {
  backend.add(import('@backstage/plugin-catalog-backend-module-gitlab'));
  backend.add(import('@backstage/plugin-catalog-backend-module-gitlab-org'));
}

// GitLab CI/CD plugin - pipelines, MRs, releases, etc.
// Provides API endpoints for the frontend GitLab plugin
if (!disableGitlab) {
  backend.add(gitlabPlugin);
  // Auto-fills gitlab.com/project-id and gitlab.com/project-slug annotations
  // for entities discovered from GitLab
  backend.add(catalogPluginGitlabFillerProcessorModule);
}

// Scaffolder for creating new components from templates
backend.add(import('@backstage/plugin-scaffolder-backend'));
if (!disableGitlab) {
  backend.add(import('@backstage/plugin-scaffolder-backend-module-gitlab'));
}

// TechDocs for documentation
backend.add(import('@backstage/plugin-techdocs-backend'));

// Search plugins
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));

// OpenAPI Registry plugin for registering external API specs
backend.add(import('@internal/plugin-openapi-registry-backend'));

backend.start();
