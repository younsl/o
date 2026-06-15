// In-app confirmation modal. The app never uses native dialogs (alert/confirm/
// prompt); all confirmations render through this component.
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {message && <p className="muted">{message}</p>}
        <div className="inline" style={{ justifyContent: "flex-end", marginTop: 18 }}>
          <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? "danger" : ""}`} type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
