import { createBackend } from '@backstage/backend-defaults';
import {
  gitlabPlugin,
  catalogPluginGitlabFillerProcessorModule,
} from '@immobiliarelabs/backstage-plugin-gitlab-backend';
import { catalogModuleSonarQubeAnnotationProcessor } from './processors';
import { permissionModuleAdminPolicy } from './permissions-policy';

const backend = createBackend();

const disableGitlab = process.env.DISABLE_GITLAB === 'true';

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'));

if (!disableGitlab) {
  backend.add(import('@backstage/plugin-catalog-backend-module-gitlab'));
  backend.add(import('@backstage/plugin-catalog-backend-module-gitlab-org'));
}

if (!disableGitlab) {
  backend.add(gitlabPlugin);
  backend.add(catalogPluginGitlabFillerProcessorModule);
}

backend.add(catalogModuleSonarQubeAnnotationProcessor);

backend.add(import('@backstage/plugin-scaffolder-backend'));
if (!disableGitlab) {
  backend.add(import('@backstage/plugin-scaffolder-backend-module-gitlab'));
}

backend.add(import('@backstage/plugin-techdocs-backend'));

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));

backend.add(import('@internal/plugin-openapi-registry-backend'));

backend.add(import('@internal/plugin-argocd-appset-backend'));

backend.add(import('@internal/plugin-iam-user-audit-backend'));

backend.add(import('@internal/plugin-kafka-topic-backend'));

backend.add(import('@internal/plugin-s3-log-extract-backend'));

if (!disableGitlab) {
  backend.add(import('@internal/plugin-catalog-health-backend'));
}

backend.add(import('@internal/plugin-opencost-backend'));

backend.add(import('@internal/plugin-grafana-dashboard-map-backend'));

backend.add(import('@backstage-community/plugin-sonarqube-backend'));

backend.add(import('@backstage/plugin-permission-backend'));
backend.add(permissionModuleAdminPolicy);

backend.start();
