import React, { useEffect, useState } from 'react';
import { Accordion, AccordionPanel, AccordionTrigger, Card, CardBody, Flex, Link, Tag, TagGroup, Text } from '@backstage/ui';
import { BUILD_INFO } from '../../buildInfo';

const formatUptime = (buildDate: string): string => {
  const diff = Date.now() - new Date(buildDate).getTime();
  if (diff < 0) return '0s';
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
};

const labelStyle: React.CSSProperties = {
  width: 160,
  color: 'var(--bui-color-text-secondary)',
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'monospace',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 20,
  height: 20,
  padding: '0 6px',
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 600,
  backgroundColor: 'var(--bui-color-bg-elevated, #333)',
  color: 'var(--bui-color-text-primary, #fff)',
};

const pluginCategories = [
  {
    title: 'Official',
    description: 'Backstage official plugins. BUI components are recommended.',
    filter: (p: { name: string }) => p.name.startsWith('@backstage/plugin-'),
  },
  {
    title: 'Community',
    description: 'Community-maintained plugins from @backstage-community.',
    filter: (p: { name: string }) =>
      p.name.startsWith('@backstage-community/plugin-'),
  },
  {
    title: 'Custom',
    description: 'In-house plugins developed for this instance.',
    filter: (p: { name: string }) => p.name.startsWith('@internal/plugin-'),
  },
];

