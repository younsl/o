import React, { useState, useMemo, useCallback } from 'react';
import {
  Alert,
  Box,
  ButtonIcon,
  Card,
  CardBody,
  CardFooter,
  Flex,
  Grid,
  SearchField,
  Select,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { RiInformationLine, RiLockPasswordLine, RiMailSendLine } from '@remixicon/react';
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import { WarningDmLog } from '../../api/types';
import { PasswordResetDialog } from '../PasswordResetDialog';
import { StatusDmDialog } from '../StatusDmDialog';
import { HighlightText } from '../HighlightText';
import './IamUserTable.css';

interface IamUserTableProps {
  threshold?: number;
  warningDays?: number;
  isAdmin?: boolean;
  slackUserMap?: Record<string, boolean>;
  warningDmLogs?: Record<string, WarningDmLog | null>;
  onPasswordResetSubmitted?: () => void;
}

export const IamUserTable = ({ threshold = 90, warningDays = 14, isAdmin, slackUserMap, warningDmLogs, onPasswordResetSubmitted }: IamUserTableProps) => {
  const api = useApi(iamUserAuditApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [consoleFilter, setConsoleFilter] = useState<string>('all');
  const [keyStatusFilter, setKeyStatusFilter] = useState<string>('all');
  const [resetTarget, setResetTarget] = useState<{
    userName: string;
    arn: string;
  } | null>(null);
  const [dmTarget, setDmTarget] = useState<string | null>(null);

  const handleResetSubmitted = useCallback(() => {
    onPasswordResetSubmitted?.();
  }, [onPasswordResetSubmitted]);

  const {
    value: users,
    loading,
    error: loadError,
  } = useAsyncRetry(async () => {
    return api.listUsers();
  }, []);

  // Filtering is handled server-side; frontend displays all returned users
  const visibleUsers = useMemo(() => {
    return users ?? [];
  }, [users]);

  const filteredUsers = useMemo(() => {
    return visibleUsers.filter(u => {
      const matchesSearch =
        searchQuery === '' ||
        u.userName.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesConsole =
        consoleFilter === 'all' ||
        (consoleFilter === 'yes' && u.hasConsoleAccess) ||
        (consoleFilter === 'no' && !u.hasConsoleAccess);
      const matchesKeyStatus =
        keyStatusFilter === 'all' ||
        (keyStatusFilter === 'active' &&
          u.accessKeys.some(k => k.status === 'Active')) ||
        (keyStatusFilter === 'none' && u.accessKeyCount === 0);
      return matchesSearch && matchesConsole && matchesKeyStatus;
    });
  }, [visibleUsers, searchQuery, consoleFilter, keyStatusFilter]);

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const getSeverityClass = (inactiveDays: number) => {
    if (inactiveDays >= 365) return 'iam-card-critical';
    if (inactiveDays >= 180) return 'iam-card-warning';
    if (inactiveDays >= 30) return 'iam-card-caution';
    return '';
  };

  if (loading) {
    return (
      <Flex direction="column" gap="3" mt="4">
        <Skeleton width="100%" height={60} />
        <Skeleton width="100%" height={40} />
        <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
          {[1, 2, 3, 4].map(i => (
            <Grid.Item key={i}>
              <Skeleton width="100%" height={200} />
            </Grid.Item>
          ))}
        </Grid.Root>
      </Flex>
    );
  }

  if (loadError) {
    return (
      <Flex direction="column" gap="2" mt="4">
        <Alert status="danger" title="Failed to load IAM users" />
        <Text variant="body-small" color="secondary">
          {loadError.message}
        </Text>
      </Flex>
    );
  }

  if (!users || visibleUsers.length === 0) {
    return (
      <Flex direction="column" align="center" gap="2" className="iam-empty-state">
        <Text variant="body-large" color="secondary">
          No IAM users found
        </Text>
        <Text variant="body-small" color="secondary">
          Ensure the backend has access to the AWS IAM API
        </Text>
      </Flex>
    );
  }

  const consoleOptions = [
    { value: 'all', label: 'All' },
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ];

  const keyStatusOptions = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Has Active Keys' },
    { value: 'none', label: 'No Keys' },
  ];

  return (
    <>
      <Box mt="3" p="3" className="iam-section-box">
        <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
          Filters
        </Text>
        <div className="iam-filter-bar">
          <SearchField
            label="Search"
            placeholder="Search by username..."
            size="small"
            value={searchQuery}
            onChange={setSearchQuery}
          />
          <Select
            label="Console Access"
            size="small"
            options={consoleOptions}
            selectedKey={consoleFilter}
            onSelectionChange={key => setConsoleFilter(key as string)}
          />
          <Select
            label="Access Keys"
            size="small"
            options={keyStatusOptions}
            selectedKey={keyStatusFilter}
            onSelectionChange={key => setKeyStatusFilter(key as string)}
          />
        </div>
      </Box>

      <Box mt="3" p="3" className="iam-section-box">
        <Flex justify="between" align="center" mb="3">
          <Text variant="body-medium" weight="bold">
            IAM Users
          </Text>
          <Flex align="center" gap="2">
            <span className="iam-count-badge">
              {filteredUsers.length !== visibleUsers.length
                ? `${filteredUsers.length} / ${visibleUsers.length}`
                : visibleUsers.length}
            </span>
            <Text variant="body-small" color="secondary">results</Text>
          </Flex>
        </Flex>

        {filteredUsers.length === 0 ? (
          <div className="iam-empty-state">
            <Text variant="body-medium" color="secondary">
              No users match the current filters
            </Text>
          </div>
        ) : (
          <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
            {filteredUsers.map(user => (
              <Grid.Item key={user.userId} className="iam-grid-item">
                <Card className={`iam-card ${getSeverityClass(user.inactiveDays)}`}>
                  <CardBody className="iam-card-body">
                    <div>
                      <Text
                        variant="body-medium"
                        className="iam-card-name"
                      >
                        <HighlightText text={user.userName} query={searchQuery} />
                      </Text>
                    </div>

                    <div>
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="iam-field-label"
                      >
                        Console Last Used
                      </Text>
                      <Text variant="body-small">
                        {formatDate(user.passwordLastUsed)}
                        {' '}
                        <Text as="span" variant="body-x-small" color={user.hasConsoleAccess ? 'success' : 'secondary'}>
                          ({user.hasConsoleAccess ? 'Enabled' : 'Disabled'})
                        </Text>
                      </Text>
                    </div>

                    <div>
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="iam-field-label"
                      >
                        Key Last Used
                      </Text>
                      <Text variant="body-small">
                        {formatDate(
                          user.accessKeys.reduce<string | null>((latest, k) => {
                            if (!k.lastUsedDate) return latest;
                            if (!latest) return k.lastUsedDate;
                            return k.lastUsedDate > latest ? k.lastUsedDate : latest;
                          }, null),
                        )}
                      </Text>
                    </div>

                    <div>
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        className="iam-field-label"
                      >
                        Access Keys
                      </Text>
                      {user.accessKeys.length > 0 ? (
                        <TagGroup>
                          {user.accessKeys.map(key => (
                            <TooltipTrigger key={key.accessKeyId} delay={200}>
                              <Tag
                                id={key.accessKeyId}
                                size="small"
                              >
                                {key.accessKeyId.slice(-4)} ({key.status})
                              </Tag>
                              <Tooltip style={{ maxWidth: 360 }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, lineHeight: 1.5 }}>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <span style={{ fontWeight: 700, minWidth: 64, flexShrink: 0 }}>Key ID</span>
                                    <span style={{ opacity: 0.8, wordBreak: 'break-all' }}>{key.accessKeyId}</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <span style={{ fontWeight: 700, minWidth: 64, flexShrink: 0 }}>Status</span>
                                    <span style={{ opacity: 0.8 }}>{key.status}</span>
                                  </div>
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <span style={{ fontWeight: 700, minWidth: 64, flexShrink: 0 }}>Last Used</span>
                                    <span style={{ opacity: 0.8 }}>{key.lastUsedDate ? formatDate(key.lastUsedDate) : 'Never'}</span>
                                  </div>
                                  {key.lastUsedService && (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                      <span style={{ fontWeight: 700, minWidth: 64, flexShrink: 0 }}>Service</span>
                                      <span style={{ opacity: 0.8 }}>{key.lastUsedService}</span>
                                    </div>
                                  )}
                                </div>
                              </Tooltip>
                            </TooltipTrigger>
                          ))}
                        </TagGroup>
                      ) : (
                        <Text variant="body-small" color="secondary">No keys</Text>
                      )}
                    </div>

                    {(() => {
                      const ratio = Math.min(user.inactiveDays / threshold, 1);
                      const pct = Math.min(Math.round((user.inactiveDays / threshold) * 100), 100);
                      const barColor =
                        user.inactiveDays >= 365
                          ? 'var(--bui-color-danger, #ef4444)'
                          : user.inactiveDays >= threshold
                            ? 'var(--bui-color-warning, #f59e0b)'
                            : ratio >= 0.5
                              ? '#f97316'
                              : 'var(--bui-color-text-secondary, #999)';
                      return (
                        <div>
                          <Text
                            variant="body-x-small"
                            color="secondary"
                            className="iam-field-label"
                          >
                            Inactive Period
                          </Text>
                          <div className="iam-progress-row">
                            <div className="iam-progress-track" style={{ position: 'relative' }}>
                              <div
                                className="iam-progress-fill"
                                style={{ width: `${pct}%`, backgroundColor: barColor }}
                              >
                                {pct >= (`${user.inactiveDays}d`.length * 7 + 8) / 1.5 && (
                                  <span className="iam-progress-text">{user.inactiveDays}d</span>
                                )}
                              </div>
                              {pct < 100 && (
                                <div
                                  className="iam-progress-remaining"
                                  style={{ width: `${100 - pct}%` }}
                                >
                                  {(100 - pct) >= (`${threshold - user.inactiveDays}d`.length * 7 + 8) / 1.5 && (
                                    <span className="iam-progress-text">{threshold - user.inactiveDays}d</span>
                                  )}
                                </div>
                              )}
                              {threshold > warningDays && (
                                <div
                                  className="iam-threshold-marker"
                                  style={{ left: `${Math.round(((threshold - warningDays) / threshold) * 100)}%` }}
                                />
                              )}
                            </div>
                            <TooltipTrigger delay={200}>
                              <ButtonIcon
                                size="small"
                                variant="tertiary"
                                icon={<RiInformationLine size={14} />}
                                aria-label="Alarm policy info"
                                className="iam-help-btn"
                              />
                              <Tooltip style={{ maxWidth: 320 }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.5 }}>
                                  <div style={{ fontWeight: 700 }}>Global Alarm Policy</div>
                                  <div>Warning DM: {threshold - warningDays}d ({warningDays}d before threshold)</div>
                                  <div>Inactive threshold: {threshold}d</div>
                                  <div style={{ marginTop: 2, opacity: 0.7 }}>Dashed line = warning point</div>
                                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.2)', marginTop: 4, paddingTop: 4 }}>
                                    {(() => {
                                      const dmLog = warningDmLogs?.[user.userName];
                                      if (!dmLog) return <span>Last Warning DM: None</span>;
                                      const date = new Date(dmLog.createdAt).toLocaleString();
                                      const platform = dmLog.platform.charAt(0).toUpperCase() + dmLog.platform.slice(1);
                                      if (dmLog.status === 'success') {
                                        return <span>Last Warning DM: {date} via {platform} (Success)</span>;
                                      }
                                      return <span>Last Warning DM: {date} via {platform} (Failed{dmLog.errorMessage ? `: ${dmLog.errorMessage}` : ''})</span>;
                                    })()}
                                  </div>
                                </div>
                              </Tooltip>
                            </TooltipTrigger>
                          </div>
                        </div>
                      );
                    })()}
                  </CardBody>

                  <CardFooter className="iam-card-footer">
                    <Text variant="body-x-small" color="secondary">
                      Created {formatDate(user.createDate)}
                    </Text>
                    <Flex gap="0" align="center">
                      {isAdmin && (() => {
                        const slackExists = slackUserMap?.[user.userName] ?? false;
                        return (
                          <TooltipTrigger delay={200}>
                            <ButtonIcon
                              size="small"
                              variant="tertiary"
                              icon={<RiMailSendLine size={18} style={slackExists ? undefined : { opacity: 0.3 }} />}
                              aria-label={slackExists ? 'Send status DM' : 'Slack user not found'}
                              isDisabled={!slackExists}
                              onPress={() => setDmTarget(user.userName)}
                            />
                            <Tooltip>{slackExists ? 'Send status DM' : 'Slack user not found'}</Tooltip>
                          </TooltipTrigger>
                        );
                      })()}
                      {user.hasConsoleAccess ? (
                        <TooltipTrigger delay={200}>
                          <ButtonIcon
                            size="small"
                            variant="tertiary"
                            icon={<RiLockPasswordLine size={18} />}
                            aria-label="Reset password"
                            onPress={() =>
                              setResetTarget({
                                userName: user.userName,
                                arn: user.arn,
                              })
                            }
                          />
                          <Tooltip>Reset password</Tooltip>
                        </TooltipTrigger>
                      ) : (
                        <TooltipTrigger delay={200}>
                          <ButtonIcon
                            size="small"
                            variant="tertiary"
                            icon={<RiLockPasswordLine size={18} style={{ opacity: 0.3 }} />}
                            aria-label="No console access"
                            style={{ cursor: 'default' }}
                          />
                          <Tooltip>Console password not set — reset unavailable</Tooltip>
                        </TooltipTrigger>
                      )}
                    </Flex>
                  </CardFooter>
                </Card>
              </Grid.Item>
            ))}
          </Grid.Root>
        )}
      </Box>

      {resetTarget && (
        <PasswordResetDialog
          userName={resetTarget.userName}
          userArn={resetTarget.arn}
          open
          onClose={() => setResetTarget(null)}
          onSubmitted={handleResetSubmitted}
        />
      )}

      {dmTarget && (
        <StatusDmDialog
          userName={dmTarget}
          open
          onClose={() => setDmTarget(null)}
          onSent={() => setDmTarget(null)}
        />
      )}
    </>
  );
};
