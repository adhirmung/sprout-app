import { useEffect, useState } from 'react';
import { Avatar } from './components/Avatar';
import { SproutWordmark } from './components/Brand';
import { Icon } from './components/Icon';
import { ToastHost } from './components/Toast';
import { AssessmentFlow } from './screens/AssessmentFlow';
import { LoginScreen, RegisterScreen } from './screens/AuthScreens';
import { DocumentScreen } from './screens/DocumentScreen';
import { HomeScreen, collectRecent } from './screens/HomeScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { Store } from './lib/store';
import { supabase, dbLoadProfile, dbLoadLibrary, dbSaveProfile, dbSaveLibrary } from './lib/supabase';
import { saveApiKey } from './lib/claude';
import type { FeedSource, LearnerProfile, LibraryTree, Route, User } from './lib/types';

export default function App() {
  return (
    <ToastHost>
      <AppCore />
    </ToastHost>
  );
}

function AppCore() {
  const [route, setRoute]           = useState<Route>(() => Store.get('route', 'login'));
  const [user, setUser]             = useState<User | null>(null);
  const [profile, setProfile]       = useState<LearnerProfile | null>(() => Store.get('profile', null));
  const [feedSource, setFeedSource] = useState<FeedSource | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => Store.set('route', route), [route]);
  useEffect(() => { if (profile) Store.set('profile', profile); }, [profile]);

  // ── Session bootstrap ──────────────────────────────────────
  useEffect(() => {
    let alive = true;

    const syncData = async (userId: string) => {
      try {
        const [{ cognitiveProfile, apiKey }, supabaseLib] = await Promise.all([
          dbLoadProfile(userId),
          dbLoadLibrary(userId),
        ]);
        if (!alive) return;

        if (cognitiveProfile) {
          setProfile(cognitiveProfile);
          Store.set('profile', cognitiveProfile);
        } else {
          const local: LearnerProfile | null = Store.get('profile', null);
          if (local) dbSaveProfile(userId, { cognitiveProfile: local }).catch(() => {});
        }

        if (apiKey) saveApiKey(apiKey);

        const localLib: LibraryTree = Store.get('library', {});
        if (Object.keys(supabaseLib).length > 0) {
          Store.set('library', supabaseLib);
        } else if (Object.keys(localLib).length > 0) {
          dbSaveLibrary(userId, localLib).catch(() => {});
        }
      } catch { /* non-fatal */ }
    };

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!alive) return;
      if (session) {
        const u: User = {
          id:    session.user.id,
          name:  (session.user.user_metadata?.display_name as string) || session.user.email!.split('@')[0],
          email: session.user.email!,
        };
        setUser(u);
        setRoute(r => (r === 'login' || r === 'register') ? 'home' : r);
        await syncData(session.user.id);
      }
      if (alive) setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setProfile(null);
        Store.del('profile');
        setRoute('login');
      }
      // SIGNED_IN fires on OAuth redirect — handle session restoration
      if (event === 'SIGNED_IN' && session) {
        const u: User = {
          id:    session.user.id,
          name:  (session.user.user_metadata?.display_name as string) || session.user.email!.split('@')[0],
          email: session.user.email!,
        };
        setUser(u);
      }
    });

    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  // ── Auth handlers ──────────────────────────────────────────
  const handleLogin = (u: User) => {
    setUser(u);
    const localProfile: LearnerProfile | null = Store.get('profile', null);
    setRoute(localProfile ? 'home' : 'assess');
    if (u.id) {
      Promise.all([dbLoadProfile(u.id), dbLoadLibrary(u.id)])
        .then(([{ cognitiveProfile, apiKey }, supabaseLib]) => {
          if (cognitiveProfile) {
            setProfile(cognitiveProfile);
            Store.set('profile', cognitiveProfile);
            setRoute(r => r === 'assess' ? 'home' : r);
          } else if (localProfile) {
            dbSaveProfile(u.id!, { cognitiveProfile: localProfile }).catch(() => {});
          }
          if (apiKey) saveApiKey(apiKey);
          const localLib: LibraryTree = Store.get('library', {});
          if (Object.keys(supabaseLib).length > 0) Store.set('library', supabaseLib);
          else if (Object.keys(localLib).length > 0) dbSaveLibrary(u.id!, localLib).catch(() => {});
        })
        .catch(() => {});
    }
  };

  const handleRegister = (u: User) => {
    setUser(u);
    setRoute('assess');
  };

  const handleGuest = () => {
    setUser({ name: 'Guest', email: 'guest@sprout.app', guest: true });
    const local: LearnerProfile | null = Store.get('profile', null);
    setRoute(local ? 'home' : 'assess');
  };

  const handleLogout = () => {
    if (user?.guest) {
      setUser(null);
      setProfile(null);
      setRoute('login');
    } else {
      supabase.auth.signOut(); // triggers onAuthStateChange(SIGNED_OUT) which cleans up
    }
  };

  const handleAssessmentComplete = (r: LearnerProfile) => {
    setProfile(r);
    setRoute('home');
    if (user?.id) dbSaveProfile(user.id, { cognitiveProfile: r }).catch(() => {});
  };

  const handleAssessmentSkip = () => setRoute('home');

  const startFeed = (src: FeedSource) => { setFeedSource(src); setRoute('document'); };

  const quickStudy = () => {
    const library: LibraryTree = Store.get('library', {});
    const recent = collectRecent(library);
    if (recent[0]) startFeed({ path: recent[0].path, item: recent[0].item });
    else setRoute('library');
  };

  // ── Loading splash ─────────────────────────────────────────
  if (authLoading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <SproutWordmark size={22} />
          <div style={{ marginTop: 20, color: 'var(--ink-3)', fontSize: 14 }}>Loading…</div>
        </div>
      </div>
    );
  }

  // ── Auth gate ──────────────────────────────────────────────
  if (!user) {
    if (route === 'register') return <RegisterScreen onRegister={handleRegister} onGoLogin={() => setRoute('login')} />;
    return <LoginScreen onLogin={handleLogin} onGoRegister={() => setRoute('register')} onGuest={handleGuest} />;
  }

  if (route === 'assess') {
    return <AssessmentFlow user={user} onComplete={handleAssessmentComplete} onSkip={handleAssessmentSkip} />;
  }

  if (route === 'document' || route === 'feed') {
    return (
      <AppShell user={user} route={route} setRoute={setRoute} onLogout={handleLogout} hideNav>
        <DocumentScreen source={feedSource} profile={profile} onBack={() => setRoute('home')} userId={user.id} />
      </AppShell>
    );
  }

  return (
    <AppShell user={user} route={route} setRoute={setRoute} onLogout={handleLogout}>
      {route === 'home' && (
        <HomeScreen user={user} profile={profile}
          library={Store.get('library', {})}
          onStartFromLibrary={startFeed}
          onGotoLibrary={() => setRoute('library')}
          onQuickStudy={quickStudy} />
      )}
      {route === 'library' && <LibraryScreen onOpenFile={startFeed} userId={user.id} />}
      {route === 'profile' && (
        <ProfileScreen user={user} profile={profile}
          onRetake={() => setRoute('assess')}
          onLogout={handleLogout} />
      )}
    </AppShell>
  );
}

