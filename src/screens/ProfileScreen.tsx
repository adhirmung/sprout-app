import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { levelLabel } from './AssessmentFlow';
import type { CognitiveDimension, LearnerProfile, User } from '../lib/types';

interface ProfileScreenProps {
  user: User;
  profile: LearnerProfile | null;
  onRetake: () => void;
  onLogout: () => void;
}

export function ProfileScreen({ user, profile, onRetake, onLogout }: ProfileScreenProps) {
  return (
    <div style={{ overflow: 'auto', height: '100%', padding: '32px clamp(20px, 4vw, 48px)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="label-eyebrow" style={{ marginBottom: 4 }}>Profile</div>
        <h1 className="display" style={{ fontSize: 32, marginBottom: 24 }}>Your Sprout account</h1>

        {/* User card */}
        <div className="card" style={{ padding: 24, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 18 }}>
          <Avatar name={user?.name} size={64} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{user?.name}</div>
            <div style={{ color: 'var(--ink-2)', fontSize: 14 }}>{user?.email}</div>
            {user?.guest && <span className="chip gold" style={{ marginTop: 8, display: 'inline-flex' }}>Guest account</span>}
          </div>
        </div>

        {/* Cognitive profile */}
        {profile ? (
          <>
            <div className="card" style={{ padding: 24, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <h2 className="display" style={{ fontSize: 20 }}>Cognitive profile</h2>
                <button className="btn btn-secondary" onClick={onRetake}><Icon name="rotate" size={14} /> Retake</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
                <DimCard label="Working Memory"     icon="🧠" color="brand" dim={profile.workingMemory}
                  detail={<SpanDetail wm={profile.workingMemory} />} />
                <DimCard label="Processing Speed"   icon="⚡" color="gold"  dim={profile.processingSpeed}
                  detail={<SpeedDetail sp={profile.processingSpeed} />} />
                <DimCard label="Fluid Reasoning"    icon="🧩" color="plum"  dim={profile.fluidIntelligence}
                  detail={<FluidDetail fi={profile.fluidIntelligence} />} />
                <DimCard label="Executive Function" icon="🔀" color="coral" dim={profile.executiveFunction}
                  detail={<EFDetail ef={profile.executiveFunction} />} />
                <DimCard label="Sustained Attention" icon="🎯" color="sky"  dim={profile.sustainedAttention}
                  detail={<AttentionDetail sa={profile.sustainedAttention} />} />
                <DimCard label="Confidence Cal."    icon="🎯" color="plum"  dim={profile.confidence}
                  detail={<ConfidenceDetail c={profile.confidence} />} />
              </div>
            </div>

            {/* Psychometric detail */}
            <div className="card" style={{ padding: 24, marginBottom: 16 }}>
              <h2 className="display" style={{ fontSize: 18, marginBottom: 14 }}>Psychometric breakdown</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
                {profile.workingMemory.verbalSpan !== undefined && (
                  <MetricRow label="Verbal span (digit)" value={`${profile.workingMemory.verbalSpan} items`} />
                )}
                {profile.workingMemory.visualSpan !== undefined && (
                  <MetricRow label="Visual span (Corsi)" value={`${profile.workingMemory.visualSpan} items`} />
                )}
                {profile.sustainedAttention.dPrime !== undefined && (
                  <MetricRow label="d′ (signal sensitivity)" value={profile.sustainedAttention.dPrime.toFixed(2)} />
                )}
                {profile.sustainedAttention.hitRate !== undefined && (
                  <MetricRow label="Hit rate" value={`${Math.round(profile.sustainedAttention.hitRate * 100)}%`} />
                )}
                {profile.sustainedAttention.faRate !== undefined && (
                  <MetricRow label="False-alarm rate" value={`${Math.round(profile.sustainedAttention.faRate * 100)}%`} />
                )}
                {profile.executiveFunction.switchCost !== undefined && (
                  <MetricRow label="Switch cost" value={`${Math.round(profile.executiveFunction.switchCost)} ms`} />
                )}
                {profile.executiveFunction.efAccuracy !== undefined && (
                  <MetricRow label="Task-switch accuracy" value={`${Math.round(profile.executiveFunction.efAccuracy * 100)}%`} />
                )}
                {profile.fluidIntelligence.accuracy !== undefined && (
                  <MetricRow label="Fluid reasoning accuracy" value={`${Math.round(profile.fluidIntelligence.accuracy * 100)}%`} />
                )}
                {profile.confidence.brierScore !== undefined && (
                  <MetricRow label="Brier score" value={profile.confidence.brierScore.toFixed(3)} />
                )}
                {profile.confidence.calibrationBias !== undefined && (
                  <MetricRow
                    label="Calibration bias"
                    value={profile.confidence.calibrationBias > 0.05
                      ? `+${profile.confidence.calibrationBias.toFixed(2)} (over-confident)`
                      : profile.confidence.calibrationBias < -0.05
                        ? `${profile.confidence.calibrationBias.toFixed(2)} (under-confident)`
                        : 'Well calibrated'}
                  />
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 14 }}>
                Assessment completed {new Date(profile.completedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            </div>
          </>
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🧠</div>
            <div className="display" style={{ fontSize: 20, marginBottom: 6 }}>Take the assessment</div>
            <p style={{ color: 'var(--ink-2)', marginBottom: 14 }}>Personalize how Sprout teaches you.</p>
            <button className="btn btn-primary" onClick={onRetake}>Start assessment</button>
          </div>
        )}

        {/* Account */}
        <div className="card" style={{ padding: 24, marginBottom: 16 }}>
          <h2 className="display" style={{ fontSize: 20, marginBottom: 14 }}>Account</h2>
          <ProfileRow label="Plan" value="Free · Sprout starter" />
          <ProfileRow label="Member since" value="May 2026" />
          <ProfileRow label="Languages" value="English" />
        </div>

        <button className="btn btn-secondary btn-block" onClick={onLogout}>
          <Icon name="logout" size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}

// ── Dimension card ────────────────────────────────────────────────

interface DimCardProps {
  label: string;
  icon: string;
  color: string;
  dim: CognitiveDimension;
  detail?: React.ReactNode;
}

function DimCard({ label, icon, color, dim, detail }: DimCardProps) {
  return (
    <div style={{ padding: 14, borderRadius: 12, background: 'var(--bg-tint)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      </div>
      <div className="display" style={{ fontSize: 20, color: `var(--${color})` }}>{levelLabel(dim.score)}</div>
      <div style={{ height: 4, background: 'var(--line)', borderRadius: 999, marginTop: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 999, background: `var(--${color})`, width: `${dim.score}%`, transition: 'width 0.6s' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>Score {dim.score}/100</div>
      {detail && <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 6 }}>{detail}</div>}
    </div>
  );
}

// ── Dim-specific detail lines ─────────────────────────────────────

function SpanDetail({ wm }: { wm: CognitiveDimension }) {
  if (wm.verbalSpan === undefined) return null;
  return <>{`Verbal ${wm.verbalSpan} · Visual ${wm.visualSpan ?? '–'}`}</>;
}

function SpeedDetail({ sp }: { sp: CognitiveDimension }) {
  if (sp.switchCost === undefined) return null;
  return <>{`Mean RT ≈ ${Math.round(sp.switchCost)} ms`}</>;
}

function FluidDetail({ fi }: { fi: CognitiveDimension }) {
  if (fi.accuracy === undefined) return null;
  return <>{`${Math.round(fi.accuracy * 100)}% correct`}</>;
}

function EFDetail({ ef }: { ef: CognitiveDimension }) {
  if (ef.switchCost === undefined) return null;
  return <>{`Switch cost ${Math.round(ef.switchCost)} ms`}</>;
}

function AttentionDetail({ sa }: { sa: CognitiveDimension }) {
  if (sa.dPrime === undefined) return null;
  return <>{`d′ = ${sa.dPrime.toFixed(2)}`}</>;
}

function ConfidenceDetail({ c }: { c: CognitiveDimension }) {
  if (c.brierScore === undefined) return null;
  const bias = c.calibrationBias ?? 0;
  return <>{`Brier ${c.brierScore.toFixed(3)} · ${bias > 0.05 ? 'Over-confident' : bias < -0.05 ? 'Under-confident' : 'Calibrated'}`}</>;
}

// ── Shared primitives ─────────────────────────────────────────────

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--ink-2)', fontSize: 14 }}>{label}</span>
      <span style={{ fontWeight: 600, fontSize: 14 }}>{value}</span>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  );
}
