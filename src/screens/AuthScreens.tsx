import { useMemo, useState } from 'react';
import { SproutWordmark, SproutCharacter } from '../components/Brand';
import { Icon } from '../components/Icon';
import { Field } from '../components/Field';
import { useToast } from '../components/Toast';
import { supabase } from '../lib/supabase';
import type { User } from '../lib/types';

// ── AuthShell ────────────────────────────────────────────────
function AuthShell({ children, mascotMessage }: { children: React.ReactNode; mascotMessage?: string }) {
  return (
    <div style={{
      minHeight: '100dvh',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.05fr)',
      background: 'var(--bg)',
    }} className="auth-shell">
      <div style={{
        display: 'flex', flexDirection: 'column',
        padding: '40px clamp(24px, 6vw, 80px)',
        justifyContent: 'space-between',
        minHeight: '100dvh',
        position: 'relative',
        zIndex: 2, background: 'var(--bg)',
      }}>
        <SproutWordmark size={20} />
        <div style={{ maxWidth: 420, width: '100%', margin: 'auto 0', paddingTop: 40, paddingBottom: 40 }}>
          {children}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          © 2026 Sprout · <a href="#">Terms</a> · <a href="#">Privacy</a>
        </div>
      </div>
      <AuthVisual message={mascotMessage} />
    </div>
  );
}

function AuthVisual({ message }: { message?: string }) {
  return (
    <div className="auth-visual" style={{
      position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(150deg, #DCEFE2 0%, #FFE4DA 60%, #FBEBC9 100%)',
      borderLeft: '1px solid var(--line)',
    }}>
      <div style={{ position: 'absolute', top: -120, right: -120, width: 380, height: 380, borderRadius: '50%', background: 'radial-gradient(circle, rgba(47,158,94,0.35) 0%, transparent 70%)' }} />
      <div style={{ position: 'absolute', bottom: -160, left: -100, width: 460, height: 460, borderRadius: '50%', background: 'radial-gradient(circle, rgba(140,91,217,0.25) 0%, transparent 70%)' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40 }}>
        <div style={{ position: 'relative', width: 420, height: 480 }}>
          <FloatingCard style={{ top: 0, left: 30, transform: 'rotate(-6deg)' }}
            kind="flashcard" title="What is photosynthesis?"
            body="The process by which plants convert sunlight into chemical energy."
            chip="Flashcard" chipColor="brand" />
          <FloatingCard style={{ top: 130, right: 0, transform: 'rotate(4deg)', animationDelay: '0.4s' }}
            kind="quiz" title="Which is NOT a product?"
            options={['Glucose', 'Oxygen', 'Carbon dioxide', 'Water']} correct={2}
            chip="Quiz" chipColor="coral" />
          <FloatingCard style={{ bottom: 20, left: 0, transform: 'rotate(-3deg)', animationDelay: '0.8s' }}
            kind="streak" chip="7-day streak" chipColor="gold" />
          <SproutCharacter style={{ position: 'absolute', bottom: -40, right: -20, width: 130 }} />
        </div>
      </div>
      {message && (
        <div style={{
          position: 'absolute', top: 32, right: 32,
          background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)',
          padding: '10px 16px', borderRadius: 999,
          fontSize: 13, fontWeight: 600, color: 'var(--ink-2)',
          border: '1px solid rgba(255,255,255,0.6)',
        }}>{message}</div>
      )}
    </div>
  );
}

interface FloatingCardProps {
  style?: React.CSSProperties;
  kind: 'flashcard' | 'quiz' | 'streak';
  title?: string;
  body?: string;
  chip: string;
  chipColor?: string;
  options?: string[];
  correct?: number;
}

