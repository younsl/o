import React from 'react';
import { Route } from 'react-router-dom';
import { apiDocsPlugin } from '@backstage/plugin-api-docs';
import {
  CatalogEntityPage,
  catalogPlugin,
} from '@backstage/plugin-catalog';
import {
  CatalogImportPage,
  catalogImportPlugin,
} from '@backstage/plugin-catalog-import';
import { ScaffolderPage, scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { orgPlugin } from '@backstage/plugin-org';
import { SearchPage } from '@backstage/plugin-search';
import { TechDocsIndexPage, TechDocsReaderPage } from '@backstage/plugin-techdocs';
import {
  UserSettingsPage,
  SettingsLayout,
} from '@backstage/plugin-user-settings';
import { apis, keycloakOIDCAuthApiRef } from './apis';
import { entityPage } from './components/catalog/EntityPage';
import { searchPage } from './components/search/SearchPage';
import { Root } from './components/Root';
import { HomePage } from './components/home/HomePage';
import { PlatformsPage } from './components/platforms';
import { ApisPage } from './components/apis';
import { CatalogPage } from './components/catalog/CatalogPage';

import {
  AlertDisplay,
  OAuthRequestDialog,
  SignInPage,
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { FlatRoutes } from '@backstage/core-app-api';
import { CatalogGraphPage } from '@backstage/plugin-catalog-graph';
import {
  UnifiedThemeProvider,
  themes as builtinThemes,
} from '@backstage/theme';
import { OpenApiRegistryPage } from '@internal/plugin-openapi-registry';
import { ArgocdAppsetPage } from '@internal/plugin-argocd-appset';
import { IamUserAuditPage } from '@internal/plugin-iam-user-audit';
import { S3LogExtractPage } from '@internal/plugin-s3-log-extract';
import { CatalogHealthPage, GenerateCatalogInfoPage } from '@internal/plugin-catalog-health';
import { KafkaTopicPage } from '@internal/plugin-kafka-topic';
import { OpenCostPage } from '@internal/plugin-opencost';
import { BuiThemerPage } from '@backstage/plugin-mui-to-bui';
import { BuildInfoSettings } from './components/settings/AboutSettings';

const CustomSignInPage = (props: any) => (
  <SignInPage
    {...props}
    auto
    providers={[
      'guest',
      {
        id: 'keycloak',
        title: 'Keycloak',
        message: 'Sign in using Keycloak',
        apiRef: keycloakOIDCAuthApiRef,
      },
    ]}
  />
);

const app = createApp({
  apis,
  themes: [
    {
      id: 'dark',
      title: 'Dark',
      variant: 'dark',
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={builtinThemes.dark} children={children} />
      ),
    },
  ],
  components: {
    SignInPage: CustomSignInPage,
  },
  bindRoutes({ bind }) {
    bind(catalogPlugin.externalRoutes, {
      createComponent: scaffolderPlugin.routes.root,
      viewTechDoc: undefined,
      createFromTemplate: scaffolderPlugin.routes.selectedTemplate,
    });
    bind(apiDocsPlugin.externalRoutes, {
      registerApi: catalogImportPlugin.routes.importPage,
    });
    bind(scaffolderPlugin.externalRoutes, {
      registerComponent: catalogImportPlugin.routes.importPage,
      viewTechDoc: undefined,
    });
    bind(orgPlugin.externalRoutes, {
      catalogIndex: catalogPlugin.routes.catalogIndex,
    });
  },
});

const routes = (
  <FlatRoutes>
    <Route path="/" element={<HomePage />} />
    <Route path="/platforms" element={<PlatformsPage />} />
    <Route path="/catalog" element={<CatalogPage />} />
    <Route
      path="/catalog/:namespace/:kind/:name"
      element={<CatalogEntityPage />}
    >
      {entityPage}
    </Route>
    <Route path="/api-docs" element={<ApisPage />} />
    <Route path="/docs" element={<TechDocsIndexPage />} />
    <Route
      path="/docs/:namespace/:kind/:name/*"
      element={<TechDocsReaderPage />}
    />
    <Route path="/create" element={<ScaffolderPage />} />
    <Route path="/search" element={<SearchPage />}>
      {searchPage}
    </Route>
    <Route path="/catalog-import" element={<CatalogImportPage />} />
    <Route path="/catalog-graph" element={<CatalogGraphPage />} />
    <Route path="/openapi-registry" element={<OpenApiRegistryPage />} />
    <Route path="/argocd-appset/*" element={<ArgocdAppsetPage />} />
    <Route path="/iam-user-audit" element={<IamUserAuditPage />} />
    <Route path="/s3-log-extract" element={<S3LogExtractPage />} />
    <Route path="/kafka-topic/*" element={<KafkaTopicPage />} />
    <Route path="/catalog-health" element={<CatalogHealthPage />} />
    <Route path="/catalog-health/generate" element={<GenerateCatalogInfoPage />} />
    <Route path="/cost-report" element={<OpenCostPage />} />
    <Route path="/mui-to-bui" element={<BuiThemerPage />} />
    <Route path="/settings" element={<UserSettingsPage />}>
      <SettingsLayout.Route path="/build-info" title="Build Info">
        <BuildInfoSettings />
      </SettingsLayout.Route>
    </Route>
  </FlatRoutes>
);

const AppProvider = app.getProvider();
const AppRouter = app.getRouter();

export default function App() {
  return (
    <AppProvider>
      <AlertDisplay />
      <OAuthRequestDialog />
      <AppRouter>
        <Root>{routes}</Root>
      </AppRouter>
    </AppProvider>
  );
}
