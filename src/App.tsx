import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Dropdown } from './components/Dropdown';
import { TourGuide, resetTour } from './components/TourGuide';
import { LoginPage } from './components/LoginPage';

interface ClawUser {
  username: string;
  displayName: string;
  role: string;
  avatar: string | null;
  demo?: boolean;
}

function readUser(): ClawUser | null {
  try {
    const raw = localStorage.getItem('clawboard-user');
    return raw ? (JSON.parse(raw) as ClawUser) : null;
  } catch {
    return null;
  }
}

// Route-level code splitting — loaded on demand
const Dashboard              = lazy(() => import('./components/Dashboard').then(m => ({ default: m.Dashboard })));
const TaskCreator            = lazy(() => import('./components/TaskCreator').then(m => ({ default: m.TaskCreator })));
const TachesPage             = lazy(() => import('./components/TachesPage').then(m => ({ default: m.TachesPage })));
const SecurityModule         = lazy(() => import('./components/SecurityModule').then(m => ({ default: m.SecurityModule })));
const CollaborationModule    = lazy(() => import('./components/CollaborationModule').then(m => ({ default: m.CollaborationModule })));
const AgentsHierarchyModule  = lazy(() => import('./components/AgentsHierarchyModule').then(m => ({ default: m.AgentsHierarchyModule })));
const MemoryModule           = lazy(() => import('./components/MemoryModule').then(m => ({ default: m.MemoryModule })));
const SkillsModule           = lazy(() => import('./components/SkillsModule').then(m => ({ default: m.SkillsModule })));
const SettingsModule         = lazy(() => import('./components/SettingsModule').then(m => ({ default: m.SettingsModule })));
const SchedulerModule        = lazy(() => import('./components/SchedulerModule').then(m => ({ default: m.SchedulerModule })));
const ChatModule             = lazy(() => import('./components/ChatModule').then(m => ({ default: m.ChatModule })));
const TerminalModule         = lazy(() => import('./components/TerminalModule').then(m => ({ default: m.TerminalModule })));
const GitLogModule           = lazy(() => import('./components/GitLogModule').then(m => ({ default: m.GitLogModule })));
import { useSSE } from './hooks/useSSE';
import {
  TerminalSquare,
  LayoutDashboard,
  ShieldCheck,
  Globe,
  Network,
  BrainCircuit,
  ToyBrick,
  Settings,
  User,
  LogOut,
  Palette,
  CalendarClock,
  MessageSquare,
  MapIcon,
  Terminal,
  GitBranch,
} from 'lucide-react';
import './index.css';

const THEMES = [
  { id: 'dark',        label: 'Dark',        color: '#09090b', accent: '#8b5cf6' },
  { id: 'light',       label: 'Light',       color: '#f1f5f9', accent: '#7c3aed' },
  { id: 'synthwave',   label: 'Synthwave',   color: '#0d0117', accent: '#ff2d78' },
  { id: 'nord',        label: 'Nord',        color: '#2e3440', accent: '#88c0d0' },
  { id: 'catppuccin',  label: 'Catppuccin',  color: '#1e1e2e', accent: '#cba6f7' },
  { id: 'ocean',       label: 'Deep Ocean',  color: '#0a1628', accent: '#38bdf8' },
];

const useTheme = () => {
  const [theme, setThemeState] = useState<string>(() => localStorage.getItem('clawboard-theme') || 'dark');

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('clawboard-theme', theme);
  }, [theme]);

  return { theme, setTheme: setThemeState };
};

