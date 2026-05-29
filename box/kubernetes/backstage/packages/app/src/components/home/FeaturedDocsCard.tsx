import React from 'react';
import { Card, CardBody, Flex, Text, Skeleton, Link } from '@backstage/ui';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { useAsync } from 'react-use';
import { Entity } from '@backstage/catalog-model';
import { EntityFilterQuery } from '@backstage/catalog-client';

interface FeaturedDocsCardProps {
  filter: EntityFilterQuery;
}

export const FeaturedDocsCard = ({ filter }: FeaturedDocsCardProps) => {
  const catalogApi = useApi(catalogApiRef);

  const { value: entities, loading, error } = useAsync(async () => {
    const response = await catalogApi.getEntities({
      filter,
      fields: [
        'kind',
        'metadata.name',
        'metadata.namespace',
        'metadata.description',
      ],
      limit: 10,
    });
    return response.items;
  }, []);

  return (
    <Card style={{ height: '100%' }}>
      <CardBody>
        <Flex direction="column" gap="3">
          <Flex justify="between" align="center">
            <Text variant="title-small" weight="bold">Featured Docs</Text>
            {!loading && !error && entities && (
              <Flex align="center" gap="1">
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 24,
                  height: 24,
                  padding: '0 8px',
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 700,
                  backgroundColor: 'rgba(128,128,128,0.25)',
                  color: 'rgba(255,255,255,0.7)',
                }}>
                  {entities.length}
                </span>
                <Text variant="body-small" color="secondary">Docs</Text>
              </Flex>
            )}
          </Flex>

          {loading ? (
            <Flex direction="column" gap="3">
              <Skeleton width="60%" height={20} />
              <Skeleton width="100%" height={16} />
              <Skeleton width="60%" height={20} />
              <Skeleton width="100%" height={16} />
            </Flex>
          ) : error ? (
            <Text color="secondary">Failed to load docs: {error.message}</Text>
          ) : !entities?.length ? (
            <Flex justify="center" p="4">
              <Text color="secondary">No documentation found</Text>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              {entities.map((entity: Entity) => {
                const name = entity.metadata.name;
                const namespace = entity.metadata.namespace ?? 'default';
                const kind = entity.kind;
                const docsPath = `/docs/${namespace}/${kind}/${name}/`;
                return (
                  <Flex direction="column" gap="1" key={`${namespace}/${kind}/${name}`}>
                    <Link href={docsPath} style={{ fontWeight: 600, fontSize: 15 }}>
                      {name}
                    </Link>
                    {entity.metadata.description && (
                      <Text variant="body-small" color="secondary">
                        {entity.metadata.description}
                      </Text>
                    )}
                  </Flex>
                );
              })}
            </Flex>
          )}

          <Flex justify="center">
            <Link href="/docs" style={{ fontSize: 14 }}>
              View all docs
            </Link>
          </Flex>
        </Flex>
      </CardBody>
    </Card>
  );
};
