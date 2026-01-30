import React, { useState, useMemo } from 'react';
import {
  Grid,
  Card,
  CardContent,
  CardActionArea,
  Typography,
  Chip,
  TextField,
  InputAdornment,
  makeStyles,
} from '@material-ui/core';
import { Page, Header, Content } from '@backstage/core-components';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import SearchIcon from '@material-ui/icons/Search';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';

const FALLBACK_LOGO = 'https://backstage.io/logo_assets/svg/Icon_Teal.svg';

const useStyles = makeStyles(theme => ({
  searchContainer: {
    marginBottom: theme.spacing(3),
  },
  searchField: {
    maxWidth: 400,
  },
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  filterSection: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(3),
  },
  filterLabel: {
    fontSize: '0.875rem',
    color: theme.palette.text.secondary,
    marginRight: theme.spacing(1),
  },
  filterChip: {
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  filterChipSelected: {
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    '&:hover': {
      backgroundColor: theme.palette.primary.dark,
    },
  },
  categorySection: {
    marginBottom: theme.spacing(4),
  },
  categoryTitle: {
    marginBottom: theme.spacing(0.5),
    fontWeight: 500,
    color: theme.palette.text.primary,
  },
  categoryDescription: {
    marginBottom: theme.spacing(2),
    color: theme.palette.text.secondary,
    fontSize: '0.875rem',
  },
  card: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 0.2s, box-shadow 0.2s',
    '&:hover': {
      transform: 'translateY(-4px)',
      boxShadow: theme.shadows[8],
    },
  },
  cardActionArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    height: '100%',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(0.5),
  },
  externalIcon: {
    fontSize: 16,
    color: theme.palette.text.secondary,
    opacity: 0.6,
  },
  logoContainer: {
    height: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing(2),
    backgroundColor: theme.palette.background.default,
    overflow: 'hidden',
  },
  logo: {
    maxHeight: 60,
    maxWidth: '80%',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
  },
  cardContent: {
    flexGrow: 1,
  },
  tagChip: {
    height: 20,
    fontSize: '0.7rem',
    fontWeight: 500,
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255, 255, 255, 0.12)'
      : 'rgba(0, 0, 0, 0.08)',
    color: theme.palette.text.secondary,
    border: `1px solid ${theme.palette.divider}`,
  },
  chipContainer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: theme.spacing(1),
  },
  noResults: {
    textAlign: 'center',
    padding: theme.spacing(4),
    color: theme.palette.text.secondary,
  },
}));

interface Platform {
  name: string;
  category: string;
  description: string;
  url: string;
  logo: string;
  tags: string[];
}

interface CategoryGroup {
  name: string;
  platforms: Platform[];
}

