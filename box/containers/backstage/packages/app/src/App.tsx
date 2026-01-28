/**
 * Backstage Frontend Application
 *
 * Features:
 * - Catalog with entity pages
 * - API Docs for viewing OpenAPI/AsyncAPI/GraphQL specs
 * - TechDocs for documentation
 * - Search functionality
 * - Scaffolder for templates
 */

import React from 'react';
import { Route } from 'react-router-dom';
import { apiDocsPlugin, ApiExplorerPage } from '@backstage/plugin-api-docs';
import {
  CatalogEntityPage,
  CatalogIndexPage,
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
import { UserSettingsPage } from '@backstage/plugin-user-settings';
import { apis, keycloakOIDCAuthApiRef } from './apis';
import { entityPage } from './components/catalog/EntityPage';
import { searchPage } from './components/search/SearchPage';
import { Root } from './components/Root';
import { CreatePage } from './components/create/CreatePage';
import { HomePage } from './components/home/HomePage';

import {
  AlertDisplay,
  OAuthRequestDialog,
  SignInPage,
} from '@backstage/core-components';
import { createApp } from '@backstage/app-defaults';
import { AppRouter, FlatRoutes } from '@backstage/core-app-api';
import { CatalogGraphPage } from '@backstage/plugin-catalog-graph';
import {
  UnifiedThemeProvider,
  themes as builtinThemes,
} from '@backstage/theme';
import { OpenApiRegistryPage } from '@internal/plugin-openapi-registry';

const CustomSignInPage = (props: React.ComponentProps<typeof SignInPage>) => (
  <SignInPage
    {...props}
    providers={[
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
    {
      id: 'light',
      title: 'Light',
      variant: 'light',
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={builtinThemes.light} children={children} />
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
    <Route path="/catalog" element={<CatalogIndexPage />} />
    <Route
      path="/catalog/:namespace/:kind/:name"
      element={<CatalogEntityPage />}
    >
      {entityPage}
    </Route>
    <Route path="/api-docs" element={<ApiExplorerPage />} />
    <Route path="/docs" element={<TechDocsIndexPage />} />
    <Route
      path="/docs/:namespace/:kind/:name/*"
      element={<TechDocsReaderPage />}
    />
    <Route path="/create" element={<CreatePage />} />
    <Route path="/create/templates" element={<ScaffolderPage />} />
    <Route path="/search" element={<SearchPage />}>
      {searchPage}
    </Route>
    <Route path="/catalog-import" element={<CatalogImportPage />} />
    <Route path="/catalog-graph" element={<CatalogGraphPage />} />
    <Route path="/openapi-registry" element={<OpenApiRegistryPage />} />
    <Route path="/settings" element={<UserSettingsPage />} />
  </FlatRoutes>
);

export default app.createRoot(
  <>
    <AlertDisplay />
    <OAuthRequestDialog />
    <AppRouter>
      <Root>{routes}</Root>
    </AppRouter>
  </>,
);
