interface ProgressBarProps {
  value: number;       // 0–max
  max?: number;        // default 1 (so value can be a 0–1 fraction)
  height?: number;     // px, default 4
  gradient?: boolean;  // true → brand→sky gradient; false → solid brand
  label?: string;      // accessible label; defaults to "{pct}% complete"
  style?: React.CSSProperties;
}

export function ProgressBar({ value, max = 1, height = 4, gradient = false, label, style }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const fill = gradient
    ? 'linear-gradient(90deg, var(--brand), var(--sky))'
    : 'var(--brand)';

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `${Math.round(pct)}% complete`}
      style={{ height, background: 'var(--line)', borderRadius: 999, overflow: 'hidden', ...style }}
    >
      <div style={{
        height: '100%', borderRadius: 999,
        background: fill,
        width: `${pct}%`,
        transition: 'width 0.35s ease',
      }} />
    </div>
  );
}
