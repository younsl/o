import React from 'react';
import { Box, makeStyles } from '@material-ui/core';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  isGitlabAvailable,
  EntityGitlabReadmeCard,
} from '@immobiliarelabs/backstage-plugin-gitlab';
import { IntegrationStatusBadge } from './IntegrationStatusBadge';

const useStyles = makeStyles({
  wrapper: {
    position: 'relative',
  },
});

const PLUGIN_URL = 'https://github.com/immobiliare/backstage-plugin-gitlab';

/**
 * Wrapper component for EntityGitlabReadmeCard that displays
 * GitLab connection status in the card header.
 */
export const EntityGitlabReadmeCardWithStatus = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const gitlabConnected = isGitlabAvailable(entity);

  return (
    <Box className={classes.wrapper}>
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
