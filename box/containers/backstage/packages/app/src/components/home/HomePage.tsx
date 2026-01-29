import React from 'react';
import { Grid, makeStyles } from '@material-ui/core';
import {
  HomePageStarredEntities,
  HomePageRecentlyVisited,
  HomePageTopVisited,
  HomePageToolkit,
  HeaderWorldClock,
  ClockConfig,
  FeaturedDocsCard,
} from '@backstage/plugin-home';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { useEffect, useState } from 'react';
import { SearchContextProvider } from '@backstage/plugin-search-react';
import {
  Content,
  Page,
  InfoCard,
  Header,
} from '@backstage/core-components';
import { HomePageSearchBar } from '@backstage/plugin-search';
import CategoryIcon from '@material-ui/icons/Category';
import ExtensionIcon from '@material-ui/icons/Extension';
import LibraryBooks from '@material-ui/icons/LibraryBooks';
import CreateComponentIcon from '@material-ui/icons/AddCircleOutline';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';

const useStyles = makeStyles(theme => ({
  searchBarInput: {
    maxWidth: '60vw',
    margin: 'auto',
    backgroundColor: theme.palette.background.paper,
    borderRadius: '50px',
    boxShadow: theme.shadows[1],
  },
  searchBarOutline: {
    borderStyle: 'none',
  },
  container: {
    margin: theme.spacing(5, 0),
  },
  logo: {
    width: 'auto',
    height: 100,
  },
}));

const clockConfigs: ClockConfig[] = [
  {
    label: 'Seoul',
    timeZone: 'Asia/Seoul',
  },
  {
    label: 'UTC',
    timeZone: 'UTC',
  },
];

const getTimeBasedGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
};

const CustomWelcomeTitle = () => {
  const identityApi = useApi(identityApiRef);
  const [displayName, setDisplayName] = useState<string>('');
  const greeting = getTimeBasedGreeting();

  useEffect(() => {
    identityApi.getProfileInfo().then(profile => {
      setDisplayName(profile.displayName || 'Guest');
    });
  }, [identityApi]);

  return <>{greeting}, {displayName}!</>;
};

export const HomePage = () => {
  const classes = useStyles();

  return (
    <SearchContextProvider>
      <Page themeId="home">
        <Header title={<CustomWelcomeTitle />} pageTitleOverride="Home">
          <HeaderWorldClock clockConfigs={clockConfigs} />
        </Header>
        <Content>
          <Grid container justifyContent="center" spacing={6}>
            {/* Search Bar */}
            <Grid item xs={12} md={8}>
              <HomePageSearchBar
                InputProps={{
                  classes: {
                    root: classes.searchBarInput,
                    notchedOutline: classes.searchBarOutline,
                  },
                }}
                placeholder="Search components, APIs, docs..."
              />
            </Grid>

            {/* Quick Links */}
            <Grid item xs={12} md={6}>
              <HomePageToolkit
                title="Quick Links"
                tools={[
                  {
                    url: '/catalog',
                    label: 'Catalog',
                    icon: <CategoryIcon />,
                  },
                  {
                    url: '/api-docs',
                    label: 'APIs',
                    icon: <ExtensionIcon />,
                  },
                  {
                    url: '/openapi-registry',
                    label: 'API Registry',
                    icon: <CloudUploadIcon />,
                  },
                  {
                    url: '/docs',
                    label: 'TechDocs',
                    icon: <LibraryBooks />,
                  },
                  {
                    url: '/create',
                    label: 'Create',
                    icon: <CreateComponentIcon />,
                  },
                ]}
              />
            </Grid>

            {/* Starred Entities */}
            <Grid item xs={12} md={6}>
              <HomePageStarredEntities />
            </Grid>

            {/* Recently Visited */}
            <Grid item xs={12} md={6}>
              <HomePageRecentlyVisited />
            </Grid>

            {/* Top Visited - Most frequently visited entities */}
            <Grid item xs={12} md={6}>
              <HomePageTopVisited />
            </Grid>

            {/* Featured Docs - Highlighted documentation */}
            <Grid item xs={12} md={6}>
              <FeaturedDocsCard
                filter={{
                  kind: 'Component',
                }}
              />
            </Grid>
          </Grid>
        </Content>
      </Page>
    </SearchContextProvider>
  );
};
