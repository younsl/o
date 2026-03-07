import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node/alpha';
import { SonarQubeAnnotationProcessor } from './SonarQubeAnnotationProcessor';

/**
 * Backend module that registers the SonarQubeAnnotationProcessor.
 * This processor automatically adds sonarqube.org/project-key annotation
 * to all Component entities based on their GitLab project slug or name.
 * Also adds sonarqube.org/base-url annotation from config.
 */
export const catalogModuleSonarQubeAnnotationProcessor = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'sonarqube-annotation-processor',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ catalog, config }) {
        catalog.addProcessor(new SonarQubeAnnotationProcessor(config));
      },
    });
  },
});
