import {
  ScmIntegrationsApi,
  scmIntegrationsApiRef,
  ScmAuth,
} from '@backstage/integration-react';
import {
  ApiRef,
  AnyApiFactory,
  configApiRef,
  createApiFactory,
  createApiRef,
  discoveryApiRef,
  identityApiRef,
  oauthRequestApiRef,
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
  storageApiRef,
} from '@backstage/core-plugin-api';
import { OAuth2 } from '@backstage/core-app-api';
import {
  visitsApiRef,
  VisitsStorageApi,
} from '@backstage/plugin-home';

/**
 * Keycloak OIDC Authentication API Reference
 */
export const keycloakOIDCAuthApiRef: ApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
> = createApiRef({
  id: 'auth.keycloak',
});

export const apis: AnyApiFactory[] = [
  createApiFactory({
    api: scmIntegrationsApiRef,
    deps: { configApi: configApiRef },
    factory: ({ configApi }) => ScmIntegrationsApi.fromConfig(configApi),
  }),
  ScmAuth.createDefaultApiFactory(),
  // Keycloak OIDC Authentication
  createApiFactory({
    api: keycloakOIDCAuthApiRef,
    deps: {
      discoveryApi: discoveryApiRef,
      oauthRequestApi: oauthRequestApiRef,
      configApi: configApiRef,
    },
    factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
      OAuth2.create({
        configApi,
        discoveryApi,
        oauthRequestApi,
        provider: {
          id: 'oidc',
          title: 'Keycloak',
          icon: () => null,
        },
        defaultScopes: ['openid', 'profile', 'email'],
      }),
  }),
  createApiFactory({
    api: visitsApiRef,
    deps: {
      storageApi: storageApiRef,
      identityApi: identityApiRef,
    },
    factory: ({ storageApi, identityApi }) =>
      VisitsStorageApi.create({ storageApi, identityApi }),
  }),
];