function FloatingCard({ style, kind, title, body, chip, chipColor, options, correct }: FloatingCardProps) {
  return (
    <div className="card fade-up" style={{
      position: 'absolute', padding: 18, width: 280,
      animation: 'float 4s ease-in-out infinite',
      boxShadow: 'var(--shadow-3)',
      ...style,
    }}>
      <span className={`chip ${chipColor || 'brand'}`} style={{ marginBottom: 10, display: 'inline-flex' }}>{chip}</span>
      {kind === 'flashcard' && (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.45 }}>{body}</div>
        </>
      )}
      {kind === 'quiz' && options && (
        <>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {options.map((o, i) => (
              <div key={i} style={{
                padding: '7px 10px', fontSize: 12, fontWeight: 600,
                borderRadius: 8, border: '1px solid var(--line)',
                background: i === correct ? 'var(--brand-soft)' : 'var(--card-soft)',
                color: i === correct ? 'var(--brand-2)' : 'var(--ink-2)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ width: 16, height: 16, borderRadius: 999, background: i === correct ? 'var(--brand)' : 'transparent', border: i === correct ? 'none' : '1px solid var(--line-2)', display: 'grid', placeItems: 'center', color: 'white' }}>
                  {i === correct && <Icon name="check" size={10} />}
                </span>
                {o}
              </div>
            ))}
          </div>
        </>
      )}
      {kind === 'streak' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--gold-soft)', color: 'var(--gold)', display: 'grid', placeItems: 'center' }}>
            <Icon name="flame" size={24} stroke="#C68A18" />
          </div>
          <div>
            <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>Keep it growing</div>
            <div className="display" style={{ fontSize: 22 }}>7 day streak</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Social buttons ────────────────────────────────────────────
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.71v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.93v2.33A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.16.29-1.7V4.97H.93A9 9 0 0 0 0 9c0 1.45.35 2.83.93 4.03l3.02-2.33z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.96 8.96 0 0 0 9 0 9 9 0 0 0 .93 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z"/>
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#1F2937" d="M14.94 13.86c-.32.74-.7 1.43-1.16 2.06-.62.85-1.13 1.43-1.51 1.76-.59.51-1.23.78-1.91.79-.49 0-1.08-.14-1.78-.42-.7-.28-1.34-.42-1.94-.42-.62 0-1.28.14-1.99.42-.71.28-1.28.43-1.71.45-.65.03-1.3-.25-1.96-.81-.41-.36-.94-.95-1.59-1.78A8.6 8.6 0 0 1 0 12.05c-.36-.94-.55-1.85-.55-2.74 0-1.02.22-1.9.66-2.64.34-.6.8-1.07 1.37-1.42a3.7 3.7 0 0 1 1.85-.54c.52 0 1.21.16 2.06.48.85.32 1.4.48 1.64.48.18 0 .79-.19 1.83-.56C9.86 4.7 10.7 4.6 11.4 4.66c1.86.15 3.26.88 4.18 2.21-1.66 1-2.49 2.42-2.47 4.23.02 1.41.53 2.59 1.54 3.52.46.43.97.76 1.54.99-.13.36-.27.7-.42 1.05zM11.5.5c0 .77-.28 1.49-.84 2.15-.68.79-1.5 1.25-2.39 1.18-.01-.09-.02-.19-.02-.29 0-.74.32-1.53.89-2.18.28-.33.65-.6 1.08-.83.43-.22.84-.34 1.23-.36.01.11.01.22.05.33z"/>
    </svg>
  );
}

function SocialButton({ label, icon, onClick, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="btn btn-secondary" style={{ padding: '12px 8px', borderRadius: 12, gap: 6 }}
      onClick={onClick} disabled={disabled}>
      {icon}
      <span style={{ fontSize: 13 }}>{label}</span>
    </button>
  );
}

// ── PasswordStrength ──────────────────────────────────────────
function PasswordStrength({ score }: { score: number }) {
  const labels = ['Very weak', 'Weak', 'Okay', 'Strong', 'Excellent'];
  const colors = ['#E5604D', '#F4B740', '#F4B740', '#2F9E5E', '#2F9E5E'];
  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, display: 'flex', gap: 4 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i < score ? colors[score] : 'var(--line)',
            transition: 'background 0.2s',
          }} />
        ))}
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color: colors[score], minWidth: 70, textAlign: 'right' }}>
        {labels[score]}
      </span>
    </div>
  );
}

// ── LoginScreen ───────────────────────────────────────────────
interface LoginScreenProps {
  onLogin: (user: User) => void;
  onGoRegister: () => void;
  onGuest: () => void;
}

