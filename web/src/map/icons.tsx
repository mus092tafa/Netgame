import type { MachineKind } from '../../../shared/protocol.ts';

/** Line-art machine icons in the blueprint style. */
export function MachineIcon({ kind }: { kind: MachineKind }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'laptop':
      return (
        <svg viewBox="0 0 32 32" width="30" height="30" {...common}>
          <rect x="6" y="7" width="20" height="13" rx="1.5" />
          <path d="M9 10.5h7M9 13.5h11M9 16.5h5" opacity=".6" />
          <path d="M3 24h26l-2 2.5H5z" />
        </svg>
      );
    case 'database':
      return (
        <svg viewBox="0 0 32 32" width="30" height="30" {...common}>
          <ellipse cx="16" cy="8" rx="10" ry="3.5" />
          <path d="M6 8v16c0 2 4.5 3.5 10 3.5s10-1.5 10-3.5V8" />
          <path d="M6 16c0 2 4.5 3.5 10 3.5s10-1.5 10-3.5" opacity=".6" />
        </svg>
      );
    case 'dns':
      return (
        <svg viewBox="0 0 32 32" width="30" height="30" {...common}>
          <circle cx="16" cy="16" r="11" />
          <path d="M5 16h22M16 5c3.5 3.5 3.5 18.5 0 22M16 5c-3.5 3.5-3.5 18.5 0 22" opacity=".7" />
        </svg>
      );
    case 'router':
      return (
        <svg viewBox="0 0 32 32" width="30" height="30" {...common}>
          <rect x="4" y="14" width="24" height="9" rx="2" />
          <path d="M9 14V8M23 14V8" />
          <circle cx="9" cy="18.5" r="1" fill="currentColor" />
          <circle cx="13" cy="18.5" r="1" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 32 32" width="30" height="30" {...common}>
          <rect x="7" y="4" width="18" height="24" rx="1.5" />
          <path d="M10 9h12M10 14h12M10 19h12" opacity=".6" />
          <circle cx="12" cy="24" r="1" fill="currentColor" />
          <circle cx="20" cy="24" r="1" fill="currentColor" />
        </svg>
      );
  }
}
