import React, { useState, useMemo, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
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
import { useApi } from '@backstage/core-plugin-api';
import { useAsyncRetry } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import { PasswordResetDialog } from '../PasswordResetDialog';
import './IamUserTable.css';

interface IamUserTableProps {
  onPasswordResetSubmitted?: () => void;
}

export const IamUserTable = ({ onPasswordResetSubmitted }: IamUserTableProps) => {
  const api = useApi(iamUserAuditApiRef);

  const [searchQuery, setSearchQuery] = useState('');
  const [consoleFilter, setConsoleFilter] = useState<string>('all');
  const [keyStatusFilter, setKeyStatusFilter] = useState<string>('all');
  const [resetTarget, setResetTarget] = useState<{
    userName: string;
    arn: string;
  } | null>(null);

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
    return new Date(dateString).toLocaleDateString();
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
      <Box mt="4">
        <Text
          as="h3"
          variant="body-small"
          weight="bold"
          color="secondary"
          className="iam-section-title"
        >
          IAM Users
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

        {filteredUsers.length === 0 ? (
          <div className="iam-empty-state">
            <Text variant="body-medium" color="secondary">
              No users match the current filters
            </Text>
          </div>
        ) : (
          <Grid.Root columns={{ initial: '1', sm: '2', md: '4' }} gap="3">
            {filteredUsers.map(user => (
              <Grid.Item key={user.userId}>
                <Card className={getSeverityClass(user.inactiveDays)}>
                  <CardBody className="iam-card-body">
                    <div className="iam-card-header">
                      <div>
                        <Text
                          variant="body-medium"
                          className="iam-card-name"
                        >
                          {user.userName}
                        </Text>
                      </div>
                      <div className="iam-inactive-badge">
                        <TooltipTrigger delay={200}>
                          <Text
                            weight="bold"
                            className="iam-inactive-days"
                          >
                            {user.inactiveDays}d
                          </Text>
                          <Tooltip>
                            Inactive for {user.inactiveDays} days
                          </Tooltip>
                        </TooltipTrigger>
                      </div>
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
                      <TagGroup>
                        {user.accessKeys.length > 0 ? (
                          user.accessKeys.map(key => (
                            <TooltipTrigger key={key.accessKeyId} delay={200}>
                              <Tag
                                id={key.accessKeyId}
                                size="small"
                              >
                                {key.accessKeyId.slice(-4)} ({key.status})
                              </Tag>
                              <Tooltip>
                                {key.lastUsedDate
                                  ? `Last used: ${formatDate(key.lastUsedDate)}${key.lastUsedService ? ` (${key.lastUsedService})` : ''}`
                                  : 'Never used'}
                              </Tooltip>
                            </TooltipTrigger>
                          ))
                        ) : (
                          <Tag id="no-keys" size="small">
                            None
                          </Tag>
                        )}
                      </TagGroup>
                    </div>
                  </CardBody>

                  <CardFooter className="iam-card-footer">
                    <Text variant="body-x-small" color="secondary">
                      Created {formatDate(user.createDate)}
                    </Text>
                    {user.hasConsoleAccess && (
                      <Button
                        variant="secondary"
                        size="small"
                        onPress={() =>
                          setResetTarget({
                            userName: user.userName,
                            arn: user.arn,
                          })
                        }
                      >
                        Reset Password
                      </Button>
                    )}
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
    </>
  );
};