export const PlatformsPage = () => {
  const classes = useStyles();
  const configApi = useApi(configApiRef);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Read platforms from app-config.yaml (flat structure)
  const platformsConfig = configApi.getOptionalConfigArray('app.platforms') ?? [];
  const allPlatforms: Platform[] = platformsConfig.map(item => ({
    name: item.getString('name'),
    category: item.getString('category'),
    description: item.getString('description'),
    url: item.getString('url'),
    logo: item.getString('logo'),
    tags: (item.getOptionalString('tags') ?? '').split(',').filter(t => t.trim()),
  }));

  // Extract all unique tags
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    allPlatforms.forEach(platform => {
      platform.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [allPlatforms]);

  // Toggle tag selection
  const handleTagToggle = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  // Clear all filters
  const handleClearFilters = () => {
    setSearchQuery('');
    setSelectedTags([]);
  };

  // Filter platforms based on search query and selected tags
  const filteredPlatforms = allPlatforms.filter(platform => {
    // Tag filter
    if (selectedTags.length > 0) {
      const hasSelectedTag = selectedTags.some(tag => platform.tags.includes(tag));
      if (!hasSelectedTag) return false;
    }

    // Text search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      return (
        platform.name.toLowerCase().includes(query) ||
        platform.description.toLowerCase().includes(query) ||
        platform.category.toLowerCase().includes(query) ||
        platform.tags.some(tag => tag.toLowerCase().includes(query))
      );
    }

    return true;
  });

  // Group by category
  const categoryOrder = ['Observability', 'CI/CD', 'Security', 'Infrastructure', 'Data', 'Registry', 'Documentation'];
  const categoryDescriptions: Record<string, string> = {
    'Observability': '시스템 상태를 모니터링하고 문제를 신속하게 파악하기 위한 도구',
    'CI/CD': '코드 변경사항을 자동으로 빌드, 테스트, 배포하기 위한 도구',
    'Security': '보안 취약점 분석 및 접근 제어를 위한 도구',
    'Infrastructure': '인프라 및 네트워크 자원을 관리하기 위한 도구',
    'Data': '데이터 분석, 저장 및 거버넌스를 위한 도구',
    'Registry': '컨테이너 이미지 및 아티팩트를 저장하기 위한 도구',
    'Documentation': '문서화 및 프로젝트 관리를 위한 도구',
  };
  const groupedByCategory = filteredPlatforms.reduce<Record<string, Platform[]>>((acc, platform) => {
    if (!acc[platform.category]) {
      acc[platform.category] = [];
    }
    acc[platform.category].push(platform);
    return acc;
  }, {});

  const categories: CategoryGroup[] = categoryOrder
    .filter(cat => groupedByCategory[cat])
    .map(cat => ({
      name: cat,
      platforms: groupedByCategory[cat],
    }));

  const totalPlatforms = allPlatforms.length;
  const filteredCount = filteredPlatforms.length;
  const hasActiveFilters = searchQuery || selectedTags.length > 0;

  return (
    <Page themeId="tool">
      <Header title="Platforms" subtitle="Internal platform services for developers" />
      <Content>
        <div className={classes.headerRow}>
          <Typography variant="h4" style={{ fontWeight: 500 }}>
            {hasActiveFilters ? `${filteredCount} / ${totalPlatforms}` : totalPlatforms} Platforms
          </Typography>
          <TextField
            className={classes.searchField}
            variant="outlined"
            size="small"
            placeholder="Search platforms..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
          />
        </div>

        {allTags.length > 0 && (
          <div className={classes.filterSection}>
            <Typography className={classes.filterLabel}>Tags:</Typography>
            {allTags.map(tag => (
              <Chip
                key={tag}
                label={tag}
                size="small"
                onClick={() => handleTagToggle(tag)}
                className={`${classes.filterChip} ${
                  selectedTags.includes(tag) ? classes.filterChipSelected : ''
                }`}
                variant={selectedTags.includes(tag) ? 'default' : 'outlined'}
              />
            ))}
            {hasActiveFilters && (
              <Chip
                label="Clear"
                size="small"
                onClick={handleClearFilters}
                onDelete={handleClearFilters}
                color="secondary"
              />
            )}
          </div>
        )}

        {categories.length === 0 ? (
          <Typography className={classes.noResults}>
            No platforms found {searchQuery && `matching "${searchQuery}"`}
            {selectedTags.length > 0 && ` with tags: ${selectedTags.join(', ')}`}
          </Typography>
        ) : (
          categories.map(category => (
            <div key={category.name} className={classes.categorySection}>
              <Typography variant="h5" className={classes.categoryTitle}>
                {category.name} ({category.platforms.length})
              </Typography>
              <Typography className={classes.categoryDescription}>
                {categoryDescriptions[category.name]}
              </Typography>
              <Grid container spacing={3}>
                {category.platforms.map(platform => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={platform.name}>
                    <Card className={classes.card}>
                      <CardActionArea
                        component="a"
                        href={platform.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={classes.cardActionArea}
                      >
                        <div className={classes.logoContainer}>
                          <img
                            className={classes.logo}
                            src={platform.logo}
                            alt={platform.name}
                            onError={e => {
                              e.currentTarget.src = FALLBACK_LOGO;
                            }}
                          />
                        </div>
                        <CardContent className={classes.cardContent}>
                          <div className={classes.titleRow}>
                            <Typography variant="h6">
                              {platform.name}
                            </Typography>
                            <OpenInNewIcon className={classes.externalIcon} />
                          </div>
                          <Typography variant="body2" color="textSecondary">
                            {platform.description}
                          </Typography>
                          <div className={classes.chipContainer}>
                            {platform.tags.map(tag => (
                              <Chip
                                key={tag}
                                label={tag}
                                size="small"
                                className={classes.tagChip}
                                onClick={e => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleTagToggle(tag);
                                }}
                              />
                            ))}
                          </div>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </div>
          ))
        )}
      </Content>
    </Page>
  );
};
