import { CSSProperties, KeyboardEvent, useEffect, useRef, useState } from "react";

// Combobox is an editable autocomplete input: it accepts free text (so wildcard
// patterns like `*` or `maven-*` still work) while offering a filtered dropdown
// of known values. It reuses the .select-* dropdown styling so it matches the
// in-app Select component.
export function Combobox({ value, onChange, options, placeholder, style, hints }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  style?: CSSProperties;
  // hints maps an option to a muted secondary label (e.g. a repository type)
  // shown in the dropdown; the picked value is still the option string itself.
  hints?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Substring match, case-insensitive. An empty query lists every option.
  const q = value.trim().toLowerCase();
  const matches = options.filter((o) => o.toLowerCase().includes(q));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Keep the highlighted option in view while navigating with the keyboard.
  useEffect(() => {
    if (open && active >= 0)
      menuRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setActive((i) => Math.min(matches.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Enter":
        // Only intercept Enter to accept a highlighted suggestion; otherwise let
        // the keystroke through (free-typed patterns submit the form normally).
        if (open && active >= 0) {
          e.preventDefault();
          pick(matches[active]);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={`select${open ? " open" : ""}`} style={style}>
      <input value={value} placeholder={placeholder}
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown} />
      {open && matches.length > 0 && (
        <div ref={menuRef} className="select-menu" role="listbox">
          {matches.map((o, i) => (
            <div key={o} role="option" aria-selected={o === value}
              className={`select-option${i === active ? " active" : ""}${o === value ? " selected" : ""}`}
              onMouseEnter={() => setActive(i)}
              // mousedown (not click) so the option is picked before the input blurs.
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <span>{o}{hints?.[o] && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{hints[o]}</span>}</span>
              {o === value && <span className="select-check">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
