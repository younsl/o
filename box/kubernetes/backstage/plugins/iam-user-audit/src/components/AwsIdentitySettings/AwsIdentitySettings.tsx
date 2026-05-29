import React from 'react';
import {
  Alert,
  Card,
  CardBody,
  Flex,
  Link,
  Skeleton,
  Tag,
  TagGroup,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { useAsync } from 'react-use';
import { iamUserAuditApiRef } from '../../api';
import './AwsIdentitySettings.css';

export const AwsIdentitySettings = () => {
  const api = useApi(iamUserAuditApiRef);

  const { value: users, loading, error } = useAsync(async () => {
    return api.listUsers();
  }, []);

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString();
  };

  const getSeverityClass = (inactiveDays: number) => {
    if (inactiveDays >= 365) return 'aws-id-critical';
    if (inactiveDays >= 180) return 'aws-id-warning';
    if (inactiveDays >= 30) return 'aws-id-caution';
    return '';
  };

  if (loading) {
    return (
      <Flex direction="column" gap="3" mt="4">
        <Skeleton width="100%" height={200} />
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex direction="column" gap="2" mt="4">
        <Alert status="danger" title="Failed to load IAM identity" />
        <Text variant="body-small" color="secondary">
          {error.message}
        </Text>
      </Flex>
    );
  }

  if (!users || users.length === 0) {
    return (
      <Flex direction="column" align="center" gap="2" className="aws-id-empty">
        <Text variant="body-large" color="secondary">
          No IAM user linked to your account
        </Text>
        <Text variant="body-small" color="secondary">
          Your Backstage identity could not be matched to an AWS IAM user
        </Text>
      </Flex>
    );
  }

  const user = users[0];

  return (
    <Flex direction="column" gap="4" mt="4">
      <Card className={`aws-id-card ${getSeverityClass(user.inactiveDays)}`}>
        <CardBody className="aws-id-card-body">
          <div className="aws-id-header">
            <div>
              <Text variant="body-medium" weight="bold">
                {user.userName}
              </Text>
              <Text variant="body-x-small" color="secondary" className="aws-id-arn">
                {user.arn}
              </Text>
            </div>
            <div className="aws-id-inactive-badge">
              <TooltipTrigger delay={200}>
                <Text weight="bold" className="aws-id-inactive-days">
                  {user.inactiveDays}d
                </Text>
                <Tooltip>Inactive for {user.inactiveDays} days</Tooltip>
              </TooltipTrigger>
            </div>
          </div>

          <div className="aws-id-fields">
            <div className="aws-id-field">
              <Text variant="body-x-small" color="secondary" className="aws-id-field-label">
                User ID
              </Text>
              <Text variant="body-small" className="aws-id-field-value-mono">
                {user.userId}
              </Text>
            </div>

            <div className="aws-id-field">
              <Text variant="body-x-small" color="secondary" className="aws-id-field-label">
                Console Access
              </Text>
              <Text variant="body-small">
                {user.hasConsoleAccess ? 'Yes' : 'No'}
              </Text>
            </div>

            <div className="aws-id-field">
              <Text variant="body-x-small" color="secondary" className="aws-id-field-label">
                Console Last Used
              </Text>
              <Text variant="body-small">
                {formatDate(user.passwordLastUsed)}
              </Text>
            </div>

            <div className="aws-id-field">
              <Text variant="body-x-small" color="secondary" className="aws-id-field-label">
                Account Created
              </Text>
              <Text variant="body-small">
                {formatDate(user.createDate)}
              </Text>
            </div>
          </div>

          <div>
            <Text variant="body-x-small" color="secondary" className="aws-id-field-label">
              Access Keys
            </Text>
            <TagGroup>
              {user.accessKeys.length > 0 ? (
                user.accessKeys.map(key => (
                  <TooltipTrigger key={key.accessKeyId} delay={200}>
                    <Tag id={key.accessKeyId} size="small">
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
      </Card>
      <Text variant="body-small" color="secondary">
        Need to reset your password? Visit the{' '}
        <Link href="/iam-user-audit">IAM Audit</Link> page to submit a
        password reset request.
      </Text>
    </Flex>
  );
};
