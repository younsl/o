import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Grid,
  Card,
  CardContent,
  CardActionArea,
  Typography,
  Chip,
  TextField,
  InputAdornment,
  IconButton,
  makeStyles,
} from '@material-ui/core';
import { Page, Header, Content } from '@backstage/core-components';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import SearchIcon from '@material-ui/icons/Search';
import OpenInNewIcon from '@material-ui/icons/OpenInNew';
import WarningIcon from '@material-ui/icons/Warning';
import StarIcon from '@material-ui/icons/Star';
import StarBorderIcon from '@material-ui/icons/StarBorder';

const FALLBACK_LOGO = 'https://backstage.io/logo_assets/svg/Icon_Teal.svg';
const FAVORITES_STORAGE_KEY = 'backstage-platforms-favorites';

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
  vpnWarning: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255, 152, 0, 0.15)'
      : 'rgba(255, 152, 0, 0.1)',
    borderRadius: 4,
    fontSize: '0.7rem',
    color: theme.palette.warning.main,
  },
  starButton: {
    position: 'absolute',
    top: theme.spacing(0.5),
    right: theme.spacing(0.5),
    zIndex: 1,
    padding: theme.spacing(0.5),
  },
  starIcon: {
    fontSize: 20,
    color: '#ffc107',
  },
  starIconEmpty: {
    fontSize: 20,
    color: theme.palette.text.secondary,
    opacity: 0.5,
  },
  cardWrapper: {
    position: 'relative',
  },
  favoritesSection: {
    marginBottom: theme.spacing(4),
    padding: theme.spacing(2),
    backgroundColor: theme.palette.type === 'dark'
      ? 'rgba(255, 193, 7, 0.08)'
      : 'rgba(255, 193, 7, 0.05)',
    borderRadius: theme.shape.borderRadius,
    border: `1px solid ${theme.palette.type === 'dark' ? 'rgba(255, 193, 7, 0.2)' : 'rgba(255, 193, 7, 0.3)'}`,
  },
  favoritesTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(2),
  },
  favoritesTitle: {
    fontWeight: 500,
    color: theme.palette.text.primary,
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
  const [favorites, setFavorites] = useState<string[]>([]);

  // Load favorites from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (stored) {
        setFavorites(JSON.parse(stored));
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save favorites to localStorage
  const saveFavorites = useCallback((newFavorites: string[]) => {
    setFavorites(newFavorites);
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(newFavorites));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Toggle favorite status
  const handleToggleFavorite = useCallback((platformName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    saveFavorites(
      favorites.includes(platformName)
        ? favorites.filter(f => f !== platformName)
        : [...favorites, platformName]
    );
  }, [favorites, saveFavorites]);

  // Read platforms from app-config.yaml (flat structure)
  const platformsConfig = configApi.getOptionalConfigArray('app.platforms') ?? [];
  const allPlatforms: Platform[] = platformsConfig.map(item => ({
    name: item.getString('name'),
    category: item.getString('category'),
    description: item.getString('description'),
    url: item.getOptionalString('url') ?? '',
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

  // Separate favorites from filtered platforms
  const favoritePlatforms = filteredPlatforms.filter(p => favorites.includes(p.name));
  const nonFavoritePlatforms = filteredPlatforms.filter(p => !favorites.includes(p.name));

  // Group by category (only non-favorites)
  const categoryOrder = ['Developer Portal', 'Observability', 'CI/CD', 'Security', 'Infrastructure', 'Data', 'Registry', 'Documentation'];
  const categoryDescriptions: Record<string, string> = {
    'Developer Portal': '개발자 경험 향상을 위한 통합 포털 및 플랫폼',
    'Observability': '시스템 상태를 모니터링하고 문제를 신속하게 파악하기 위한 도구',
    'CI/CD': '코드 변경사항을 자동으로 빌드, 테스트, 배포하기 위한 도구',
    'Security': '보안 취약점 분석 및 접근 제어를 위한 도구',
    'Infrastructure': '인프라 및 네트워크 자원을 관리하기 위한 도구',
    'Data': '데이터 분석, 저장 및 거버넌스를 위한 도구',
    'Registry': '컨테이너 이미지 및 아티팩트를 저장하기 위한 도구',
    'Documentation': '문서화 및 프로젝트 관리를 위한 도구',
  };
  const groupedByCategory = nonFavoritePlatforms.reduce<Record<string, Platform[]>>((acc, platform) => {
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

        {categories.length === 0 && favoritePlatforms.length === 0 ? (
          <Typography className={classes.noResults}>
            No platforms found {searchQuery && `matching "${searchQuery}"`}
            {selectedTags.length > 0 && ` with tags: ${selectedTags.join(', ')}`}
          </Typography>
        ) : (
          <>
            {/* Favorites Section */}
            {favoritePlatforms.length > 0 && (
              <div className={classes.favoritesSection}>
                <div className={classes.favoritesTitleRow}>
                  <StarIcon style={{ color: '#ffc107' }} />
                  <Typography variant="h5" className={classes.favoritesTitle}>
                    즐겨찾기 ({favoritePlatforms.length})
                  </Typography>
                </div>
                <Grid container spacing={3}>
                  {favoritePlatforms.map(platform => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={platform.name}>
                      <Card className={`${classes.card} ${classes.cardWrapper}`}>
                        <IconButton
                          className={classes.starButton}
                          onClick={e => handleToggleFavorite(platform.name, e)}
                          size="small"
                        >
                          <StarIcon className={classes.starIcon} />
                        </IconButton>
                        <CardActionArea
                            component="a"
                            href={platform.url || '#'}
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
                              {platform.tags.includes('prd') && (
                                <div className={classes.vpnWarning}>
                                  <WarningIcon style={{ fontSize: 14 }} />
                                  운영망 VPN 연결 필요
                                </div>
                              )}
                            </CardContent>
                          </CardActionArea>
                        </Card>
                    </Grid>
                  ))}
                </Grid>
              </div>
            )}

            {/* Categories */}
            {categories.map(category => (
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
                    <Card className={`${classes.card} ${classes.cardWrapper}`}>
                      <IconButton
                        className={classes.starButton}
                        onClick={e => handleToggleFavorite(platform.name, e)}
                        size="small"
                      >
                        {favorites.includes(platform.name) ? (
                          <StarIcon className={classes.starIcon} />
                        ) : (
                          <StarBorderIcon className={classes.starIconEmpty} />
                        )}
                      </IconButton>
                        <CardActionArea
                          component="a"
                          href={platform.url || '#'}
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
                            {platform.tags.includes('prd') && (
                              <div className={classes.vpnWarning}>
                                <WarningIcon style={{ fontSize: 14 }} />
                                운영망 VPN 연결 필요
                              </div>
                            )}
                          </CardContent>
                        </CardActionArea>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </div>
          ))}
          </>
        )}
      </Content>
    </Page>
  );
};
