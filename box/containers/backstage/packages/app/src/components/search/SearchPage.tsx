import React from 'react';
import { Grid, Paper } from '@material-ui/core';
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
      <Grid container direction="row">
        <Grid item xs={12}>
          <Paper style={{ padding: '16px' }}>
            <SearchBar />
          </Paper>
        </Grid>
        <Grid item xs={3}>
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
        </Grid>
        <Grid item xs={9}>
          <SearchPagination />
          <SearchResult>
            <CatalogSearchResultListItem icon={<CatalogIcon />} />
            <TechDocsSearchResultListItem icon={<DocsIcon />} />
          </SearchResult>
        </Grid>
      </Grid>
    </Content>
  </Page>
);
