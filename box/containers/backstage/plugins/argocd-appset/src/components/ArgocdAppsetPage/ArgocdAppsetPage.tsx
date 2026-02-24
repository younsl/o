import React from 'react';
import { PluginHeader, Container, Text } from '@backstage/ui';
import { ApplicationSetTable } from '../ApplicationSetTable';

export const ArgocdAppsetPage = () => {
  return (
    <>
      <PluginHeader title="ArgoCD ApplicationSets" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          View ApplicationSet resources from the Kubernetes cluster
        </Text>
        <ApplicationSetTable />
      </Container>
    </>
  );
};