export const BuildInfoSettings = () => {
  const [uptime, setUptime] = useState(() => formatUptime(BUILD_INFO.buildDate));

  useEffect(() => {
    const interval = setInterval(() => {
      setUptime(formatUptime(BUILD_INFO.buildDate));
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const releaseUrl = BUILD_INFO.backstageVersion === 'unknown'
    ? 'https://github.com/backstage/backstage/releases'
    : `https://github.com/backstage/backstage/releases/tag/v${BUILD_INFO.backstageVersion}`;

  return (
    <Flex direction="column" gap="4">
      <Card>
        <CardBody>
          <Flex direction="column" gap="3">
            <Text variant="title-small" weight="bold">Build Information</Text>
            <Flex direction="row" gap="2" align="center">
              <Text variant="body-medium" weight="bold" style={labelStyle}>
                Backstage Version
              </Text>
              <Link href={releaseUrl} target="_blank" style={valueStyle}>
                {BUILD_INFO.backstageVersion}
              </Link>
            </Flex>
            {BUILD_INFO.commitSha !== 'unknown' && (
              <Flex direction="row" gap="2" align="center">
                <Text variant="body-medium" weight="bold" style={labelStyle}>
                  Commit SHA
                </Text>
                <Text variant="body-medium" style={valueStyle}>
                  {BUILD_INFO.commitSha}
                </Text>
              </Flex>
            )}
            <Flex direction="row" gap="2" align="center">
              <Text variant="body-medium" weight="bold" style={labelStyle}>
                Build Date
              </Text>
              <Text variant="body-medium" style={valueStyle}>
                {BUILD_INFO.buildDate.slice(0, 10)}
              </Text>
            </Flex>
            <Flex direction="row" gap="2" align="center">
              <Text variant="body-medium" weight="bold" style={labelStyle}>
                Uptime
              </Text>
              <Text variant="body-medium" style={valueStyle}>
                {uptime}
              </Text>
            </Flex>
            {/* Installed Plugins (collapsed) */}
            <Accordion>
              <AccordionTrigger
                title="Installed Plugins"
                subtitle={`${BUILD_INFO.plugins.length} plugins`}
              />
              <AccordionPanel>
                <Flex direction="column" gap="3" style={{ paddingTop: 8 }}>
                  {pluginCategories.map(({ title, description, filter }) => {
                    const plugins = BUILD_INFO.plugins.filter(filter);
                    if (plugins.length === 0) return null;
                    return (
                      <Flex key={title} direction="column" gap="2">
                        <Flex direction="row" gap="2" align="center">
                          <Text variant="body-medium" weight="bold">{title}</Text>
                          <span style={badgeStyle}>{plugins.length}</span>
                        </Flex>
                        <Text variant="body-small" color="secondary">{description}</Text>
                        <TagGroup>
                          {plugins.map(plugin => (
                            <Tag key={plugin.name} id={`bi-${plugin.name}`} size="small">
                              {plugin.name}@{plugin.version}
                            </Tag>
                          ))}
                        </TagGroup>
                      </Flex>
                    );
                  })}
                </Flex>
              </AccordionPanel>
            </Accordion>
          </Flex>
        </CardBody>
      </Card>
      <Accordion>
        <AccordionTrigger
          title="BUI Migration"
          subtitle={`${BUILD_INFO.buiMigration.percent}% migrated`}
        />
        <AccordionPanel>
          <Flex direction="column" gap="5" style={{ paddingTop: 8 }}>
            {/* Stacked bar */}
            <Flex align="center" gap="2">
              <div style={{
                flex: 1,
                height: 22,
                borderRadius: 6,
                overflow: 'hidden',
                display: 'flex',
                backgroundColor: 'rgba(128,128,128,0.25)',
              }}>
                {BUILD_INFO.buiMigration.buiOnly > 0 && (
                  <div style={{
                    width: `${(BUILD_INFO.buiMigration.buiOnly / BUILD_INFO.buiMigration.total) * 100}%`,
                    height: '100%',
                    backgroundColor: '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#fff',
                  }}>
                    {BUILD_INFO.buiMigration.buiOnly}
                  </div>
                )}
                {BUILD_INFO.buiMigration.mixed > 0 && (
                  <div style={{
                    width: `${(BUILD_INFO.buiMigration.mixed / BUILD_INFO.buiMigration.total) * 100}%`,
                    height: '100%',
                    backgroundColor: '#f59e0b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#fff',
                  }}>
                    {BUILD_INFO.buiMigration.mixed}
                  </div>
                )}
                {BUILD_INFO.buiMigration.muiOnly > 0 && (
                  <div style={{
                    width: `${(BUILD_INFO.buiMigration.muiOnly / BUILD_INFO.buiMigration.total) * 100}%`,
                    height: '100%',
                    backgroundColor: '#ef4444',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#fff',
                  }}>
                    {BUILD_INFO.buiMigration.muiOnly}
                  </div>
                )}
              </div>
              <Text variant="body-small" color="secondary" style={{ whiteSpace: 'nowrap' }}>
                {BUILD_INFO.buiMigration.buiOnly} / {BUILD_INFO.buiMigration.total} files
              </Text>
            </Flex>

            {/* BUI files */}
            {BUILD_INFO.buiMigration.files.bui.length > 0 && (
              <Flex direction="column" gap="2">
                <Flex direction="row" gap="2" align="center">
                  <Text variant="body-medium" weight="bold">BUI (Backstage UI)</Text>
                  <span style={{ ...badgeStyle, backgroundColor: '#10b981' }}>
                    {BUILD_INFO.buiMigration.files.bui.length}
                  </span>
                </Flex>
                <Text variant="body-small" color="secondary">
                  Fully migrated to @backstage/ui components.
                </Text>
                <TagGroup>
                  {BUILD_INFO.buiMigration.files.bui.map(f => (
                    <Tag key={f} id={f} size="small">{f.replace(/.*\//, '').replace(/\.tsx$/, '')}</Tag>
                  ))}
                </TagGroup>
              </Flex>
            )}

            {/* Mixed files */}
            {BUILD_INFO.buiMigration.files.mixed.length > 0 && (
              <Flex direction="column" gap="2">
                <Flex direction="row" gap="2" align="center">
                  <Text variant="body-medium" weight="bold">Mixed</Text>
                  <span style={{ ...badgeStyle, backgroundColor: '#f59e0b' }}>
                    {BUILD_INFO.buiMigration.files.mixed.length}
                  </span>
                </Flex>
                <Text variant="body-small" color="secondary">
                  Uses both @backstage/ui and @material-ui. Needs further migration.
                </Text>
                <TagGroup>
                  {BUILD_INFO.buiMigration.files.mixed.map(f => (
                    <Tag key={f} id={f} size="small">{f.replace(/.*\//, '').replace(/\.tsx$/, '')}</Tag>
                  ))}
                </TagGroup>
              </Flex>
            )}

            {/* MUI files */}
            {BUILD_INFO.buiMigration.files.mui.length > 0 && (
              <Flex direction="column" gap="2">
                <Flex direction="row" gap="2" align="center">
                  <Text variant="body-medium" weight="bold">MUI (Material UI)</Text>
                  <span style={{ ...badgeStyle, backgroundColor: '#ef4444' }}>
                    {BUILD_INFO.buiMigration.files.mui.length}
                  </span>
                </Flex>
                <Text variant="body-small" color="secondary">
                  Still uses @material-ui only. Migration required.
                </Text>
                <TagGroup>
                  {BUILD_INFO.buiMigration.files.mui.map(f => (
                    <Tag key={f} id={f} size="small">{f.replace(/.*\//, '').replace(/\.tsx$/, '')}</Tag>
                  ))}
                </TagGroup>
              </Flex>
            )}

            {/* Why BUI */}
            <div style={{
              borderTop: '1px solid var(--bui-color-border-default, #333)',
              paddingTop: 16,
            }}>
              <Flex direction="column" gap="2">
                <Text variant="body-medium" weight="bold">Why BUI?</Text>
                <Text variant="body-small" color="secondary">
                  Backstage UI (BUI) replaces Material UI with a CSS-first, headless component system built on Base UI.
                  Material Design was too opinionated for adopter branding, theming was hard to evolve across plugins,
                  and mixing MUI with Backstage core components caused inconsistency.
                  BUI provides plugin-aware theming, unified component strategy, and aligns with MUI's own Base UI direction for v8+.
                </Text>
                <Flex direction="column" gap="1" style={{ marginTop: 4 }}>
                  <Link href="https://github.com/backstage/backstage/issues/27726" target="_blank">
                    <Text variant="body-small">RFC: New design system for Backstage</Text>
                  </Link>
                  <Link href="https://github.com/backstage/backstage/issues/31467" target="_blank">
                    <Text variant="body-small">MUI to BUI Migration Tracking</Text>
                  </Link>
                  <Link href="https://backstage.io/docs/conf/user-interface/" target="_blank">
                    <Text variant="body-small">Customizing Your App's UI (Official Docs)</Text>
                  </Link>
                </Flex>
              </Flex>
            </div>
          </Flex>
        </AccordionPanel>
      </Accordion>
    </Flex>
  );
};
