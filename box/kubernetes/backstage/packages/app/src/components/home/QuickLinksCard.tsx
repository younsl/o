import React from 'react';
import {
  Card,
  CardBody,
  Flex,
  Grid,
  Link,
  Text,
  Tooltip,
  TooltipTrigger,
} from '@backstage/ui';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { quickLinks } from './homeConfig';
import { useIamPendingCount } from './hooks';

const iconStyle: React.CSSProperties = {
  fontSize: 32,
  marginBottom: 8,
  color: 'var(--bui-color-text-accent, #90caf9)',
};

const quickLinkBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 9,
  fontSize: 11,
  fontWeight: 700,
  backgroundColor: 'var(--bui-color-text-accent, #90caf9)',
  color: 'var(--bui-color-bg-default, #121212)',
};

export const QuickLinksCard = () => {
  const configApi = useApi(configApiRef);
  const platformsCount = (configApi.getOptionalConfigArray('app.platforms') ?? []).length;
  const iamPendingCount = useIamPendingCount();

  const links = quickLinks.map(link => {
    if (link.url === '/platforms' && platformsCount > 0) return { ...link, badge: platformsCount };
    if (link.url === '/iam-user-audit') return { ...link, badge: iamPendingCount };
    return link;
  });

  return (
    <Card style={{ height: '100%' }}>
      <CardBody>
        <Flex direction="column" gap="3">
          <Text variant="title-small" weight="bold">Quick Links</Text>
          <Grid.Root columns="3" gap="2">
            {links.map(({ url, label, Icon, description, badge }) => (
              <Grid.Item key={url}>
                <TooltipTrigger delay={200}>
                  <Link href={url} className="home-quick-link">
                    <Flex direction="column" align="center" gap="1">
                      <Icon style={iconStyle} />
                      <Flex align="center" gap="1">
                        <Text variant="body-small" weight="bold">{label}</Text>
                        {badge !== undefined && (
                          <span style={quickLinkBadgeStyle}>{badge}</span>
                        )}
                      </Flex>
                    </Flex>
                  </Link>
                  <Tooltip>{description}</Tooltip>
                </TooltipTrigger>
              </Grid.Item>
            ))}
          </Grid.Root>
        </Flex>
      </CardBody>
    </Card>
  );
};
