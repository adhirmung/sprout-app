interface SproutMarkProps {
  size?: number;
  variant?: 'solid' | 'outline';
  label?: string; // provide when the mark is the only visual identifier; omit when decorative
}

export function SproutMark({ size = 40, variant = 'solid', label }: SproutMarkProps) {
  const r = size * 0.23;
  const svgProps = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true as const, focusable: 'false' as const };

  if (variant === 'outline') {
    return (
      <svg width={size} height={size} viewBox="0 0 96 96" fill="none" {...svgProps}>
        <rect x="2" y="2" width="92" height="92" rx="22" stroke="var(--brand)" strokeWidth="3" fill="var(--brand-tint)"/>
        <path d="M48 70 C 48 56, 38 48, 28 48 C 28 60, 36 70, 48 70 Z" fill="var(--brand)" opacity="0.45"/>
        <path d="M48 70 C 48 50, 60 38, 72 38 C 72 56, 62 70, 48 70 Z" fill="var(--brand)"/>
        <rect x="46" y="68" width="4" height="14" rx="2" fill="var(--brand-2)"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" {...svgProps}>
      <rect x="4" y="4" width="88" height="88" rx={r} fill="var(--brand)"/>
      <path d="M48 70 C 48 56, 38 48, 28 48 C 28 60, 36 70, 48 70 Z" fill="var(--brand-soft)"/>
      <path d="M48 70 C 48 50, 60 38, 72 38 C 72 56, 62 70, 48 70 Z" fill="white"/>
      <rect x="46" y="68" width="4" height="14" rx="2" fill="var(--brand-2)"/>
    </svg>
  );
}

export function SproutWordmark({ size = 22 }: { size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <SproutMark size={size * 1.45} />
      <span className="display" style={{ fontSize: size, letterSpacing: '-0.025em', fontWeight: 700 }}>
        sprout
      </span>
    </div>
  );
}

export function SproutCharacter({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 200 200" style={{ ...style, animation: 'float 3.2s ease-in-out infinite' }}>
      <path d="M55 130 L145 130 L138 175 a8 8 0 0 1-8 7 H70 a8 8 0 0 1-8-7 z" fill="#FF7A5C"/>
      <rect x="50" y="123" width="100" height="14" rx="4" fill="#E5664A"/>
      <rect x="96" y="78" width="8" height="55" rx="4" fill="#1F6E45"/>
      <path d="M100 100 C 80 100, 64 84, 64 64 C 84 64, 100 80, 100 100 Z" fill="#2F9E5E"/>
      <path d="M100 100 C 120 100, 136 84, 136 64 C 116 64, 100 80, 100 100 Z" fill="#3FBA72"/>
      <circle cx="92" cy="78" r="2.4" fill="#1F2937"/>
      <circle cx="108" cy="78" r="2.4" fill="#1F2937"/>
      <path d="M94 86 q6 5 12 0" stroke="#1F2937" strokeWidth="2" fill="none" strokeLinecap="round"/>
      <circle cx="86" cy="84" r="2" fill="#FFB6A8"/>
      <circle cx="114" cy="84" r="2" fill="#FFB6A8"/>
    </svg>
  );
}
