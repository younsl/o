import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Flex, Text } from '@backstage/ui';
import { GitlabToken } from '../../api/types';
import './TokenCalendarView.css';

interface Props {
  tokens: GitlabToken[];
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtMonth = (d: Date) =>
  d.toLocaleString(undefined, { year: 'numeric', month: 'long' });

const todayKey = (() => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(
    t.getDate(),
  ).padStart(2, '0')}`;
})();

interface TokenRowRef extends GitlabToken {
  rowKey: string;
}

const urgencyClass = (expiresAt: string): string => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiresAt);
  exp.setHours(0, 0, 0, 0);
  const days = Math.round((exp.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return 'gta-cal-token gta-cal-token-expired';
  if (days <= 7) return 'gta-cal-token gta-cal-token-danger';
  if (days <= 30) return 'gta-cal-token gta-cal-token-warning';
  return 'gta-cal-token gta-cal-token-ok';
};

export const TokenCalendarView = ({ tokens }: Props) => {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const byDate = useMemo(() => {
    const map = new Map<string, TokenRowRef[]>();
    for (const t of tokens) {
      if (!t.expiresAt) continue;
      const key = t.expiresAt.slice(0, 10);
      const list = map.get(key) ?? [];
      list.push({
        ...t,
        rowKey: `${t.kind}:${t.ownerScope ?? 'pat'}:${t.id}`,
      });
      map.set(key, list);
    }
    return map;
  }, [tokens]);

  const cells = useMemo(() => {
    const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startDow = firstDay.getDay();
    const daysInMonth = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      0,
    ).getDate();
    const out: Array<{ day: number; key: string; dow: number; tokens: TokenRowRef[] } | null> = [];
    for (let i = 0; i < startDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(
        2,
        '0',
      )}-${String(d).padStart(2, '0')}`;
      const dow = new Date(cursor.getFullYear(), cursor.getMonth(), d).getDay();
      out.push({ day: d, key, dow, tokens: byDate.get(key) ?? [] });
    }
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor, byDate]);

  const monthTotal = useMemo(
    () => cells.reduce((sum, c) => sum + (c?.tokens.length ?? 0), 0),
    [cells],
  );

  const noExpiryCount = useMemo(
    () => tokens.filter(t => !t.expiresAt).length,
    [tokens],
  );

  return (
    <Box>
      <Flex justify="between" align="center" mb="3" style={{ flexWrap: 'wrap' }} gap="2">
        <Flex gap="2" align="center">
          <Button
            variant="tertiary"
            size="small"
            onPress={() =>
              setCursor(
                new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1),
              )
            }
            aria-label="Previous month"
          >
            ‹
          </Button>
          <Text variant="body-medium" weight="bold">
            {fmtMonth(cursor)}
          </Text>
          <Button
            variant="tertiary"
            size="small"
            onPress={() =>
              setCursor(
                new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1),
              )
            }
            aria-label="Next month"
          >
            ›
          </Button>
          <Button
            variant="secondary"
            size="small"
            onPress={() => {
              const t = new Date();
              setCursor(new Date(t.getFullYear(), t.getMonth(), 1));
            }}
          >
            Today
          </Button>
        </Flex>
        <Text variant="body-x-small" color="secondary">
          {monthTotal} expiring this month
          {noExpiryCount > 0 && ` · ${noExpiryCount} with no expiry`}
        </Text>
      </Flex>

      <Box className="gta-cal-grid">
        {DOW.map((dow, i) => (
          <Box
            key={dow}
            className={`gta-cal-dow${
              i === 0
                ? ' gta-cal-dow-sun'
                : i === 6
                ? ' gta-cal-dow-sat'
                : ''
            }`}
          >
            <Text variant="body-x-small" weight="bold">
              {dow}
            </Text>
          </Box>
        ))}
        {cells.map((cell, i) => {
          if (!cell) {
            return <Box key={i} className="gta-cal-cell gta-cal-cell-empty">{null}</Box>;
          }
          const isToday = cell.key === todayKey;
          const dowClass =
            cell.dow === 0
              ? ' gta-cal-cell-sun'
              : cell.dow === 6
              ? ' gta-cal-cell-sat'
              : '';
          return (
            <Box
              key={i}
              className={`gta-cal-cell${isToday ? ' gta-cal-cell-today' : ''}${dowClass}`}
            >
              <Flex justify="between" align="center">
                <Text
                  variant="body-x-small"
                  weight={isToday ? 'bold' : 'regular'}
                  className="gta-cal-day-number"
                >
                  {cell.day}
                </Text>
                {cell.tokens.length > 0 && (
                  <Text variant="body-x-small" color="secondary">
                    {cell.tokens.length} token{cell.tokens.length === 1 ? '' : 's'}
                  </Text>
                )}
              </Flex>
              <Box mt="1">
                {cell.tokens.slice(0, 4).map(t => (
                  <button
                    key={t.id}
                    type="button"
                    className={urgencyClass(t.expiresAt!)}
                    onClick={() =>
                      navigate(`tokens/${encodeURIComponent(t.rowKey)}`)
                    }
                    title={`${t.name} — ${t.kind}`}
                  >
                    {t.name}
                  </button>
                ))}
                {cell.tokens.length > 4 && (
                  <Text variant="body-x-small" color="secondary">
                    +{cell.tokens.length - 4} more
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
