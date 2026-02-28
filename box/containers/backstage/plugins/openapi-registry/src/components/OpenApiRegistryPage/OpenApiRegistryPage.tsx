import React, { useState } from 'react';
import { PluginHeader, Container, Flex, Text, Box, Tabs, TabList, Tab, TabPanel } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { RegisterApiForm } from '../RegisterApiForm';
import { RegisteredApisList } from '../RegisteredApisList';
import { openApiRegistryApiRef } from '../../api';

export const OpenApiRegistryPage = () => {
  const api = useApi(openApiRegistryApiRef);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [selectedTab, setSelectedTab] = useState<string | number>('register');

  const {
    value: registrations,
    loading,
    error: loadError,
    retry,
  } = useAsyncRetry(async () => {
    return api.listRegistrations();
  }, [refreshTrigger]);

  const apiCount = registrations?.length ?? 0;

  const handleRegisterSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
    setSelectedTab('list');
  };

  return (
    <>
      <PluginHeader title="OpenAPI Registry" />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Text variant="body-medium" color="secondary">
            Register external API specs from URL and sync them to Backstage Catalog automatically
          </Text>

          <Tabs selectedKey={selectedTab} onSelectionChange={setSelectedTab}>
            <TabList>
              <Tab id="register">Register</Tab>
              <Tab id="list">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  Status
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 20,
                    height: 20,
                    padding: '0 6px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: 1,
                    ...(apiCount > 0
                      ? { backgroundColor: '#f59e0b', color: '#fff' }
                      : { backgroundColor: 'rgba(128,128,128,0.2)', color: 'rgba(128,128,128,0.8)' }
                    ),
                  }}>
                    {apiCount}
                  </span>
                </span>
              </Tab>
            </TabList>

            <TabPanel id="register">
              <Box mt="3" p="3" style={{ backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)', borderRadius: 4 }}>
                <RegisterApiForm onSuccess={handleRegisterSuccess} />
              </Box>
            </TabPanel>

            <TabPanel id="list">
              <Box mt="3" p="3" style={{ backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)', borderRadius: 4 }}>
                <RegisteredApisList
                  registrations={registrations}
                  loading={loading}
                  loadError={loadError}
                  onRetry={retry}
                />
              </Box>
            </TabPanel>
          </Tabs>
        </Flex>
      </Container>
    </>
  );
};
