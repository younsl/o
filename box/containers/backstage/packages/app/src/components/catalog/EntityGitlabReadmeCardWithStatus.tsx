import React from 'react';
import { Box, Tooltip, Typography, makeStyles } from '@material-ui/core';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  isGitlabAvailable,
  EntityGitlabReadmeCard,
} from '@immobiliarelabs/backstage-plugin-gitlab';

const useStyles = makeStyles(theme => ({
  wrapper: {
    position: 'relative',
  },
  status: {
    position: 'absolute',
    top: theme.spacing(1.5),
    right: theme.spacing(2),
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    cursor: 'pointer',
    padding: theme.spacing(0.5, 1.5),
    borderRadius: 16,
    border: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.paper,
    transition: 'background-color 0.2s',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
  led: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  connected: {
    backgroundColor: theme.palette.success.main,
    boxShadow: `0 0 6px ${theme.palette.success.main}`,
  },
  disconnected: {
    backgroundColor: theme.palette.grey[500],
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: 500,
    color: theme.palette.text.secondary,
  },
}));

const PLUGIN_URL = 'https://github.com/immobiliare/backstage-plugin-gitlab';

/**
 * Wrapper component for EntityGitlabReadmeCard that displays
 * GitLab connection status in the card header.
 */
export const EntityGitlabReadmeCardWithStatus = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const gitlabConnected = isGitlabAvailable(entity);

  const handleClick = () => {
    window.open(PLUGIN_URL, '_blank', 'noopener,noreferrer');
  };

  return (
    <Box className={classes.wrapper}>
      <Tooltip
        title={
          gitlabConnected
            ? 'GitLab integration is active. Click to view plugin docs.'
            : 'GitLab not connected. Click to view setup instructions.'
        }
        arrow
      >
        <Box className={classes.status} onClick={handleClick} role="button">
          <Typography className={classes.label}>GitLab Integration</Typography>
          <span
            className={`${classes.led} ${
              gitlabConnected ? classes.connected : classes.disconnected
            }`}
          />
        </Box>
      </Tooltip>
      <EntityGitlabReadmeCard />
    </Box>
  );
};
