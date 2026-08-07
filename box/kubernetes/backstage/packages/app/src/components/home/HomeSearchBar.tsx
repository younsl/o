import React, { useRef, useState } from 'react';
import { Flex, SearchField, Text } from '@backstage/ui';
import { useNavigate } from 'react-router-dom';
import { useSearchSuggestions } from './hooks';
import { searchTypeLabels, searchTypeBadgeColors } from './homeConfig';

const suggestionDropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  marginTop: 4,
  backgroundColor: 'var(--bui-color-bg-elevated, #1e1e1e)',
  border: '1px solid var(--bui-color-border-default, #444)',
  borderRadius: 8,
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  zIndex: 100,
  overflow: 'hidden',
};

const suggestionItemStyle: React.CSSProperties = {
  padding: '8px 12px',
  cursor: 'pointer',
  borderBottom: '1px solid var(--bui-color-border-default, #333)',
  transition: 'background-color 0.1s',
};

export const HomeSearchBar = () => {
  const navigate = useNavigate();
  const { term, search, results, loading } = useSearchSuggestions();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchWrapperRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={searchWrapperRef}
      style={{ maxWidth: '60vw', width: '100%', position: 'relative' }}
      onBlur={e => {
        if (!searchWrapperRef.current?.contains(e.relatedTarget as Node)) {
          setShowSuggestions(false);
        }
      }}
    >
      <SearchField
        placeholder="Search components, APIs, docs..."
        size="medium"
        value={term}
        onChange={value => {
          search(value);
          setShowSuggestions(true);
        }}
        onSubmit={value => {
          setShowSuggestions(false);
          if (value.trim()) {
            navigate(`/search?query=${encodeURIComponent(value.trim())}`);
          }
        }}
        onFocus={() => { if (term.trim()) setShowSuggestions(true); }}
      />
      {showSuggestions && term.trim() && (
        <div style={suggestionDropdownStyle}>
          {loading ? (
            <div style={{ ...suggestionItemStyle, borderBottom: 'none' }}>
              <Text variant="body-small" color="secondary">Searching...</Text>
            </div>
          ) : results.length > 0 ? (
            <>
              {results.map((result, i) => {
                const doc = result.document;
                const typeLabel = searchTypeLabels[result.type] ?? result.type;
                const typeColor = searchTypeBadgeColors[result.type] ?? '#6b7280';
                return (
                  <a
                    key={`${doc.location}-${i}`}
                    href={doc.location}
                    style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                    className="search-suggestion-item"
                    onClick={e => {
                      e.preventDefault();
                      setShowSuggestions(false);
                      navigate(doc.location);
                    }}
                  >
                    <div style={{
                      ...suggestionItemStyle,
                      ...(i === results.length - 1 ? { borderBottom: 'none' } : {}),
                    }}>
                      <Flex align="center" gap="2">
                        <span style={{
                          display: 'inline-block',
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          backgroundColor: `${typeColor}22`,
                          color: typeColor,
                          border: `1px solid ${typeColor}44`,
                          whiteSpace: 'nowrap',
                        }}>
                          {typeLabel}
                        </span>
                        <Text variant="body-small" weight="bold" style={{ flex: 1 }}>{doc.title}</Text>
                      </Flex>
                      {doc.text && (
                        <Text variant="body-small" color="secondary" style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 1,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          marginTop: 2,
                        }}>
                          {doc.text}
                        </Text>
                      )}
                    </div>
                  </a>
                );
              })}
              <a
                href={`/search?query=${encodeURIComponent(term.trim())}`}
                style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                onClick={e => {
                  e.preventDefault();
                  setShowSuggestions(false);
                  navigate(`/search?query=${encodeURIComponent(term.trim())}`);
                }}
              >
                <div style={{ ...suggestionItemStyle, borderBottom: 'none', textAlign: 'center' }}>
                  <Text variant="body-small" color="secondary">View all results</Text>
                </div>
              </a>
            </>
          ) : (
            <div style={{ ...suggestionItemStyle, borderBottom: 'none' }}>
              <Text variant="body-small" color="secondary">No results found</Text>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
