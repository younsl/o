import {
  CatalogProcessor,
  CatalogProcessorEmit,
} from '@backstage/plugin-catalog-node';
import { Entity } from '@backstage/catalog-model';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import { RootConfigService } from '@backstage/backend-plugin-api';

const SONARQUBE_PROJECT_KEY = 'sonarqube.org/project-key';
const SONARQUBE_PROJECT_KEY_SOURCE = 'sonarqube.org/project-key-source';
const SONARQUBE_BASE_URL = 'sonarqube.org/base-url';
const SONARQUBE_BASE_URL_SOURCE = 'sonarqube.org/base-url-source';

/**
 * Processor that automatically adds sonarqube.org/project-key annotation
 * based on the entity's GitLab project slug or entity name.
 *
 * Adds source annotations to indicate how values were set:
 * - 'auto-injected': Automatically injected by this processor
 * - 'manual': Manually specified in catalog-info.yaml
 */
export class SonarQubeAnnotationProcessor implements CatalogProcessor {
  private readonly baseUrl: string | undefined;

  constructor(config: RootConfigService) {
    this.baseUrl = config.getOptionalString('sonarqube.baseUrl');
  }

  getProcessorName(): string {
    return 'SonarQubeAnnotationProcessor';
  }

  async preProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    // Only process Component entities
    if (entity.kind !== 'Component') {
      return entity;
    }

    const existingProjectKey = entity.metadata.annotations?.[SONARQUBE_PROJECT_KEY];

    // If project key already exists (manually specified), mark as manual and add base-url
    if (existingProjectKey) {
      const hasSourceAnnotation = !!entity.metadata.annotations?.[SONARQUBE_PROJECT_KEY_SOURCE];
      const existingBaseUrl = entity.metadata.annotations?.[SONARQUBE_BASE_URL];
      const hasBaseUrlSourceAnnotation = !!entity.metadata.annotations?.[SONARQUBE_BASE_URL_SOURCE];

      // Determine base-url source: manual if entity has it, auto-injected if from config
      const baseUrlSource = existingBaseUrl ? 'manual' : 'auto-injected';
      const finalBaseUrl = existingBaseUrl || this.baseUrl;

      // Skip if all annotations already exist
      if (hasSourceAnnotation && hasBaseUrlSourceAnnotation) {
        return entity;
      }

      return {
        ...entity,
        metadata: {
          ...entity.metadata,
          annotations: {
            ...entity.metadata.annotations,
            [SONARQUBE_PROJECT_KEY_SOURCE]: 'manual',
            ...(finalBaseUrl && { [SONARQUBE_BASE_URL]: finalBaseUrl }),
            ...(finalBaseUrl && { [SONARQUBE_BASE_URL_SOURCE]: baseUrlSource }),
          },
        },
      };
    }

    // Try to get project key from GitLab slug or fall back to entity name
    const gitlabSlug = entity.metadata.annotations?.['gitlab.com/project-slug'];
    const projectKey = gitlabSlug
      ? (gitlabSlug.split('/').pop() ?? entity.metadata.name) // Get repo name from "group/subgroup/repo"
      : entity.metadata.name;

    return {
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: {
          ...entity.metadata.annotations,
          [SONARQUBE_PROJECT_KEY]: projectKey,
          [SONARQUBE_PROJECT_KEY_SOURCE]: 'auto-injected',
          ...(this.baseUrl && { [SONARQUBE_BASE_URL]: this.baseUrl }),
          ...(this.baseUrl && { [SONARQUBE_BASE_URL_SOURCE]: 'auto-injected' }),
        },
      },
    };
  }
}
