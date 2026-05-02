import React from 'react';
import './Stars.css';

export function clicksToStars(count: number): number {
  if (count <= 0) return 0;
  if (count < 3) return 1;
  if (count < 10) return 2;
  if (count < 30) return 3;
  if (count < 100) return 4;
  return 5;
}

export const Stars = ({ count }: { count: number }) => {
  const filled = clicksToStars(count);
  return (
    <span
      className="gdm-stars"
      aria-label={`${filled} of 5 stars (${count} opens)`}
    >
      <span className="gdm-stars-filled">{'★'.repeat(filled)}</span>
      <span className="gdm-stars-empty">{'☆'.repeat(5 - filled)}</span>
    </span>
  );
};
