import React from 'react';
import { PluginHeader, Container, Link, Text } from '@backstage/ui';
import { ApplicationSetTable } from '../ApplicationSetTable';

export const ArgocdAppsetPage = () => {
  return (
    <>
      <PluginHeader title="ArgoCD ApplicationSets" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          View and manage <Link href="https://argo-cd.readthedocs.io/en/stable/user-guide/application-set/" target="_blank" rel="noopener noreferrer">ArgoCD ApplicationSet</Link> resources deployed in the Kubernetes cluster
        </Text>
        <ApplicationSetTable />
      </Container>
    </>
  );
};
