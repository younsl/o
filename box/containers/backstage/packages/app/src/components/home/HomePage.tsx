import React from 'react';
import {
  Container,
  Flex,
  Grid,
  HeaderPage,
  Text,
} from '@backstage/ui';
import { useUserProfile } from '@backstage/plugin-user-settings';
import { useGreeting } from './hooks';
import { HomeSearchBar } from './HomeSearchBar';
import { QuickLinksCard } from './QuickLinksCard';
import { OwnedEntitiesCard } from './OwnedEntitiesCard';
import { FeaturedDocsCard } from './FeaturedDocsCard';
import './HomePage.css';

export const HomePage = () => {
  const greeting = useGreeting();
  const { backstageIdentity } = useUserProfile();
  const userEntity = backstageIdentity?.userEntityRef;

  return (
    <>
      <HeaderPage
        title={greeting}
        customActions={
          userEntity ? (
            <Flex direction="row" gap="1" align="center">
              <Text variant="body-small" color="secondary">User Entity:</Text>
              <Text variant="body-small">{userEntity}</Text>
            </Flex>
          ) : undefined
        }
      />
      <Container>
        <Flex direction="column" gap="6" align="center" mt="5">
          {/* Search Bar */}
          <HomeSearchBar />

          {/* Content Grid */}
          <Grid.Root columns={{ initial: '1', md: '2' }} gap="6" style={{ width: '100%' }}>
            {/* Quick Links */}
            <Grid.Item>
              <QuickLinksCard />
            </Grid.Item>

            {/* Owned Entities */}
            <Grid.Item>
              <OwnedEntitiesCard />
            </Grid.Item>

            {/* Featured Docs */}
            <Grid.Item>
              <FeaturedDocsCard filter={{ kind: 'Component' }} />
            </Grid.Item>
          </Grid.Root>
        </Flex>
      </Container>
    </>
  );
};
