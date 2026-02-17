import React from 'react';
import {
  Grid,
  makeStyles,
  Card,
  CardContent,
  Typography,
  Tooltip,
} from '@material-ui/core';
import { Link } from 'react-router-dom';
import {
  HomePageStarredEntities,
  HomePageRecentlyVisited,
  HomePageTopVisited,
  HeaderWorldClock,
  ClockConfig,
  FeaturedDocsCard,
} from '@backstage/plugin-home';
import { identityApiRef, useApi } from '@backstage/core-plugin-api';
import { useEffect, useState } from 'react';
import { SearchContextProvider } from '@backstage/plugin-search-react';
import { Header } from '@backstage/core-components';
import { Container } from '@backstage/ui';
import { HomePageSearchBar } from '@backstage/plugin-search';
import CategoryIcon from '@material-ui/icons/Category';
import ExtensionIcon from '@material-ui/icons/Extension';
import LibraryBooks from '@material-ui/icons/LibraryBooks';
import CreateComponentIcon from '@material-ui/icons/AddCircleOutline';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import DashboardIcon from '@material-ui/icons/Dashboard';

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
  quickLinksCard: {
    height: '100%',
  },
  quickLinksTitle: {
    fontWeight: 500,
    marginBottom: theme.spacing(2),
  },
  quickLinksGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: theme.spacing(2),
  },
  quickLinkItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    padding: theme.spacing(2),
    borderRadius: theme.shape.borderRadius,
    textDecoration: 'none',
    color: 'inherit',
    transition: 'background-color 0.2s',
    '&:hover': {
      backgroundColor: theme.palette.action.hover,
    },
  },
  quickLinkIcon: {
    fontSize: 32,
    marginBottom: theme.spacing(1),
    color: theme.palette.primary.main,
  },
  quickLinkLabel: {
    fontSize: '0.875rem',
    fontWeight: 500,
  },
  tooltip: {
    fontSize: '0.875rem',
    fontWeight: 500,
    padding: theme.spacing(1, 1.5),
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
      <>
        <Header title={<CustomWelcomeTitle />} pageTitleOverride="Home">
          <HeaderWorldClock clockConfigs={clockConfigs} />
        </Header>
        <Container>
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
              <Card className={classes.quickLinksCard}>
                <CardContent>
                  <Typography variant="h6" className={classes.quickLinksTitle}>
                    Quick Links
                  </Typography>
                  <div className={classes.quickLinksGrid}>
                    {[
                      {
                        url: '/platforms',
                        label: 'Platforms',
                        icon: <DashboardIcon className={classes.quickLinkIcon} />,
                        description: 'Internal platform services',
                      },
                      {
                        url: '/catalog',
                        label: 'Catalog',
                        icon: <CategoryIcon className={classes.quickLinkIcon} />,
                        description: 'Browse all registered entities',
                      },
                      {
                        url: '/api-docs',
                        label: 'APIs',
                        icon: <ExtensionIcon className={classes.quickLinkIcon} />,
                        description: 'Explore API documentation',
                      },
                      {
                        url: '/openapi-registry',
                        label: 'API Registry',
                        icon: <CloudUploadIcon className={classes.quickLinkIcon} />,
                        description: 'Upload and manage OpenAPI specs',
                      },
                      {
                        url: '/docs',
                        label: 'Docs',
                        icon: <LibraryBooks className={classes.quickLinkIcon} />,
                        description: 'Technical documentation',
                      },
                      {
                        url: '/create',
                        label: 'Create...',
                        icon: <CreateComponentIcon className={classes.quickLinkIcon} />,
                        description: 'Create new components from templates',
                      },
                    ].map(link => (
                      <Tooltip
                        key={link.url}
                        title={link.description}
                        arrow
                        placement="top"
                        classes={{ tooltip: classes.tooltip }}
                      >
                        <Link to={link.url} className={classes.quickLinkItem}>
                          {link.icon}
                          <Typography className={classes.quickLinkLabel}>
                            {link.label}
                          </Typography>
                        </Link>
                      </Tooltip>
                    ))}
                  </div>
                </CardContent>
              </Card>
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
        </Container>
      </>
    </SearchContextProvider>
  );
};
