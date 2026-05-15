interface AvatarProps {
  name?: string;
  size?: number;
  color?: string;
}

export function Avatar({ name = '?', size = 36, color }: AvatarProps) {
  const initials = name.split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const palette = ['var(--brand)', 'var(--coral)', 'var(--gold)', 'var(--sky)', 'var(--plum)'];
  const c = color || palette[(name.charCodeAt(0) || 0) % palette.length];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: c, color: 'white',
      display: 'grid', placeItems: 'center',
      fontWeight: 700, fontSize: size * 0.42,
      flexShrink: 0,
    }}>{initials}</div>
  );
}
