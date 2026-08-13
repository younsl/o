/**
 * Shared by the coverage table and the project detail page, so one instant
 * never reads as two different ages depending on which page is open.
 */
export const formatRelative = (iso: string | null): string => {
  if (!iso) return 'never';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  // Past a month the day count stops being a fact anybody reads and turns into
  // a number to divide, so the months are counted here instead. 30-day months
  // keep the label monotonic, which a calendar month would not.
  return `${Math.floor(days / 30)}mo ago`;
};
