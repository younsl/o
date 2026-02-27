import React from 'react';
import './HighlightText.css';

interface HighlightTextProps {
  text: string;
  query: string;
}

export const HighlightText = ({ text, query }: HighlightTextProps) => {
  if (!query) return <>{text}</>;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="hl-match">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
};