const ThemeSwitcher = ({ theme, setTheme }: { theme: string, setTheme: (t: string) => void }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const current = THEMES.find(t => t.id === theme) || THEMES[0];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Changer de thème"
        style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-full)', padding: '7px 14px',
          cursor: 'pointer', color: 'var(--text-secondary)',
          fontSize: '0.875rem', fontWeight: 500, transition: 'all 0.2s',
        }}
        onMouseOver={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
        onMouseOut={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
      >
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: current.accent, display: 'inline-block', boxShadow: `0 0 8px ${current.accent}88` }} />
        <Palette size={14} />
        <span>{current.label}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0,
          background: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)', padding: '6px', zIndex: 100,
          boxShadow: 'var(--shadow-md)', minWidth: '160px',
          display: 'flex', flexDirection: 'column', gap: '2px',
        }}>
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => { setTheme(t.id); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '9px 12px', borderRadius: 'var(--radius-sm)',
                background: theme === t.id ? 'rgba(139,92,246,0.1)' : 'transparent',
                border: theme === t.id ? '1px solid rgba(139,92,246,0.2)' : '1px solid transparent',
                cursor: 'pointer', color: theme === t.id ? 'var(--brand-accent)' : 'var(--text-secondary)',
                fontSize: '0.875rem', fontWeight: 500, textAlign: 'left', width: '100%',
                transition: 'all 0.15s',
              }}
              onMouseOver={e => { if (theme !== t.id) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
              onMouseOut={e => { if (theme !== t.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{
                width: 14, height: 14, borderRadius: '50%', background: t.accent,
                boxShadow: `0 0 6px ${t.accent}66`, flexShrink: 0,
              }} />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const PageContent = () => {
  const location = useLocation();
  const isChat = location.pathname === '/chat';
  return (
    <div className={`page-content${isChat ? ' chat-page' : ''}`}>
      <Suspense fallback={<div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Chargement…</div>}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<TachesPage />} />
          <Route path="/tasks/new" element={<TaskCreator />} />
          <Route path="/tasks/:taskId" element={<TachesPage />} />
          <Route path="/chat" element={<ChatModule />} />
          <Route path="/scheduler" element={<SchedulerModule />} />
          <Route path="/security" element={<SecurityModule />} />
          <Route path="/collaborations" element={<CollaborationModule />} />
          <Route path="/agents" element={<AgentsHierarchyModule />} />
          <Route path="/memory" element={<MemoryModule />} />
          <Route path="/skills" element={<SkillsModule />} />
          <Route path="/terminal" element={<div className="glass-panel p-0" style={{ height: 'calc(100vh - 120px)' }}><TerminalModule /></div>} />
          <Route path="/gitlog" element={<GitLogModule />} />
          <Route path="/settings" element={<SettingsModule />} />
        </Routes>
      </Suspense>
    </div>
  );
};

const NavLink = ({ to, icon: Icon, children, tourId }: { to: string, icon: any, children: React.ReactNode, tourId?: string }) => {
  const location = useLocation();
  const isActive = location.pathname === to || (to !== '/' && location.pathname.startsWith(to));
  return (
    <li>
      <Link to={to} className={`nav-link ${isActive ? 'active' : ''}`} {...(tourId ? { 'data-tour': tourId } : {})}>
        <Icon size={20} />
        <span>{children}</span>
      </Link>
    </li>
  );
};

const Sidebar = () => (
  <nav className="sidebar">
    <div className="sidebar-header">
      <BrainCircuit className="brand-icon" size={28} />
      <h2>ClawBoard</h2>
    </div>
    <ul className="nav-links">
      <NavLink to="/" icon={LayoutDashboard} tourId="nav-dashboard">Tableau de bord</NavLink>
      <NavLink to="/tasks" icon={TerminalSquare} tourId="nav-tasks">Tâches</NavLink>
      <NavLink to="/chat" icon={MessageSquare} tourId="nav-chat">Chat avec Lia</NavLink>
      <NavLink to="/scheduler" icon={CalendarClock} tourId="nav-scheduler">Planificateur</NavLink>
      <NavLink to="/security" icon={ShieldCheck} tourId="nav-security">Sécurité & Scan</NavLink>
      <NavLink to="/collaborations" icon={Globe} tourId="nav-collaborations">Collaborations</NavLink>
      <NavLink to="/agents" icon={Network} tourId="nav-agents">Agents Hierarchy</NavLink>
      <NavLink to="/memory" icon={BrainCircuit} tourId="nav-memory">Mémoire (QMD)</NavLink>
      <NavLink to="/skills" icon={ToyBrick}>Tâches & Skills</NavLink>
      <NavLink to="/terminal" icon={Terminal}>Terminal</NavLink>
      <NavLink to="/gitlog" icon={GitBranch}>Git Log</NavLink>
    </ul>
    <div className="sidebar-footer">
      <NavLink to="/settings" icon={Settings} tourId="nav-settings">Paramètres</NavLink>
    </div>
  </nav>
);

const LiveCost = () => {
  const { data } = useSSE<{ totalCost24h: number } | null>('/api/quota', null);
  const cost = Number(data?.totalCost24h ?? 2.64);
  return (
    <div className="api-cost-widget">
      <span className="text-muted">Coût API (24h) :</span>
      <span className="cost-value" style={{ transition: 'color 0.5s' }}>${cost.toFixed(2)}</span>
    </div>
  );
};

const AppShell = ({ theme, setTheme, onLogout }: { theme: string; setTheme: (t: string) => void; onLogout: () => void }) => {
  const navigate   = useNavigate();
  const [tourRun, setTourRun] = useState(false);
  const user = readUser();
  const displayName = user?.displayName ?? 'Admin';
  const avatarSeed  = encodeURIComponent(user?.username ?? 'Admin');
  const avatarSrc   = user?.avatar ?? `https://api.dicebear.com/7.x/notionists/svg?seed=${avatarSeed}&backgroundColor=8b5cf6`;

  const handleLogout = () => {
    localStorage.removeItem('clawboard-token');
    localStorage.removeItem('clawboard-user');
    onLogout();
  };

  const handleRestartTour = () => {
    resetTour();
    setTourRun(true);
  };

  return (
    <div className="app-container">
      <TourGuide run={tourRun || undefined} onFinish={() => setTourRun(false)} />
      <Sidebar />
      <main className="main-content">
        <header className="topbar glass-panel">
          <h1>Bienvenue sur ClawBoard</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <LiveCost />
            {user?.demo && (
              <div style={{ padding: '4px 12px', borderRadius: '999px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: '0.75rem', fontWeight: 700 }}>
                Démo
              </div>
            )}
            <ThemeSwitcher theme={theme} setTheme={setTheme} />

            <Dropdown
              trigger={
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.05)', padding: '6px 16px 6px 6px', borderRadius: '999px', border: '1px solid var(--border-subtle)', transition: 'background 0.2s' }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}>
                  <img src={avatarSrc} alt="Profile" style={{ width: '34px', height: '34px', borderRadius: '50%' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{displayName}</span>
                </div>
              }
              items={[
                { icon: User,    label: 'Mon Profil',        onClick: () => navigate('/settings?tab=profile') },
                { icon: Palette, label: 'Thème & Apparence', onClick: () => navigate('/settings?tab=theme') },
                { icon: MapIcon, label: 'Revoir le tour',    onClick: handleRestartTour },
                { icon: Settings,label: 'Paramètres',        onClick: () => navigate('/settings') },
                { icon: LogOut,  label: 'Se déconnecter',    danger: true, onClick: handleLogout },
              ]}
            />
          </div>
        </header>

        <PageContent />
      </main>
    </div>
  );
};

const App = () => {
  const { theme, setTheme } = useTheme();
  const [authenticated, setAuthenticated] = useState<boolean>(
    () => Boolean(localStorage.getItem('clawboard-token'))
  );

  if (!authenticated) {
    return (
      <Router>
        <LoginPage onLogin={() => setAuthenticated(true)} />
      </Router>
    );
  }

  return (
    <Router>
      <AppShell theme={theme} setTheme={setTheme} onLogout={() => setAuthenticated(false)} />
    </Router>
  );
};

export default App;
