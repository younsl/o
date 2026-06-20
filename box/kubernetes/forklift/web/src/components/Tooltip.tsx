import { ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Tooltip shows a styled help bubble on hover/focus. It renders the bubble in a
// body portal positioned from the trigger's rect, so it is not clipped by
// overflow containers (e.g. a scrollable table) the way an in-flow absolutely
// positioned tooltip would be. Custom-built rather than pulling in a tooltip
// library, matching the app's hand-rolled components and keeping the bundle lean.
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.top });
  };
  const hide = () => setPos(null);

  return (
    <span
      ref={ref}
      className="tooltip-trigger"
      tabIndex={0}
      role="img"
      aria-label="help"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos && createPortal(
        <span className="tooltip-bubble" role="tooltip"
          style={{ left: pos.x, top: pos.y - 8, transform: "translate(-50%, -100%)" }}>
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
