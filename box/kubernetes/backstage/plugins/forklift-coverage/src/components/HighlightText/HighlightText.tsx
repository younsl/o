import React from 'react';
import './HighlightText.css';

/**
 * Marks the part of a cell that matched the search box, so a hit is visible
 * without re-reading the whole row.
 */
export const HighlightText = ({
  text,
  query,
}: {
  text: string;
  query: string;
}) => {
  const needle = query.trim();
  if (!needle) return <>{text}</>;

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={index} className="fc-hl">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};
