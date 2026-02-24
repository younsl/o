import React, { useCallback, useMemo, useReducer, useState } from 'react';
import { Tabs, Tab } from '@material-ui/core';
import { PluginHeader, Container, Box, Text } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
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
  const severeCount = useMemo(() => {
    if (!users) return 0;
    return users.filter(u => u.inactiveDays >= 180).length;
  }, [users]);
  const withActiveKeysCount = useMemo(() => {
    if (!users) return 0;
    return users.filter(u =>
      u.accessKeys.some(k => k.status === 'Active'),
    ).length;
  }, [users]);

  const [activeTab, setActiveTab] = useState(0);

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

        {/* Overview Section */}
        <Box mb="4" mt="4">
          <Text as="h3" variant="body-small" weight="bold" color="secondary" className="iam-section-title">
            Overview
          </Text>
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
              <Text weight="bold" color={severeCount > 0 ? 'warning' : undefined} className="iam-summary-value">
                {severeCount}
              </Text>
              <Text variant="body-x-small" color="secondary">180+ Days</Text>
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
                  <Text variant="body-x-small" weight="bold" className="iam-summary-value">
                    {status.inactiveDays}d
                  </Text>
                  <Text variant="body-x-small" color="secondary">Threshold</Text>
                </div>
                <div className="iam-summary-card">
                  <Text variant="body-x-small" weight="bold" className="iam-cron-badge">
                    {status.cron}
                  </Text>
                  <Text variant="body-x-small" color="secondary">
                    Schedule {status.slackConfigured ? '(Slack ON)' : '(Slack OFF)'}
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

        <Box mt="4">
          <Tabs
            className="iam-tabs"
            value={activeTab}
            onChange={(_, newValue) => setActiveTab(newValue)}
            indicatorColor="primary"
          >
            <Tab label="IAM Users" />
            {isAdmin && (
              <Tab
                label={
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
                }
              />
            )}
            <Tab label="Password Reset" />
          </Tabs>
        </Box>

        <Box mt="4">
          {activeTab === 0 && (
            <IamUserTable
              onPasswordResetSubmitted={handlePasswordResetSubmitted}
            />
          )}

          {isAdmin && activeTab === 1 && (
            <PasswordResetRequests
              key={resetKey}
              showActions
              filter="pending"
            />
          )}

          {activeTab === (isAdmin ? 2 : 1) && (
            <PasswordResetRequests
              key={resetKey}
              showActions={false}
            />
          )}
        </Box>
      </Container>
    </>
  );
};
