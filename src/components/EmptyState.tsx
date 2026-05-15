import { Icon } from './Icon';

interface EmptyStateProps {
  icon?: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon = 'sparkle', title, body, action }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 24px', color: 'var(--ink-2)' }}>
      <div style={{
        width: 72, height: 72, margin: '0 auto 18px', borderRadius: 20,
        background: 'var(--brand-tint)', color: 'var(--brand)',
        display: 'grid', placeItems: 'center',
      }}>
        <Icon name={icon} size={32} />
      </div>
      <h3 className="display" style={{ fontSize: 22, color: 'var(--ink)', marginBottom: 6 }}>{title}</h3>
      {body && <p style={{ fontSize: 14, maxWidth: 360, margin: '0 auto 18px' }}>{body}</p>}
      {action}
    </div>
  );
}
