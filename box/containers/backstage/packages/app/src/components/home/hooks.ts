import { useCallback, useEffect, useRef, useState } from 'react';
import { discoveryApiRef, fetchApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import { searchApiRef } from '@backstage/plugin-search-react';
import { SearchResult } from '@backstage/plugin-search-common';

const getTimeBasedGreeting = (): string => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
};

export const useGreeting = () => {
  const identityApi = useApi(identityApiRef);
  const [displayName, setDisplayName] = useState<string>('');

  useEffect(() => {
    identityApi.getProfileInfo().then(profile => {
      setDisplayName(profile.displayName || 'Guest');
    });
  }, [identityApi]);

  return `${getTimeBasedGreeting()}, ${displayName}!`;
};

export const useSearchSuggestions = () => {
  const searchApi = useApi(searchApiRef);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController>();

  const search = useCallback(
    (value: string) => {
      setTerm(value);
      abortRef.current?.abort();

      if (!value.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      const timer = setTimeout(async () => {
        try {
          const { results: res } = await searchApi.query(
            { term: value.trim(), pageLimit: 5 },
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) {
            setResults(res);
            setLoading(false);
          }
        } catch {
          if (!controller.signal.aborted) {
            setResults([]);
            setLoading(false);
          }
        }
      }, 250);

      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    },
    [searchApi],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  return { term, search, results, loading };
};

export const useIamPendingCount = () => {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const fetchPending = async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('iam-user-audit');
        const response = await fetchApi.fetch(`${baseUrl}/password-reset/requests`);
        const data = await response.json();
        setCount(data.filter((r: any) => r.status === 'pending').length);
      } catch { /* ignore */ }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 60_000);
    return () => clearInterval(interval);
  }, [discoveryApi, fetchApi]);

  return count;
};
