import React from 'react';
import { Box } from '@backstage/ui';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  isGitlabAvailable,
  EntityGitlabReadmeCard,
} from '@immobiliarelabs/backstage-plugin-gitlab';
import { IntegrationStatusBadge } from './IntegrationStatusBadge';

const PLUGIN_URL = 'https://github.com/immobiliare/backstage-plugin-gitlab';

export const EntityGitlabReadmeCardWithStatus = () => {
  const { entity } = useEntity();
  const gitlabConnected = isGitlabAvailable(entity);

  return (
    <Box style={{ position: 'relative' }}>
      <IntegrationStatusBadge
        label="GitLab Integration"
        status={gitlabConnected ? 'connected' : 'disconnected'}
        pluginUrl={PLUGIN_URL}
        tooltipConnected="Connected to GitLab. Click to view plugin docs."
        tooltipDisconnected="Not connected to GitLab. Check your GitLab configuration."
      />
      <EntityGitlabReadmeCard />
    </Box>
  );
};