export function LoginScreen({ onLogin, onGoRegister, onGuest }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast('Enter your email and password', 'error'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const name = (data.user.user_metadata?.display_name as string) || email.split('@')[0];
      onLogin({ id: data.user.id, name, email: data.user.email! });
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Sign in failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) toast(error.message, 'error');
  };

  const handleApple = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: window.location.origin },
    });
    if (error) toast(error.message, 'error');
  };

  const handleMagic = async () => {
    if (!email) { toast('Enter your email first, then click Magic link', 'error'); return; }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    if (error) toast(error.message, 'error');
    else toast('Magic link sent — check your inbox!', 'success');
  };

  return (
    <AuthShell mascotMessage="🌱 Welcome back, friend">
      <h1 className="display" style={{ fontSize: 'clamp(34px, 5vw, 44px)', marginBottom: 10 }}>
        Welcome back.
      </h1>
      <p style={{ color: 'var(--ink-2)', marginBottom: 32, fontSize: 16 }}>
        Sign in to keep growing your knowledge.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 22 }}>
        <SocialButton label="Google" icon={<GoogleGlyph />} onClick={handleGoogle} />
        <SocialButton label="Apple"  icon={<AppleGlyph />}  onClick={handleApple} />
        <SocialButton label="Magic link" icon={<Icon name="sparkle" size={18} stroke="#8C5BD9" />} onClick={handleMagic} />
      </div>

      <div className="divider" style={{ marginBottom: 22 }}>or with email</div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Email">
          <input className="input" type="email" placeholder="you@example.com" value={email}
            onChange={e => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" right={<a href="#" style={{ fontSize: 13, fontWeight: 600 }}>Forgot?</a>}>
          <div style={{ position: 'relative' }}>
            <input className="input" type={showPw ? 'text' : 'password'} placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)} style={{ paddingRight: 48 }} />
            <button type="button" onClick={() => setShowPw(s => !s)}
              style={{ position: 'absolute', right: 6, top: 6, padding: 8, borderRadius: 8, color: 'var(--ink-3)' }}>
              <Icon name={showPw ? 'eye-off' : 'eye'} size={18} />
            </button>
          </div>
        </Field>

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading} style={{ marginTop: 8 }}>
          {loading ? 'Signing in…' : 'Sign in'} {!loading && <Icon name="arrow-right" size={18} />}
        </button>
      </form>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, fontSize: 14, color: 'var(--ink-2)' }}>
        <span>New to Sprout?{' '}
          <a href="#" onClick={e => { e.preventDefault(); onGoRegister(); }} style={{ fontWeight: 700 }}>Create an account</a>
        </span>
        <button className="btn btn-ghost" onClick={onGuest} style={{ fontSize: 13, padding: '6px 10px' }}>
          Continue as guest →
        </button>
      </div>
    </AuthShell>
  );
}

// ── RegisterScreen ────────────────────────────────────────────
interface RegisterScreenProps {
  onRegister: (user: User) => void;
  onGoLogin: () => void;
}

export function RegisterScreen({ onRegister, onGoLogin }: RegisterScreenProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(true);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const strength = useMemo(() => {
    let s = 0;
    if (password.length >= 8) s++;
    if (/[A-Z]/.test(password)) s++;
    if (/[0-9]/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    return s;
  }, [password]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email || !password) { toast('Fill all fields', 'error'); return; }
    if (!agree) { toast('Please agree to terms', 'error'); return; }
    if (strength < 2) { toast('Choose a stronger password', 'error'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: name.trim() } },
      });
      if (error) throw error;
      if (!data.session) {
        // Email confirmation required
        toast('Account created! Check your email to confirm, then sign in.', 'success');
        onGoLogin();
        return;
      }
      onRegister({ id: data.user!.id, name: name.trim(), email: data.user!.email! });
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Registration failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) toast(error.message, 'error');
  };

  const handleApple = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: window.location.origin },
    });
    if (error) toast(error.message, 'error');
  };

  return (
    <AuthShell mascotMessage="🌱 Plant the first seed">
      <h1 className="display" style={{ fontSize: 'clamp(34px, 5vw, 44px)', marginBottom: 10 }}>
        Start growing today.
      </h1>
      <p style={{ color: 'var(--ink-2)', marginBottom: 28, fontSize: 16 }}>
        Free to start. Cancel anytime. No credit card.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 22 }}>
        <SocialButton label="Google" icon={<GoogleGlyph />} onClick={handleGoogle} />
        <SocialButton label="Apple"  icon={<AppleGlyph />}  onClick={handleApple} />
        <SocialButton label="Magic link" icon={<Icon name="sparkle" size={18} stroke="#8C5BD9" />}
          onClick={() => toast('Enter your email on the sign-in screen to get a magic link', 'success')} />
      </div>

      <div className="divider" style={{ marginBottom: 22 }}>or with email</div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Your name">
          <input className="input" type="text" placeholder="Alex Rivera" value={name}
            onChange={e => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <input className="input" type="email" placeholder="you@example.com" value={email}
            onChange={e => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="input" type="password" placeholder="At least 8 characters" value={password}
            onChange={e => setPassword(e.target.value)} />
          {password && <PasswordStrength score={strength} />}
        </Field>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 6, cursor: 'pointer', fontSize: 13, color: 'var(--ink-2)' }}>
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 3, accentColor: 'var(--brand)' }} />
          <span>I agree to the <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.</span>
        </label>

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading} style={{ marginTop: 8 }}>
          {loading ? 'Creating account…' : 'Create account'} {!loading && <Icon name="arrow-right" size={18} />}
        </button>
      </form>

      <div style={{ marginTop: 22, fontSize: 14, color: 'var(--ink-2)', textAlign: 'center' }}>
        Already have an account?{' '}
        <a href="#" onClick={e => { e.preventDefault(); onGoLogin(); }} style={{ fontWeight: 700 }}>Sign in</a>
      </div>
    </AuthShell>
  );
}
