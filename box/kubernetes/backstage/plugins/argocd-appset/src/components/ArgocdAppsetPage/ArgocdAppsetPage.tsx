import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { PluginHeader, Container, Link, Tag, TagGroup, Text } from '@backstage/ui';
import { RiGitBranchLine } from '@remixicon/react';
import { argocdAppsetPlugin } from '../../plugin';
import { ApplicationSetTable } from '../ApplicationSetTable';
import { AuditLogPage } from '../AuditLogPage';

const ApplicationSetListPage = () => (
  <>
    <PluginHeader
      icon={<RiGitBranchLine />}
      title="ArgoCD ApplicationSets"
      customActions={
        <TagGroup>
          <Tag id="plugin-id" size="small">{argocdAppsetPlugin.getId()}</Tag>
        </TagGroup>
      }
    />
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
