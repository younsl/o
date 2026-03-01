import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Button,
  Card,
  CardBody,
  Container,
  Flex,
  Grid,
  PluginHeader,
  SearchField,
  Text,
} from '@backstage/ui';
import { configApiRef, useApi } from '@backstage/core-plugin-api';

const FALLBACK_LOGO = 'https://backstage.io/logo_assets/svg/Icon_Teal.svg';
const FAVORITES_STORAGE_KEY = 'backstage-platforms-favorites';

const tagStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 13,
  backgroundColor: 'var(--bui-color-bg-elevated, #2a2a2a)',
  border: '1px solid var(--bui-color-border-default, #444)',
  cursor: 'pointer',
};

const activeTagStyle: React.CSSProperties = {
  ...tagStyle,
  backgroundColor: 'var(--bui-color-bg-accent, #1e40af)',
  border: '1px solid var(--bui-color-border-accent, #3b82f6)',
  color: '#fff',
};

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

const StarFilledIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="#ffc107">
    <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
  </svg>
);

const StarOutlineIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.5 }}>
    <path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z" />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.6 }}>
    <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
  </svg>
);

const WarningIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
  </svg>
);

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{
      transition: 'transform 0.15s',
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      opacity: 0.6,
    }}
  >
    <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
  </svg>
);

const highlightStyle: React.CSSProperties = {
  backgroundColor: 'rgba(250, 204, 21, 0.4)',
  color: 'inherit',
  borderRadius: 2,
  padding: '0 1px',
};

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    regex.test(part) ? <mark key={i} style={highlightStyle}>{part}</mark> : part,
  );
}

const PlatformCard = ({
  platform,
  isFavorite,
  onToggleFavorite,
  onTagClick,
  selectedTags,
  searchQuery,
}: {
  platform: Platform;
  isFavorite: boolean;
  onToggleFavorite: (name: string, e: React.MouseEvent) => void;
  onTagClick: (tag: string) => void;
  selectedTags: string[];
  searchQuery: string;
}) => (
  <div className="platform-card-wrapper" style={{ position: 'relative', height: '100%' }}>
    <button
      onClick={e => onToggleFavorite(platform.name, e)}
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 1,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 4,
        borderRadius: 4,
        display: 'inline-flex',
        color: 'inherit',
      }}
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      {isFavorite ? <StarFilledIcon /> : <StarOutlineIcon />}
    </button>
    <a
      href={platform.url || '#'}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: 'none', color: 'inherit', display: 'block', height: '100%' }}
    >
      <Card style={{ height: '100%', cursor: 'pointer', overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 0 }}>
        {/* Logo area */}
        <div
          style={{
            height: 96,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            overflow: 'hidden',
          }}
        >
          <img
            src={platform.logo}
            alt={platform.name}
            style={{ maxHeight: 56, maxWidth: '80%', objectFit: 'contain' }}
            onError={e => {
              e.currentTarget.src = FALLBACK_LOGO;
            }}
          />
        </div>
        {/* Info area */}
        <div
          style={{
            backgroundColor: 'var(--bui-color-bg-default, #121212)',
            padding: '12px 16px',
            flex: 1,
          }}
        >
          <Flex justify="between" align="center" mb="1">
            <Text variant="body-medium" weight="bold">
              {highlightText(platform.name, searchQuery)}
            </Text>
            <ExternalLinkIcon />
          </Flex>
          <Text variant="body-small" color="secondary" style={{ lineHeight: 1.5 }}>
            {highlightText(platform.description, searchQuery)}
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
            {platform.tags.map(tag => (
              <span
                key={tag}
                style={selectedTags.includes(tag) ? activeTagStyle : { ...tagStyle, cursor: 'default' }}
              >
                {highlightText(tag, searchQuery)}
              </span>
            ))}
          </div>
          {platform.tags.includes('prd') && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginTop: 10,
                padding: '4px 8px',
                backgroundColor: 'rgba(255, 152, 0, 0.15)',
                borderRadius: 4,
                fontSize: 12,
                color: '#ff9800',
              }}
            >
              <WarningIcon />
              운영망 VPN 연결 필요
            </div>
          )}
        </div>
      </Card>
    </a>
  </div>
);

