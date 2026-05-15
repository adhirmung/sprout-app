import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'coral';
export type ButtonSize    = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:  ButtonVariant;
  size?:     ButtonSize;
  block?:    boolean;
  loading?:  boolean;
  iconLeft?: string;
  iconRight?: string;
}

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '7px 14px',  fontSize: 12, minHeight: 36 },
  md: { padding: '12px 20px', fontSize: 14, minHeight: 44 },
  lg: { padding: '16px 28px', fontSize: 15, minHeight: 52 },
};

export function Button({
  variant  = 'primary',
  size     = 'md',
  block    = false,
  loading  = false,
  iconLeft,
  iconRight,
  children,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const cls = `btn btn-${variant}${block ? ' btn-block' : ''}`;
  return (
    <button
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{ ...SIZE_STYLES[size], ...style }}
      {...rest}
    >
      {loading && <LoadingDots />}
      {!loading && iconLeft  && <Icon name={iconLeft}  size={size === 'sm' ? 14 : 16} />}
      {!loading && children}
      {!loading && iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

function LoadingDots() {
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 5, height: 5, borderRadius: '50%', background: 'currentColor',
          animation: 'dot-pulse 1.4s ease infinite',
          animationDelay: `${i * 0.2}s`,
          opacity: 0.5,
        }} />
      ))}
    </span>
  );
}
