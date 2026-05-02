import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { PluginHeader, Container, Link, Text } from '@backstage/ui';
import { ApplicationSetTable } from '../ApplicationSetTable';
import { AuditLogPage } from '../AuditLogPage';

const ApplicationSetListPage = () => (
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

export const ArgocdAppsetPage = () => {
  return (
    <Routes>
      <Route path="/" element={<ApplicationSetListPage />} />
      <Route path="/audit-logs/:namespace/:name" element={<AuditLogPage />} />
    </Routes>
  );
};