export const PlatformsPage = () => {
  const configApi = useApi(configApiRef);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tagDropdownRef.current &&
        !tagDropdownRef.current.contains(e.target as Node)
      ) {
        setTagDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  const saveFavorites = useCallback((newFavorites: string[]) => {
    setFavorites(newFavorites);
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(newFavorites));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const handleToggleFavorite = useCallback(
    (platformName: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      saveFavorites(
        favorites.includes(platformName)
          ? favorites.filter(f => f !== platformName)
          : [...favorites, platformName],
      );
    },
    [favorites, saveFavorites],
  );

  const platformsConfig =
    configApi.getOptionalConfigArray('app.platforms') ?? [];
  const allPlatforms: Platform[] = platformsConfig.map(item => ({
    name: item.getString('name'),
    category: item.getString('category'),
    description: item.getString('description'),
    url: item.getOptionalString('url') ?? '',
    logo: item.getString('logo'),
    tags: (item.getOptionalString('tags') ?? '')
      .split(',')
      .filter(t => t.trim()),
  }));

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    allPlatforms.forEach(platform => {
      platform.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [allPlatforms]);

  const handleTagToggle = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag],
    );
  };

  const handleClearFilters = () => {
    setSearchQuery('');
    setSelectedTags([]);
  };

  const toggleSection = (sectionName: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionName]:
        prev[sectionName] === undefined ? false : !prev[sectionName],
    }));
  };

  const isSectionExpanded = (sectionName: string) => {
    return expandedSections[sectionName] === undefined
      ? true
      : expandedSections[sectionName];
  };

  const filteredPlatforms = allPlatforms.filter(platform => {
    if (selectedTags.length > 0) {
      const hasAllTags = selectedTags.every(tag =>
        platform.tags.includes(tag),
      );
      if (!hasAllTags) return false;
    }
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

  const favoritePlatforms = filteredPlatforms.filter(p =>
    favorites.includes(p.name),
  );
  const nonFavoritePlatforms = filteredPlatforms.filter(
    p => !favorites.includes(p.name),
  );

  const categoryOrder = [
    'Developer Portal',
    'Observability',
    'CI/CD',
    'Security',
    'Infrastructure',
    'Data',
    'Registry',
    'Documentation',
  ];
  const categoryDescriptions: Record<string, string> = {
    'Developer Portal':
      '개발자 경험(Developer Experience) 향상을 위한 통합 포털 및 플랫폼',
    Observability:
      '시스템 상태를 모니터링하고 문제를 신속하게 파악하기 위한 도구',
    'CI/CD': '코드 변경사항을 자동으로 빌드, 테스트, 배포하기 위한 도구',
    Security: '보안 취약점 분석 및 접근 제어를 위한 도구',
    Infrastructure: '인프라 및 네트워크 자원을 관리하기 위한 도구',
    Data: '데이터 분석, 저장 및 거버넌스를 위한 도구',
    Registry: '컨테이너 이미지 및 아티팩트를 저장하기 위한 도구',
    Documentation: '문서화 및 프로젝트 관리를 위한 도구',
  };
  const groupedByCategory = nonFavoritePlatforms.reduce<
    Record<string, Platform[]>
  >((acc, platform) => {
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
    <>
      <PluginHeader title="Platforms" />
      <Container>
        <Flex direction="column" gap="3" p="3">
          <Text variant="body-medium" color="secondary">
            Internal tech stack and platform services for developers
          </Text>

          {/* Filters Section */}
          <Box
            mt="4"
            p="3"
            style={{
              backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
              borderRadius: 8,
            }}
          >
            <Text variant="body-medium" weight="bold" style={{ marginBottom: 12, display: 'block' }}>
              Filters
            </Text>
            <Flex
              gap="2"
              align="end"
              direction={{ initial: 'column', sm: 'row' }}
            >
              <Box style={{ minWidth: 300 }}>
                <SearchField
                  label="Search"
                  placeholder="Search platforms..."
                  size="small"
                  value={searchQuery}
                  onChange={setSearchQuery}
                />
              </Box>
              {/* Tags Multi-Select */}
              {allTags.length > 0 && (
                <Box style={{ minWidth: 160, position: 'relative' }} ref={tagDropdownRef}>
                  <div style={{ fontSize: 'var(--bui-font-size-2, 0.75rem)', fontWeight: 400, marginBottom: 'var(--bui-space-3, 12px)', color: 'var(--bui-fg-primary, #fff)' }}>
                    Tags ({allTags.length})
                  </div>
                  <button
                    type="button"
                    onClick={() => setTagDropdownOpen(prev => !prev)}
                    style={{
                      width: '100%',
                      height: '2rem',
                      padding: '0 var(--bui-space-3, 12px)',
                      fontSize: 'var(--bui-font-size-3, 0.875rem)',
                      fontWeight: 400,
                      fontFamily: 'var(--bui-font-regular, system-ui)',
                      background: 'var(--bui-bg-neutral-1, rgba(255,255,255,0.1))',
                      border: '1px solid var(--bui-border-2, #585858)',
                      borderRadius: 'var(--bui-radius-3, 8px)',
                      color: 'var(--bui-fg-primary, #fff)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 'var(--bui-space-2, 8px)',
                      boxSizing: 'border-box',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selectedTags.length === 0
                        ? 'All'
                        : `${selectedTags.length} selected`}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5, transition: 'transform 0.15s', transform: tagDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                      <path d="M7 10l5 5 5-5z" />
                    </svg>
                  </button>
                  {tagDropdownOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 100,
                        marginTop: 4,
                        minWidth: '100%',
                        maxHeight: 280,
                        overflowY: 'auto',
                        background: 'var(--bui-bg-popover, #1a1a1a)',
                        border: '1px solid var(--bui-border-1, #434343)',
                        borderRadius: 'var(--bui-radius-3, 8px)',
                        boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
                      }}
                    >
                      {selectedTags.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedTags([])}
                          style={{
                            width: '100%',
                            padding: '0 var(--bui-space-3, 12px)',
                            height: '2rem',
                            fontSize: 'var(--bui-font-size-3, 0.875rem)',
                            background: 'none',
                            border: 'none',
                            borderBottom: '1px solid var(--bui-border-2, #585858)',
                            color: 'var(--bui-fg-secondary, rgba(255,255,255,0.5))',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          Clear all
                        </button>
                      )}
                      {allTags.map(tag => (
                        <label
                          key={tag}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--bui-space-2, 8px)',
                            padding: '0 var(--bui-space-3, 12px)',
                            minHeight: '2rem',
                            fontSize: 'var(--bui-font-size-3, 0.875rem)',
                            cursor: 'pointer',
                            borderRadius: 'var(--bui-radius-2, 4px)',
                            backgroundColor: selectedTags.includes(tag) ? 'var(--bui-bg-neutral-2, rgba(255,255,255,0.06))' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedTags.includes(tag)}
                            onChange={() => handleTagToggle(tag)}
                            style={{ accentColor: '#3b82f6' }}
                          />
                          {tag}
                        </label>
                      ))}
                    </div>
                  )}
                </Box>
              )}
              {hasActiveFilters && (
                <Button
                  variant="secondary"
                  size="small"
                  onPress={handleClearFilters}
                >
                  Clear
                </Button>
              )}
            </Flex>
          </Box>

          {/* Platforms Section */}
          <Box
            p="3"
            style={{
              backgroundColor: 'var(--bui-color-bg-elevated, #1a1a1a)',
              borderRadius: 8,
            }}
          >
            <Flex justify="between" align="center" mb="3">
              <Text variant="body-medium" weight="bold">
                Platforms
              </Text>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 24,
                    height: 24,
                    padding: '0 8px',
                    borderRadius: 12,
                    fontSize: 14,
                    fontWeight: 700,
                    backgroundColor: hasActiveFilters
                      ? '#f59e0b'
                      : 'rgba(128,128,128,0.25)',
                    color: hasActiveFilters ? '#fff' : 'rgba(255,255,255,0.7)',
                  }}
                >
                  {hasActiveFilters
                    ? `${filteredCount} / ${totalPlatforms}`
                    : totalPlatforms}
                </span>
                <Text variant="body-small" color="secondary">
                  platforms
                </Text>
                <span
                  style={{
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
                  }}
                >
                  {categories.length}
                </span>
                <Text variant="body-small" color="secondary">
                  categories
                </Text>
              </span>
            </Flex>

            {/* Content */}
            {categories.length === 0 && favoritePlatforms.length === 0 ? (
              <Flex justify="center" p="4">
                <Text color="secondary">
                  No platforms found
                  {searchQuery && ` matching "${searchQuery}"`}
                  {selectedTags.length > 0 &&
                    ` with tags: ${selectedTags.join(', ')}`}
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="4">
                {/* Favorites Section */}
                {favoritePlatforms.length > 0 && (
                  <div
                    style={{
                      padding: 16,
                      backgroundColor: 'rgba(255, 193, 7, 0.08)',
                      borderRadius: 8,
                      border: '1px solid rgba(255, 193, 7, 0.2)',
                    }}
                  >
                    <Flex align="center" gap="2" mb="3">
                      <StarFilledIcon />
                      <Text variant="body-medium" weight="bold">
                        즐겨찾기 ({favoritePlatforms.length})
                      </Text>
                    </Flex>
                    <Grid.Root
                      columns={{ initial: '1', sm: '2', md: '3', lg: '4' }}
                      gap="3"
                    >
                      {favoritePlatforms.map(platform => (
                        <Grid.Item key={platform.name}>
                          <PlatformCard
                            platform={platform}
                            isFavorite
                            onToggleFavorite={handleToggleFavorite}
                            onTagClick={handleTagToggle}
                            selectedTags={selectedTags}
                            searchQuery={searchQuery}
                          />
                        </Grid.Item>
                      ))}
                    </Grid.Root>
                  </div>
                )}

                {/* Categories */}
                {categories.map(category => {
                  const expanded = isSectionExpanded(category.name);
                  return (
                    <div key={category.name}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleSection(category.name)}
                        onKeyDown={e =>
                          e.key === 'Enter' && toggleSection(category.name)
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          cursor: 'pointer',
                          padding: '12px 16px',
                          borderRadius: 8,
                          backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        <Flex align="center" gap="2">
                          <Text variant="body-medium" weight="bold">
                            {category.name}
                          </Text>
                          <Text variant="body-small" color="secondary">
                            ({category.platforms.length})
                          </Text>
                        </Flex>
                        <ChevronIcon
                          expanded={expanded}
                        />
                      </div>
                      {expanded && (
                        <Flex direction="column" gap="3" mt="3">
                          <Text
                            variant="body-small"
                            color="secondary"
                            style={{ paddingLeft: 16 }}
                          >
                            {categoryDescriptions[category.name]}
                          </Text>
                          <Grid.Root
                            columns={{
                              initial: '1',
                              sm: '2',
                              md: '3',
                              lg: '4',
                            }}
                            gap="3"
                          >
                            {category.platforms.map(platform => (
                              <Grid.Item key={platform.name}>
                                <PlatformCard
                                  platform={platform}
                                  isFavorite={favorites.includes(
                                    platform.name,
                                  )}
                                  onToggleFavorite={handleToggleFavorite}
                                  onTagClick={handleTagToggle}
                                  selectedTags={selectedTags}
                                  searchQuery={searchQuery}
                                />
                              </Grid.Item>
                            ))}
                          </Grid.Root>
                        </Flex>
                      )}
                    </div>
                  );
                })}
              </Flex>
            )}
          </Box>
        </Flex>
      </Container>
    </>
  );
};
