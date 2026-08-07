import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { SonarQubeAnnotationProcessor } from './SonarQubeAnnotationProcessor';

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