// ── App Shell ─────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'home',    label: 'Home',    icon: 'home' },
  { id: 'library', label: 'Library', icon: 'folder' },
  { id: 'profile', label: 'Profile', icon: 'user' },
] as const;

interface AppShellProps {
  user: User;
  route: Route;
  setRoute: (r: Route) => void;
  onLogout: () => void;
  hideNav?: boolean;
  children: React.ReactNode;
}

function AppShell({ user, route, setRoute, onLogout, hideNav, children }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [route]);

  if (hideNav) {
    return <div style={{ height: '100dvh', background: 'var(--bg)' }}>{children}</div>;
  }

  return (
    <div className="shell" style={{ display: 'grid', gridTemplateColumns: '240px 1fr', height: '100dvh', background: 'var(--bg)' }}>
      {/* Sidebar */}
      <aside className="sidebar" style={{
        background: 'var(--card)', borderRight: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column', padding: '20px 14px',
      }}>
        <div style={{ padding: '0 6px 18px', borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
          <SproutWordmark size={18} />
        </div>
        <nav style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => setRoute(n.id as Route)}
              aria-current={route === n.id ? 'page' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 12,
                background: route === n.id ? 'var(--brand-tint)' : 'transparent',
                color: route === n.id ? 'var(--brand-2)' : 'var(--ink-2)',
                fontWeight: route === n.id ? 700 : 600, fontSize: 14,
                textAlign: 'left', transition: 'background 0.15s, color 0.15s',
              }}>
              <Icon name={n.icon} size={18} stroke="currentColor" />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar name={user?.name} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || 'You'}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email || ''}</div>
            </div>
            <button className="btn btn-ghost" onClick={onLogout} aria-label="Sign out" style={{ padding: 10, borderRadius: 8, minWidth: 44, minHeight: 44 }}>
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="mobile-bar" style={{ display: 'none' }}>
        <button className="btn btn-ghost" onClick={() => setMobileOpen(o => !o)} style={{ padding: 8 }}>
          <Icon name="menu" size={22} />
        </button>
        <SproutWordmark size={16} />
        <Avatar name={user?.name} size={32} />
      </div>

      {/* Main content */}
      <main style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div onClick={() => setMobileOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 'var(--z-dropdown)' as unknown as number }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 260, height: '100%', background: 'var(--card)', padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SproutWordmark size={18} />
            <div style={{ height: 12 }} />
            {NAV_ITEMS.map(n => (
              <button key={n.id} onClick={() => setRoute(n.id as Route)} className="btn btn-ghost" style={{
                justifyContent: 'flex-start', padding: '12px 14px',
                background: route === n.id ? 'var(--brand-tint)' : 'transparent',
                color: route === n.id ? 'var(--brand-2)' : 'var(--ink-2)',
              }}>
                <Icon name={n.icon} size={18} /> {n.label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={onLogout}><Icon name="logout" size={16} /> Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
