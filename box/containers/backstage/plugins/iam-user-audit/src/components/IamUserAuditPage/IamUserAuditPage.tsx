import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { PluginHeader, Container, Box, Button, Flex, Text, Tabs, TabList, Tab, TabPanel, Tooltip, TooltipTrigger } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import { WarningDmLog, SlackHealth } from '../../api/types';
import { IamUserTable } from '../IamUserTable';
import { PasswordResetRequests } from '../PasswordResetRequests';
import '../IamUserTable/IamUserTable.css';
import './IamUserAuditPage.css';

export const IamUserAuditPage = () => {
  const api = useApi(iamUserAuditApiRef);
  const { value: adminStatus } = useAsyncRetry(async () => {
    return api.getAdminStatus();
  }, []);

  const isAdmin = adminStatus?.isAdmin ?? false;

  const { value: users } = useAsyncRetry(async () => {
    return api.listUsers();
  }, []);

  const [slackUserMap, setSlackUserMap] = useState<Record<string, boolean>>({});
  const [warningDmLogs, setWarningDmLogs] = useState<Record<string, WarningDmLog | null>>({});
  const [slackHealth, setSlackHealth] = useState<SlackHealth | null>(null);

  useEffect(() => {
    api.getSlackHealth().then(setSlackHealth).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!isAdmin || !users || users.length === 0) return;
    const userNames = users.map(u => u.userName);
    api.checkSlackUsers(userNames).then(setSlackUserMap).catch(() => {});
  }, [api, isAdmin, users]);

  useEffect(() => {
    if (!users || users.length === 0) return;
    const userNames = users.map(u => u.userName);
    api.getWarningDmLogs(userNames).then(setWarningDmLogs).catch(() => {});
  }, [api, users]);

  const { value: status } = useAsyncRetry(async () => {
    return api.getStatus();
  }, []);

  const { value: requests } = useAsyncRetry(async () => {
    return api.listPasswordResetRequests();
  }, []);

  const pendingCount = (requests ?? []).filter(r => r.status === 'pending').length;

  const totalCount = users?.length ?? 0;
  const inactiveCount = useMemo(() => {
    if (!users || !status) return 0;
    return users.filter(u => u.inactiveDays >= status.inactiveDays).length;
  }, [users, status]);
  const withActiveKeysCount = useMemo(() => {
    if (!users) return 0;
    return users.filter(u =>
      u.accessKeys.some(k => k.status === 'Active'),
    ).length;
  }, [users]);

  const [activeTab, setActiveTab] = useState<string>('users');

  const [resetKey, incrementResetKey] = useReducer(
    (c: number) => c + 1,
    0,
  );

  const handlePasswordResetSubmitted = useCallback(() => {
    incrementResetKey();
  }, []);

  return (
    <>
      <PluginHeader title="IAM User Audit" />
      <Container my="4">
        <Text variant="body-medium" color="secondary">
          Monitor inactive IAM users in your AWS account
        </Text>

        <Box mt="4" p="3" className="iam-section-box">
          <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
            <Text variant="body-medium" weight="bold">
              Overview
            </Text>
            {status && (
              <Flex gap="1" align="center">
                <TooltipTrigger delay={200}>
                  <Button
                    variant="tertiary"
                    size="small"
                    className={`iam-integration-badge ${status.slackConfigured ? 'iam-integration-connected' : 'iam-integration-disconnected'}`}
                  >
                    Webhook {status.slackConfigured ? 'Connected' : 'Not configured'}
                  </Button>
                  <Tooltip style={{ maxWidth: 280 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 700 }}>Slack Incoming Webhook</div>
                      <div>Status: {status.slackConfigured ? 'Configured' : 'Not configured'}</div>
                      <div>Usage: Sends inactive user alerts to Slack channel</div>
                      {slackHealth && (
                        <div style={{ opacity: 0.7 }}>Last checked: {new Date(slackHealth.checkedAt).toLocaleString()}</div>
                      )}
                    </div>
                  </Tooltip>
                </TooltipTrigger>
                <TooltipTrigger delay={200}>
                  <Button
                    variant="tertiary"
                    size="small"
                    className={`iam-integration-badge ${slackHealth?.bot.valid ? 'iam-integration-connected' : status.botConfigured ? 'iam-integration-warning' : 'iam-integration-disconnected'}`}
                  >
                    Bot {slackHealth?.bot.valid ? 'Connected' : status.botConfigured ? 'Invalid token' : 'Not configured'}
                  </Button>
                  <Tooltip style={{ maxWidth: 280 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 700 }}>Slack Bot App</div>
                      <div>Status: {slackHealth?.bot.valid ? 'Authenticated' : status.botConfigured ? 'Token invalid' : 'Not configured'}</div>
                      {slackHealth?.bot.botName && <div>Bot name: {slackHealth.bot.botName}</div>}
                      {slackHealth?.bot.teamName && <div>Workspace: {slackHealth.bot.teamName}</div>}
                      <div>Usage: Sends warning DM to inactive users, password reset DM to requesters</div>
                      {slackHealth && (
                        <div style={{ opacity: 0.7 }}>Last checked: {new Date(slackHealth.checkedAt).toLocaleString()}</div>
                      )}
                    </div>
                  </Tooltip>
                </TooltipTrigger>
              </Flex>
            )}
          </Flex>
          <div className="iam-summary-bar">
            <div className="iam-summary-card">
              <Text weight="bold" className="iam-summary-value">{totalCount}</Text>
              <Text variant="body-x-small" color="secondary">Total Users</Text>
            </div>
            <div className="iam-summary-card">
              <Text weight="bold" color={inactiveCount > 0 ? 'warning' : undefined} className="iam-summary-value">
                {inactiveCount}
              </Text>
              <Text variant="body-x-small" color="secondary">Inactive</Text>
            </div>
            <div className="iam-summary-card">
              <Text weight="bold" color={withActiveKeysCount > 0 ? 'warning' : undefined} className="iam-summary-value">
                {withActiveKeysCount}
              </Text>
              <Text variant="body-x-small" color="secondary">With Active Keys</Text>
            </div>
            {status && (
              <>
                <div className="iam-summary-card">
                  <Text variant="body-x-small" weight="bold" className="iam-cron-badge">
                    {status.cron}
                  </Text>
                  <Text variant="body-x-small" color="secondary">
                    Schedule (UTC)
                  </Text>
                </div>
              </>
            )}
            {status?.lastFetchedAt && (
              <div className="iam-summary-card">
                <Text variant="body-x-small" color="secondary">
                  Last fetched {new Date(status.lastFetchedAt).toLocaleString()}
                </Text>
              </div>
            )}
          </div>
        </Box>

        <Tabs
          className="iam-tabs"
          selectedKey={activeTab}
          onSelectionChange={key => setActiveTab(key as string)}
        >
          <Box mt="3">
            <TabList>
              <Tab id="users">IAM Users</Tab>
              {isAdmin && (
                <Tab id="admin">
                  <span className="iam-tab-label">
                    Admin Review
                    <span
                      className={
                        pendingCount > 0
                          ? 'iam-tab-badge'
                          : 'iam-tab-badge iam-tab-badge-zero'
                      }
                    >
                      {pendingCount}
                    </span>
                  </span>
                </Tab>
              )}
              <Tab id="reset">Password Reset</Tab>
            </TabList>
          </Box>

          <TabPanel id="users">
            <IamUserTable
              threshold={status?.inactiveDays ?? 90}
              warningDays={status?.warningDays ?? 14}
              isAdmin={isAdmin}
              slackUserMap={slackUserMap}
              warningDmLogs={warningDmLogs}
              onPasswordResetSubmitted={handlePasswordResetSubmitted}
            />
          </TabPanel>
          {isAdmin && (
            <TabPanel id="admin">
              <PasswordResetRequests
                key={resetKey}
                showActions
                filter="pending"
              />
            </TabPanel>
          )}
          <TabPanel id="reset">
            <PasswordResetRequests
              key={resetKey}
              showActions={false}
            />
          </TabPanel>
        </Tabs>
      </Container>
    </>
  );
};
