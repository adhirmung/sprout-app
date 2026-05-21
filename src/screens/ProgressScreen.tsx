interface ProgressScreenProps {
  userId?: string;
}

export function ProgressScreen({ userId: _userId }: ProgressScreenProps) {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      color: 'var(--ink-4)',
    }}>
      <span style={{ fontSize: 48 }}>📊</span>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-3)' }}>Dashboard</div>
      <div style={{ fontSize: 13 }}>Coming soon</div>
    </div>
  );
}
