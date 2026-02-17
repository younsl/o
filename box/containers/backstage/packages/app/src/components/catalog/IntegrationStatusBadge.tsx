import React from 'react';
import { Box, CircularProgress, Tooltip, Typography, makeStyles } from '@material-ui/core';

const useStyles = makeStyles(theme => ({
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
  error: {
    backgroundColor: theme.palette.error.main,
    boxShadow: `0 0 6px ${theme.palette.error.main}`,
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: 500,
    color: theme.palette.text.secondary,
  },
  loader: {
    width: '8px !important',
    height: '8px !important',
  },
}));

export type ConnectionStatus = 'loading' | 'connected' | 'disconnected' | 'error';

export interface IntegrationStatusBadgeProps {
  label: string;
  status: ConnectionStatus;
  pluginUrl: string;
  tooltipConnected?: string;
  tooltipDisconnected?: string;
  tooltipLoading?: string;
  tooltipError?: string;
}

/**
 * A reusable status badge component that displays integration connection status.
 * Shows a label and LED indicator, clickable to open plugin documentation.
 */
export const IntegrationStatusBadge = ({
  label,
  status,
  pluginUrl,
  tooltipConnected = 'Integration is active. Click to view plugin docs.',
  tooltipDisconnected = 'Not connected. Click to view setup instructions.',
  tooltipLoading = 'Checking connection...',
  tooltipError = 'Connection failed. Click to view setup instructions.',
}: IntegrationStatusBadgeProps) => {
  const classes = useStyles();

  const handleClick = () => {
    window.open(pluginUrl, '_blank', 'noopener,noreferrer');
  };

  const getTooltip = () => {
    switch (status) {
      case 'loading':
        return tooltipLoading;
      case 'connected':
        return tooltipConnected;
      case 'error':
        return tooltipError;
      default:
        return tooltipDisconnected;
    }
  };

  const getLedClass = () => {
    switch (status) {
      case 'connected':
        return classes.connected;
      case 'error':
        return classes.error;
      default:
        return classes.disconnected;
    }
  };

  return (
    <Tooltip title={getTooltip()} arrow>
      <Box className={classes.status} onClick={handleClick} role="button">
        <Typography className={classes.label}>{label}</Typography>
        {status === 'loading' ? (
          <CircularProgress className={classes.loader} />
        ) : (
          <span className={`${classes.led} ${getLedClass()}`} />
        )}
      </Box>
    </Tooltip>
  );
};
