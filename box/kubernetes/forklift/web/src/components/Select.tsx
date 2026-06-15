import { CSSProperties, KeyboardEvent, useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  // Optional secondary text shown faintly under the label in the dropdown.
  description?: string;
}

// Select is the in-app replacement for the browser-native <select>: a trigger
// styled like our inputs plus a themed dropdown menu, with keyboard navigation
// (arrows/Enter/Escape), click-outside dismissal and ARIA listbox roles.
export function Select({ value, options, onChange, placeholder, style, size }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  size?: "sm";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

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

  const openMenu = () => {
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  };

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0) pick(options[active].value);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} style={style}
      className={`select${size === "sm" ? " sm" : ""}${open ? " open" : ""}`}>
      <button type="button" className="select-trigger" role="combobox"
        aria-expanded={open} aria-haspopup="listbox"
        onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKeyDown}>
        {selected
          ? <span className="select-value">{selected.label}</span>
          : <span className="select-value select-placeholder">{placeholder ?? ""}</span>}
        <svg className="select-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} className="select-menu" role="listbox">
          {options.map((o, i) => (
            <div key={o.value} role="option" aria-selected={o.value === value}
              className={`select-option${i === active ? " active" : ""}${o.value === value ? " selected" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}>
              <span className="select-option-text">
                <span>{o.label}</span>
                {o.description && <span className="select-desc">{o.description}</span>}
              </span>
              {o.value === value && <span className="select-check">✓</span>}
            </div>
          ))}
          {options.length === 0 && <div className="select-empty">No options</div>}
        </div>
      )}
    </div>
  );
}
