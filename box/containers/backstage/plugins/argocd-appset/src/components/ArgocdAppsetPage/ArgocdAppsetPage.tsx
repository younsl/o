import React from 'react';
import { Header, Page, Content } from '@backstage/core-components';
import { ApplicationSetTable } from '../ApplicationSetTable';

export const ArgocdAppsetPage = () => {
  return (
    <Page themeId="tool">
      <Header
        title="ArgoCD ApplicationSets"
        subtitle="View ApplicationSet resources from the Kubernetes cluster"
      />
      <Content>
        <ApplicationSetTable />
      </Content>
    </Page>
  );
};
