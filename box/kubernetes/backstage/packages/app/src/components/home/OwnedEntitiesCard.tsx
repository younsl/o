import React, { useState } from 'react';
import { Card, CardBody, Flex, Text, Skeleton, Tabs, TabList, Tab, TabPanel, Link } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import {
  catalogApiRef,
  useEntityOwnership,
  useStarredEntities,
} from '@backstage/plugin-catalog-react';
import { useAsync } from 'react-use';
import { Entity, parseEntityRef } from '@backstage/catalog-model';

const kindColors: Record<string, string> = {
  Component: '#3b82f6',
  API: '#8b5cf6',
  System: '#10b981',
  Resource: '#f59e0b',
  Domain: '#ef4444',
  Template: '#6366f1',
  Group: '#14b8a6',
  User: '#64748b',
};

const badgeStyle = (kind: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  backgroundColor: `${kindColors[kind] ?? '#6b7280'}22`,
  color: kindColors[kind] ?? '#6b7280',
  border: `1px solid ${kindColors[kind] ?? '#6b7280'}44`,
});

const typeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 12,
  backgroundColor: 'var(--bui-color-bg-elevated, #2a2a2a)',
  border: '1px solid var(--bui-color-border-default, #444)',
  color: 'var(--bui-color-text-secondary, #aaa)',
};

const countBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 20,
  height: 20,
  padding: '0 6px',
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 700,
  backgroundColor: 'rgba(128,128,128,0.25)',
  color: 'rgba(255,255,255,0.7)',
  marginLeft: 6,
};

const EntityList = ({ entities }: { entities: Entity[] }) => (
  <Flex direction="column" gap="1">
    {entities.map((entity: Entity) => {
      const kind = entity.kind;
      const name = entity.metadata.name;
      const title = entity.metadata.title;
      const namespace = entity.metadata.namespace ?? 'default';
      const type = (entity.spec as any)?.type;
      return (
        <Link
          key={`${namespace}/${kind}/${name}`}
          href={`/catalog/${namespace}/${kind.toLowerCase()}/${name}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <Flex
            align="center"
            gap="2"
            p="2"
            style={{ borderRadius: 4, transition: 'background-color 0.15s' }}
            className="owned-entity-row"
          >
            <span style={badgeStyle(kind)}>{kind}</span>
            <Text variant="body-small" weight="bold" style={{ flex: 1 }}>
              {title || name}
            </Text>
            {type && <span style={typeStyle}>{type}</span>}
          </Flex>
        </Link>
      );
    })}
  </Flex>
);

const LoadingSkeleton = () => (
  <Flex direction="column" gap="2">
    <Skeleton width="100%" height={32} />
    <Skeleton width="100%" height={32} />
    <Skeleton width="100%" height={32} />
  </Flex>
);

export const OwnedEntitiesCard = () => {
  const catalogApi = useApi(catalogApiRef);
  const { loading: ownershipLoading, isOwnedEntity } = useEntityOwnership();
  const { starredEntities } = useStarredEntities();
  const [activeTab, setActiveTab] = useState<string>('starred');

  const { value: entities, loading: entitiesLoading, error } = useAsync(async () => {
    const response = await catalogApi.getEntities({
      fields: [
        'kind',
        'metadata.name',
        'metadata.title',
        'metadata.namespace',
        'spec.type',
        'relations',
      ],
    });
    return response.items;
  }, []);

  const loading = ownershipLoading || entitiesLoading;

  const ownedEntities = React.useMemo(() => {
    if (!entities || ownershipLoading) return [];
    return entities.filter(e => isOwnedEntity(e));
  }, [entities, ownershipLoading, isOwnedEntity]);

  const starredEntityList = React.useMemo(() => {
    if (!entities || starredEntities.size === 0) return [];
    const starredRefs = new Set(
      [...starredEntities].map(ref => {
        const parsed = parseEntityRef(ref);
        return `${parsed.kind}:${parsed.namespace}/${parsed.name}`.toLowerCase();
      }),
    );
    return entities.filter(e => {
      const ns = e.metadata.namespace ?? 'default';
      const key = `${e.kind}:${ns}/${e.metadata.name}`.toLowerCase();
      return starredRefs.has(key);
    });
  }, [entities, starredEntities]);

  return (
    <Card style={{ height: '100%' }}>
      <CardBody>
        <Flex direction="column" gap="3">
          <Tabs selectedKey={activeTab} onSelectionChange={key => setActiveTab(key as string)}>
            <TabList>
              <Tab id="starred">
                <Flex align="center">
                  Starred
                  {!loading && (
                    <span style={countBadgeStyle}>{starredEntityList.length}</span>
                  )}
                </Flex>
              </Tab>
              <Tab id="owned">
                <Flex align="center">
                  Owned
                  {!loading && !error && (
                    <span style={countBadgeStyle}>{ownedEntities.length}</span>
                  )}
                </Flex>
              </Tab>
            </TabList>
            <TabPanel id="owned">
              {loading ? (
                <LoadingSkeleton />
              ) : error ? (
                <Text color="secondary">Failed to load entities: {error.message}</Text>
              ) : ownedEntities.length === 0 ? (
                <Flex justify="center" p="4">
                  <Text color="secondary">No owned entities found</Text>
                </Flex>
              ) : (
                <EntityList entities={ownedEntities} />
              )}
            </TabPanel>
            <TabPanel id="starred">
              {loading ? (
                <LoadingSkeleton />
              ) : starredEntityList.length === 0 ? (
                <Flex justify="center" p="4">
                  <Text color="secondary">No starred entities yet</Text>
                </Flex>
              ) : (
                <EntityList entities={starredEntityList} />
              )}
            </TabPanel>
          </Tabs>
        </Flex>
      </CardBody>
    </Card>
  );
};
