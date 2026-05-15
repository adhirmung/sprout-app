export type ChipColor = 'default' | 'brand' | 'coral' | 'gold' | 'sky' | 'plum';

interface ChipProps {
  color?: ChipColor;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

const COLOR_CLASSES: Record<ChipColor, string> = {
  default: '',
  brand:   'brand',
  coral:   'coral',
  gold:    'gold',
  sky:     'sky',
  plum:    'plum',
};

export function Chip({ color = 'default', children, style }: ChipProps) {
  const cls = ['chip', COLOR_CLASSES[color]].filter(Boolean).join(' ');
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}
