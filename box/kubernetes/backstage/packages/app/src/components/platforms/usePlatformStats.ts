import { useCallback, useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

export interface PlatformStats {
  platform: string;
  dailyVisitors: number;
  weeklyVisitors: number;
  previousWeeklyVisitors: number;
  trendPercent: number | null;
  rank: number | null;
}

interface PlatformStatsResponse {
  stats: PlatformStats[];
  rankedCount: number;
  generatedAt: string;
}

export interface PlatformStatsState {
  /** Keyed by platform name. Empty until the first successful load. */
  byPlatform: Record<string, PlatformStats>;
  rankedCount: number;
  loading: boolean;
  /** Set when stats are unavailable, so the page can render without them. */
  error?: Error;
  recordVisit: (platform: string) => void;
}

/**
 * Loads visit stats from the platforms backend. Stats are decorative relative to
 * the catalog itself, so a failure here degrades to "no stats shown" rather than
 * blocking the platform list.
 */
export function usePlatformStats(): PlatformStatsState {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  const [byPlatform, setByPlatform] = useState<Record<string, PlatformStats>>({});
  const [rankedCount, setRankedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const baseUrl = await discoveryApi.getBaseUrl('platforms');
        const response = await fetchApi.fetch(`${baseUrl}/stats`);
        if (!response.ok) {
          throw new Error(`Failed to load platform stats: ${response.status}`);
        }
        const body: PlatformStatsResponse = await response.json();
        if (cancelled) return;
        setByPlatform(
          Object.fromEntries(body.stats.map(entry => [entry.platform, entry])),
        );
        setRankedCount(body.rankedCount);
        setError(undefined);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi]);

  const recordVisit = useCallback(
    (platform: string) => {
      // Fire and forget: the click opens a new tab, and a lost beat of telemetry
      // must never delay or block that navigation.
      (async () => {
        try {
          const baseUrl = await discoveryApi.getBaseUrl('platforms');
          await fetchApi.fetch(`${baseUrl}/visits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform }),
          });
        } catch {
          // Ignore telemetry failures
        }
      })();

      // Counts are distinct users, so this click can only ever move today's
      // number from zero to one, and only for the person doing the clicking.
      setByPlatform(prev => {
        const existing = prev[platform];
        if (!existing || existing.dailyVisitors > 0) return prev;
        return {
          ...prev,
          [platform]: { ...existing, dailyVisitors: 1 },
        };
      });
    },
    [discoveryApi, fetchApi],
  );

  return { byPlatform, rankedCount, loading, error, recordVisit };
}
