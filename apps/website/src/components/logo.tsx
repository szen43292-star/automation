export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#ff6d3a" />
      <path d="M18 20h20M18 32h14M18 44h8" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
      <circle cx="46" cy="40" r="7" fill="#fff" />
    </svg>
  );
}
