/**
 * Backstage Backend Entry Point
 *
 * This backend includes:
 * - GitLab catalog discovery (auto-discovers catalog-info.yaml files)
 * - GitLab org discovery (discovers users/groups from GitLab)
 * - TechDocs for documentation
 * - Search functionality
 * - Scaffolder for templates
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core plugins
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// Auth plugins
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// Catalog plugins
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'));

// GitLab discovery plugins - auto-discovers catalog-info.yaml from GitLab repos
backend.add(import('@backstage/plugin-catalog-backend-module-gitlab'));
backend.add(import('@backstage/plugin-catalog-backend-module-gitlab-org'));

// Scaffolder for creating new components from templates
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-gitlab'));

// TechDocs for documentation
backend.add(import('@backstage/plugin-techdocs-backend'));

// Search plugins
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));

backend.start();
