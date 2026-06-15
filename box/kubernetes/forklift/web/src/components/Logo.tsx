import logoUrl from "../assets/forklift-logo.svg";

// Logo renders the official forklift artwork. The source of truth is
// docs/assets/forklift-logo.svg; it is copied into web/src/assets because the
// Docker web stage only ships the web/ directory. The artwork is black ink on
// transparent, so it sits on a light rounded chip to stay readable on the
// dark sidebar.
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo-chip" style={{ width: size, height: size }}>
      <img src={logoUrl} alt="" width={Math.round(size * 0.8)} height={Math.round(size * 0.8)} />
    </span>
  );
}
