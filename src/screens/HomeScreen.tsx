import { useMemo } from 'react';
import { SproutCharacter } from '../components/Brand';
import { Icon } from '../components/Icon';
import { levelLabel } from './AssessmentFlow';
import type { FeedSource, LearnerProfile, LibraryFile, LibraryTree, User } from '../lib/types';

interface HomeScreenProps {
  user: User;
  profile: LearnerProfile | null;
  library: LibraryTree;
  onStartFromLibrary: (src: FeedSource) => void;
  onGotoLibrary: () => void;
  onQuickStudy: () => void;
}

interface RecentItem {
  path: string[];
  item: LibraryFile;
}

function collectRecent(library: LibraryTree, path: string[] = []): RecentItem[] {
  const out: RecentItem[] = [];
  for (const k in library) {
    const it = library[k];
    if (it.type === 'file') out.push({ path: [...path, k], item: it });
    else if (it.type === 'folder') out.push(...collectRecent(it.children, [...path, k]));
  }
  return out.sort((a, b) => (b.item.created || 0) - (a.item.created || 0));
}

export function HomeScreen({ user, profile, library, onStartFromLibrary, onGotoLibrary, onQuickStudy }: HomeScreenProps) {
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const recent = useMemo(() => collectRecent(library).slice(0, 4), [library]);

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: '32px clamp(20px, 4vw, 48px)' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* Hero */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 20, marginBottom: 28 }} className="home-hero">
          <div className="card" style={{
            padding: '32px clamp(24px, 4vw, 40px)',
            background: 'linear-gradient(135deg, var(--brand-tint) 0%, var(--gold-soft) 100%)',
            border: '1px solid var(--brand-soft)',
            position: 'relative', overflow: 'hidden', minHeight: 200,
          }}>
            <div className="label-eyebrow" style={{ marginBottom: 6 }}>{greeting}</div>
            <h1 className="display" style={{ fontSize: 'clamp(28px, 4vw, 40px)', marginBottom: 8 }}>
              Hi {user?.name?.split(' ')[0] || 'friend'} 🌱
            </h1>
            <p style={{ fontSize: 16, color: 'var(--ink-2)', marginBottom: 22, maxWidth: 420 }}>
              Pick up where you left off, or start something new. Your sprout is ready to grow.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-lg" onClick={onQuickStudy}>
                <Icon name="sparkle" size={18} /> Quick study
              </button>
              <button className="btn btn-secondary btn-lg" onClick={onGotoLibrary}>
                <Icon name="folder" size={18} /> My library
              </button>
            </div>
            <SproutCharacter style={{ position: 'absolute', right: -10, bottom: -20, width: 160, opacity: 0.85 }} />
          </div>

          <div className="card" style={{ padding: 22 }}>
            <div className="label-eyebrow" style={{ marginBottom: 14 }}>Today</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <MiniStat icon="flame" color="coral" value="7" label="Day streak" />
              <MiniStat icon="trophy" color="gold" value="1,240" label="Points" />
              <MiniStat icon="sparkle" color="brand" value="12" label="Cards reviewed" />
              <MiniStat icon="clock" color="sky" value="18m" label="Studied" />
            </div>
            <div style={{ paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, color: 'var(--ink-2)', fontWeight: 600 }}>
                <span>Daily goal</span><span>14 / 20 cards</span>
              </div>
              <div style={{ height: 8, background: 'var(--line)', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'linear-gradient(90deg, var(--brand), var(--gold))', width: '70%', borderRadius: 999, transition: 'width 0.6s' }} />
              </div>
            </div>
          </div>
        </div>

        {/* Continue learning */}
        {recent.length > 0 && (
          <Section title="Continue learning" right={
            <button className="btn btn-ghost" onClick={onGotoLibrary} style={{ fontSize: 13 }}>
              See all <Icon name="arrow-right" size={14}/>
            </button>
          }>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {recent.map((r, i) => (
                <button key={i} className="card" style={{ padding: 18, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12, transition: 'transform 0.15s, box-shadow 0.18s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-2)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-1)'; }}
                  onClick={() => onStartFromLibrary({ path: r.path, item: r.item })}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center' }}>
                      <Icon name="file" size={18} />
                    </div>
                    <span className="chip">{r.item.fileType}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 3, fontWeight: 600 }}>
                      {r.path.slice(0, -1).join(' / ') || 'Library'}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.35, marginBottom: 8 }}>
                      {r.path[r.path.length - 1]}
                    </div>
                    <div style={{ height: 4, background: 'var(--line)', borderRadius: 999 }}>
                      <div style={{ height: '100%', borderRadius: 999, width: `${30 + i * 17}%`, background: 'var(--brand)' }} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </Section>
        )}

        {/* Profile snapshot */}
        {profile && (
          <Section title="Your learning profile" right={<span className="chip brand">Personalized</span>}>
            <div className="card" style={{ padding: 24 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
                {([
                  { k: 'workingMemory',     l: 'Memory',    icon: '🧠', color: 'brand' },
                  { k: 'processingSpeed',   l: 'Speed',     icon: '⚡', color: 'gold' },
                  { k: 'fluidIntelligence', l: 'Reasoning', icon: '🧩', color: 'plum' },
                  { k: 'executiveFunction', l: 'Switching', icon: '🔀', color: 'coral' },
                  { k: 'sustainedAttention',l: 'Focus',     icon: '🎯', color: 'sky' },
                ] as const).map(d => {
                  const r = profile[d.k as keyof LearnerProfile] as { score: number };
                  return (
                    <div key={d.k}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 18 }}>{d.icon}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{d.l}</span>
                      </div>
                      <div className="display" style={{ fontSize: 22, color: `var(--${d.color})` }}>{levelLabel(r.score)}</div>
                      <div style={{ height: 4, background: 'var(--line)', borderRadius: 999, marginTop: 4 }}>
                        <div style={{ height: '100%', borderRadius: 999, background: `var(--${d.color})`, width: `${r.score}%`, transition: 'width 0.6s' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Section>
        )}

        {/* Suggestions */}
        <Section title="Suggested next">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            <SuggestionCard icon="📚" color="brand" title="Build a study set" body="Upload notes, a PDF, or a recording — Sprout turns it into cards in seconds." cta="Open library" onClick={onGotoLibrary} />
            <SuggestionCard icon="🃏" color="sky" title="Try a quick session" body="Spend 5 minutes with 5 mixed cards from your library." cta="Quick study" onClick={onQuickStudy} />
            <SuggestionCard icon="🌱" color="gold" title="Grow a new garden" body="Create a new folder for your next subject or course." cta="New folder" onClick={onGotoLibrary} />
          </div>
        </Section>

        <div style={{ height: 32 }} />
      </div>
    </div>
  );
}

function MiniStat({ icon, color, value, label }: { icon: string; color: string; value: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, background: 'var(--bg-tint)' }}>
      <div style={{ width: 32, height: 32, borderRadius: 10, background: `var(--${color}-soft)`, color: `var(--${color})`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="display" style={{ fontSize: 18, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600 }}>{label}</div>
      </div>
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 className="display" style={{ fontSize: 20 }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function SuggestionCard({ icon, color, title, body, cta, onClick }: {
  icon: string; color: string; title: string; body: string; cta: string; onClick: () => void;
}) {
  const ctaColor = color === 'gold' ? 'var(--ink)' : color === 'sky' ? 'var(--sky)' : 'var(--brand-2)';
  return (
    <button className="card" onClick={onClick} style={{ padding: 22, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, transition: 'transform 0.15s, box-shadow 0.18s' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-2)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-1)'; }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: `var(--${color}-soft)`, display: 'grid', placeItems: 'center', fontSize: 22 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
      <div style={{ color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.5 }}>{body}</div>
      <span style={{ marginTop: 'auto', fontSize: 13, fontWeight: 700, color: ctaColor, display: 'flex', alignItems: 'center', gap: 4 }}>
        {cta} <Icon name="arrow-right" size={14} />
      </span>
    </button>
  );
}

export { collectRecent };
