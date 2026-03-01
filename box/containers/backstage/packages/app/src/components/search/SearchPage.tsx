import React from 'react';
import { Grid, Box } from '@backstage/ui';
import { CatalogSearchResultListItem } from '@backstage/plugin-catalog';
import {
  catalogApiRef,
  CATALOG_FILTER_EXISTS,
} from '@backstage/plugin-catalog-react';
import { TechDocsSearchResultListItem } from '@backstage/plugin-techdocs';
import {
  SearchBar,
  SearchFilter,
  SearchResult,
  SearchPagination,
  useSearch,
} from '@backstage/plugin-search-react';
import {
  CatalogIcon,
  Content,
  DocsIcon,
  Header,
  Page,
} from '@backstage/core-components';

export const searchPage = (
  <Page themeId="home">
    <Header title="Search" />
    <Content>
      <Grid.Root columns="12">
        <Grid.Item colSpan="12">
          <Box p="3" style={{ borderRadius: 4, background: 'var(--bui-color-background-elevation-1)' }}>
            <SearchBar />
          </Box>
        </Grid.Item>
        <Grid.Item colSpan="3">
          <SearchFilter.Select
            label="Kind"
            name="kind"
            values={['Component', 'Template', 'API', 'Group', 'User', 'System', 'Domain']}
          />
          <SearchFilter.Checkbox
            label="Lifecycle"
            name="lifecycle"
            values={['experimental', 'production', 'deprecated']}
          />
        </Grid.Item>
        <Grid.Item colSpan="9">
          <SearchPagination />
          <SearchResult>
            <CatalogSearchResultListItem icon={<CatalogIcon />} />
            <TechDocsSearchResultListItem icon={<DocsIcon />} />
          </SearchResult>
        </Grid.Item>
      </Grid.Root>
    </Content>
  </Page>
);
