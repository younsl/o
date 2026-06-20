// Toggle is a switch-style boolean control: a pill track with a sliding knob.
// The optional label sits to the right; the whole row is clickable.
export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`switch${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
      {label && <span className="switch-text">{label}</span>}
    </div>
  );
}
