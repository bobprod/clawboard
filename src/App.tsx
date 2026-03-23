import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Dashboard } from './components/Dashboard';
import { TaskCreator } from './components/TaskCreator';
import { TachesPage } from './components/TachesPage';
import { SecurityModule } from './components/SecurityModule';
import { CollaborationModule } from './components/CollaborationModule';
import { AgentsHierarchyModule } from './components/AgentsHierarchyModule';
import { MemoryModule } from './components/MemoryModule';
import { SkillsModule } from './components/SkillsModule';
import { SettingsModule } from './components/SettingsModule';
import { SchedulerModule } from './components/SchedulerModule';
import { ChatModule } from './components/ChatModule';
import { TerminalModule } from './components/TerminalModule';
import { Dropdown } from './components/Dropdown';
import { TourGuide, resetTour } from './components/TourGuide';
import { useSSE } from './hooks/useSSE';
import {
  TerminalSquare,
  LayoutDashboard,
  ShieldCheck,
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
        <Route path="/settings" element={<SettingsModule />} />
      </Routes>
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
      <NavLink to="/collaborations" icon={Network} tourId="nav-collaborations">Collaborations</NavLink>
      <NavLink to="/agents" icon={Network} tourId="nav-agents">Agents Hierarchy</NavLink>
      <NavLink to="/memory" icon={BrainCircuit} tourId="nav-memory">Mémoire (QMD)</NavLink>
      <NavLink to="/skills" icon={ToyBrick}>Tâches & Skills</NavLink>
      <NavLink to="/terminal" icon={Terminal}>Terminal</NavLink>
    </ul>
    <div className="sidebar-footer">
      <NavLink to="/settings" icon={Settings} tourId="nav-settings">Paramètres</NavLink>
    </div>
  </nav>
);

const LiveCost = () => {
  const { data } = useSSE<{ totalCost24h: number } | null>('/api/quota', null);
  const cost = data?.totalCost24h ?? 2.64;
  return (
    <div className="api-cost-widget">
      <span className="text-muted">Coût API (24h) :</span>
      <span className="cost-value" style={{ transition: 'color 0.5s' }}>${cost.toFixed(2)}</span>
    </div>
  );
};

const AppShell = ({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) => {
  const navigate = useNavigate();
  const [tourRun, setTourRun] = useState(false);

  const handleLogout = () => {
    localStorage.removeItem('clawboard-token');
    localStorage.removeItem('clawboard-user');
    navigate('/');
    window.location.reload();
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
            <ThemeSwitcher theme={theme} setTheme={setTheme} />

            <Dropdown
              trigger={
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.05)', padding: '6px 16px 6px 6px', borderRadius: '999px', border: '1px solid var(--border-subtle)', transition: 'background 0.2s' }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}>
                  <img src="https://api.dicebear.com/7.x/notionists/svg?seed=Admin&backgroundColor=8b5cf6" alt="Profile" style={{ width: '34px', height: '34px', borderRadius: '50%' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>Admin</span>
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
  return (
    <Router>
      <AppShell theme={theme} setTheme={setTheme} />
    </Router>
  );
};

export default App;
