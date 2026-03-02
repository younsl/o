import React, { useEffect, useState } from 'react';
import { ButtonIcon, Card, CardBody, Flex, Grid, Text, Tooltip, TooltipTrigger } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { EntitySonarQubeCard } from '@backstage-community/plugin-sonarqube';
import { sonarQubeApiRef, useProjectInfo } from '@backstage-community/plugin-sonarqube-react';
import { IntegrationStatusBadge, ConnectionStatus } from './IntegrationStatusBadge';

const SONARQUBE_ANNOTATION_PREFIX = 'sonarqube.org/';

const PLUGIN_URL = 'https://github.com/backstage/community-plugins/tree/main/workspaces/sonarqube/plugins/sonarqube';

const labelStyle: React.CSSProperties = {
  textTransform: 'uppercase',
  fontSize: '0.65rem',
  fontWeight: 700,
  letterSpacing: 0.5,
};

const codeBlockStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.8rem',
  backgroundColor: 'var(--bui-color-bg-elevated, #1e1e1e)',
  padding: 12,
  borderRadius: 4,
  overflow: 'auto',
  margin: 0,
  lineHeight: 1.6,
};

const chipStyle = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: 4,
  fontSize: '0.65rem',
  fontWeight: 700,
  backgroundColor: bg,
  color: fg,
});

/**
 * Wrapper component for EntitySonarQubeCard that displays
 * SonarQube connection status in the card header.
 */
export const EntitySonarQubeCardWithStatus = () => {
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
    <Flex direction="column" gap="3">
      {sonarQubeAnnotations.length > 0 && (
        <Flex direction="column" gap="3">
          <IntegrationStatusBadge
            label="SonarQube Integration"
            status={connectionStatus}
            pluginUrl={PLUGIN_URL}
            tooltipConnected="Connected to SonarQube. Click to view plugin docs."
            tooltipDisconnected="Not connected to SonarQube. Check if the project exists, or verify your token and permissions."
            tooltipLoading="Checking SonarQube connection..."
          />
          <Card>
            <CardBody>
              <Flex direction="column" gap="3">
                <Flex align="center" gap="1">
                  <Text variant="title-small" weight="bold">Annotations</Text>
                  <TooltipTrigger>
                    <ButtonIcon
                      size="small"
                      variant="tertiary"
                      icon={
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                          <path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z" />
                        </svg>
                      }
                      onPress={() => window.open('https://backstage.io/docs/features/software-catalog/well-known-annotations', '_blank', 'noopener,noreferrer')}
                    />
                    <Tooltip>Learn more about well-known annotations</Tooltip>
                  </TooltipTrigger>
                </Flex>

                <Text variant="body-small" color="secondary">
                  SonarQube annotations configured for this entity. These settings connect your component to SonarQube for code quality analysis.
                </Text>

                <Grid.Root columns={{ initial: '1', sm: sourceAnnotation ? '2' : '1' }} gap="4">
                  {sourceAnnotation && (
                    <Grid.Item>
                      <Flex direction="column" gap="1">
                        <Text variant="body-small" color="secondary" style={labelStyle}>Source</Text>
                        <Flex direction="column" gap="1" align="start">
                          <span
                            style={isAutoInjected
                              ? chipStyle('#29b6f633', '#29b6f6')
                              : chipStyle('#66bb6a33', '#66bb6a')
                            }
                          >
                            {isAutoInjected ? 'AUTO' : 'MANUAL'}
                          </span>
                          <Text variant="body-small" color="secondary" style={{ fontSize: '0.75rem' }}>
                            {isAutoInjected
                              ? 'Automatically set using your GitLab project name or entity name.'
                              : 'Manually specified in your catalog-info.yaml file.'}
                          </Text>
                        </Flex>
                      </Flex>
                    </Grid.Item>
                  )}
                  <Grid.Item>
                    <Flex direction="column" gap="1">
                      <Text variant="body-small" color="secondary" style={labelStyle}>
                        Values ({sonarQubeAnnotations.length})
                      </Text>
                      <pre style={codeBlockStyle}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span style={{ color: '#9cdcfe' }}>metadata</span>
                          <span>:</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span>{'  '}</span>
                          <span style={{ color: '#9cdcfe' }}>annotations</span>
                          <span>:</span>
                        </div>
                        {sonarQubeAnnotations.map(([key, value]) => (
                          <div key={key} style={{ display: 'flex', alignItems: 'center' }}>
                            <span>{'    '}</span>
                            <span style={{ color: '#9cdcfe' }}>{key}</span>
                            <span>: </span>
                            <span style={{ color: '#ce9178' }}>{value}</span>
                          </div>
                        ))}
                      </pre>
                    </Flex>
                  </Grid.Item>
                </Grid.Root>
              </Flex>
            </CardBody>
          </Card>
        </Flex>
      )}
      <EntitySonarQubeCard variant="gridItem" />
    </Flex>
  );
};
