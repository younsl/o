import React, { useEffect, useState } from 'react';
import { Box, Chip, Grid, IconButton, Tooltip, Typography, makeStyles } from '@material-ui/core';
import HelpOutlineIcon from '@material-ui/icons/HelpOutline';
import { InfoCard } from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { EntitySonarQubeCard } from '@backstage-community/plugin-sonarqube';
import { sonarQubeApiRef, useProjectInfo } from '@backstage-community/plugin-sonarqube-react';
import { IntegrationStatusBadge, ConnectionStatus } from './IntegrationStatusBadge';

const SONARQUBE_ANNOTATION_PREFIX = 'sonarqube.org/';

const useStyles = makeStyles(theme => ({
  wrapper: {
    position: 'relative',
  },
  annotationCard: {
    position: 'relative',
    marginBottom: theme.spacing(2),
  },
  description: {
    marginBottom: theme.spacing(2),
    color: theme.palette.text.secondary,
  },
  label: {
    color: theme.palette.text.secondary,
    textTransform: 'uppercase',
    fontSize: '0.65rem',
    fontWeight: 'bold',
    letterSpacing: 0.5,
    marginBottom: theme.spacing(0.5),
  },
  codeBlock: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    backgroundColor: theme.palette.type === 'dark' ? '#1e1e1e' : '#f5f5f5',
    padding: theme.spacing(1.5),
    borderRadius: theme.shape.borderRadius,
    overflow: 'auto',
    margin: 0,
    lineHeight: 1.6,
  },
  codeLine: {
    display: 'flex',
    alignItems: 'center',
  },
  codeKey: {
    color: theme.palette.type === 'dark' ? '#9cdcfe' : '#0451a5',
  },
  codeValue: {
    color: theme.palette.type === 'dark' ? '#ce9178' : '#a31515',
  },
  autoChip: {
    fontSize: '0.65rem',
    height: 20,
    backgroundColor: theme.palette.info.light,
    color: theme.palette.info.contrastText,
  },
  manualChip: {
    fontSize: '0.65rem',
    height: 20,
    backgroundColor: theme.palette.success.light,
    color: theme.palette.success.contrastText,
  },
}));

const PLUGIN_URL = 'https://github.com/backstage/community-plugins/tree/main/workspaces/sonarqube/plugins/sonarqube';

/**
 * Wrapper component for EntitySonarQubeCard that displays
 * SonarQube connection status in the card header.
 */
export const EntitySonarQubeCardWithStatus = () => {
  const classes = useStyles();
  const { entity } = useEntity();
  const sonarQubeApi = useApi(sonarQubeApiRef);
  const { projectKey, projectInstance } = useProjectInfo(entity);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('loading');

  // Get all sonarqube.org/ annotations
  const sonarQubeAnnotations = Object.entries(entity.metadata.annotations || {})
    .filter(([key]) => key.startsWith(SONARQUBE_ANNOTATION_PREFIX))
    .sort(([a], [b]) => a.localeCompare(b));

  // Check if project-key-source annotation exists and its value
  // Support 'auto-injected' (new) and 'auto' (legacy) for backward compatibility
  const sourceAnnotation = sonarQubeAnnotations.find(
    ([key]) => key === 'sonarqube.org/project-key-source'
  );
  const sourceValue = sourceAnnotation?.[1];
  const isAutoInjected = sourceValue === 'auto-injected' || sourceValue === 'auto';

  // Check actual SonarQube API connection
  useEffect(() => {
    if (!projectKey) {
      setConnectionStatus('disconnected');
      return;
    }

    const checkConnection = async () => {
      setConnectionStatus('loading');
      try {
        const result = await sonarQubeApi.getFindingSummary({
          componentKey: projectKey,
          projectInstance,
        });
        setConnectionStatus(result ? 'connected' : 'disconnected');
      } catch {
        setConnectionStatus('disconnected');
      }
    };

    checkConnection();
  }, [sonarQubeApi, projectKey, projectInstance]);

  return (
    <Box className={classes.wrapper}>
      {sonarQubeAnnotations.length > 0 && (
        <Box className={classes.annotationCard}>
          <IntegrationStatusBadge
            label="SonarQube Integration"
            status={connectionStatus}
            pluginUrl={PLUGIN_URL}
            tooltipConnected="Connected to SonarQube. Click to view plugin docs."
            tooltipDisconnected="Not connected to SonarQube. Check if the project exists, or verify your token and permissions."
            tooltipLoading="Checking SonarQube connection..."
          />
          <InfoCard
            title={
              <Box display="flex" alignItems="center">
                Annotations
                <Tooltip title="Learn more about well-known annotations">
                  <IconButton
                    size="small"
                    component="a"
                    href="https://backstage.io/docs/features/software-catalog/well-known-annotations"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ marginLeft: 4 }}
                  >
                    <HelpOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            }
            variant="gridItem"
          >
            <Typography variant="body2" className={classes.description}>
              SonarQube annotations configured for this entity. These settings connect your component to SonarQube for code quality analysis.
            </Typography>
            <Grid container spacing={3}>
              {sourceAnnotation && (
                <Grid item xs={12} sm={4}>
                  <Typography className={classes.label}>Source</Typography>
                  <Tooltip
                    title={
                      isAutoInjected
                        ? 'This annotation was automatically set using your GitLab project name or entity name. No manual configuration required.'
                        : 'This annotation was manually specified in your catalog-info.yaml file.'
                    }
                    arrow
                  >
                    <Chip
                      size="small"
                      label={isAutoInjected ? 'AUTO' : 'MANUAL'}
                      className={isAutoInjected ? classes.autoChip : classes.manualChip}
                    />
                  </Tooltip>
                </Grid>
              )}
              <Grid item xs={12} sm={sourceAnnotation ? 8 : 12}>
                <Typography className={classes.label}>Values ({sonarQubeAnnotations.length})</Typography>
                <pre className={classes.codeBlock}>
                  {Object.keys(entity).filter(k => k === 'metadata').map(metadataKey => (
                    <React.Fragment key={metadataKey}>
                      <Box className={classes.codeLine}>
                        <span className={classes.codeKey}>{metadataKey}</span>
                        <span>:</span>
                      </Box>
                      {Object.keys(entity.metadata).filter(k => k === 'annotations').map((annotationsKey, level1) => (
                        <React.Fragment key={annotationsKey}>
                          <Box className={classes.codeLine}>
                            <span>{'  '.repeat(level1 + 1)}</span>
                            <span className={classes.codeKey}>{annotationsKey}</span>
                            <span>:</span>
                          </Box>
                          {sonarQubeAnnotations.map(([key, value]) => (
                            <Box key={key} className={classes.codeLine}>
                              <span>{'  '.repeat(level1 + 2)}</span>
                              <span className={classes.codeKey}>{key}</span>
                              <span>: </span>
                              <span className={classes.codeValue}>{value}</span>
                            </Box>
                          ))}
                        </React.Fragment>
                      ))}
                    </React.Fragment>
                  ))}
                </pre>
              </Grid>
            </Grid>
          </InfoCard>
        </Box>
      )}
      <EntitySonarQubeCard variant="gridItem" />
    </Box>
  );
};
