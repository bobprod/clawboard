import { useState, useEffect } from 'react';
import { CalendarClock, Play, Trash2, Plus, ToggleLeft, ToggleRight, Clock, Zap, Server, AlertCircle } from 'lucide-react';
import { api } from '../hooks/useApi';
import { apiFetch } from '../lib/apiFetch';

interface Cron {
  id: string;
  name: string;
  interval: string;
  agentId: string;
  llmMode: 'local' | 'cloud' | 'hybrid';
  mode: ScheduleMode;
  modeConfig: Record<string, string>;
  active: boolean;
  lastRun: string | null;
  nextRun: string | null;
  runCount: number;
}

type ScheduleMode =
  | 'always'
  | 'run-if-idle'
  | 'run-if-not-run-since'
  | 'skip-if-last-run-within'
  | 'conflict-avoidance'
  | 'priority-queue';

const MODE_LABELS: Record<ScheduleMode, { label: string; desc: string; color: string }> = {
  'always':                  { label: 'Toujours',              desc: 'S\'exécute à chaque intervalle',                    color: '#10b981' },
  'run-if-idle':             { label: 'Si inactif',            desc: 'Seulement quand aucune tâche ne tourne',            color: '#3b82f6' },
  'run-if-not-run-since':    { label: 'Si non exécuté',        desc: 'Garantit une fraîcheur minimale',                   color: '#8b5cf6' },
  'skip-if-last-run-within': { label: 'Debounce',              desc: 'Ignore si exécuté récemment',                      color: '#f59e0b' },
  'conflict-avoidance':      { label: 'Anti-conflit',          desc: 'Évite la contention avec d\'autres tâches',         color: '#ef4444' },
  'priority-queue':          { label: 'File prioritaire',      desc: 'Préempte les tâches moins critiques',               color: '#a78bfa' },
};

const AGENTS = ['agent-main', 'agent-support', 'agent-veille'];
const INTERVALS = ['15m', '30m', '1h', '3h', '6h', '12h', '24h'];

const formatRelative = (iso: string | null) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'maintenant';
  if (mins < 60) return `il y a ${mins}m`;
  return `il y a ${Math.round(mins / 60)}h`;
};

const formatNext = (iso: string | null) => {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'imminent';
  if (mins < 60) return `dans ${mins}m`;
  return `dans ${Math.round(mins / 60)}h`;
};

export const SchedulerModule = () => {
  const [crons, setCrons]         = useState<Cron[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [running, setRunning]     = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState<{
    name: string; interval: string; agentId: string; llmMode: 'local' | 'cloud' | 'hybrid';
    mode: ScheduleMode; modeConfig: Record<string, string>;
  }>({
    name: '', interval: '1h', agentId: 'agent-main', llmMode: 'hybrid',
    mode: 'run-if-idle', modeConfig: {}
  });

  const fetchCrons = async () => {
    try {
      const res = await apiFetch('http://localhost:4000/api/crons');
      if (res.ok) setCrons(await res.json());
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => { fetchCrons(); }, []);

  const handleToggle = async (id: string, active: boolean) => {
    setCrons(c => c.map(x => x.id === id ? { ...x, active } : x));
    await api.patchCron(id, { active });
  };

  const handleDelete = async (id: string) => {
    setCrons(c => c.filter(x => x.id !== id));
    await api.deleteCron(id);
  };

  const handleRun = async (id: string) => {
    setRunning(id);
    await api.runCron(id);
    setTimeout(() => { setRunning(null); fetchCrons(); }, 1500);
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    const cron = await api.createCron({ ...form });
    if (cron?.id) { setCrons(c => [...c, cron]); setShowCreate(false); setForm({ name: '', interval: '1h', agentId: 'agent-main', llmMode: 'hybrid', mode: 'run-if-idle', modeConfig: {} }); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '12px', background: 'rgba(139,92,246,0.1)', borderRadius: '12px', border: '1px solid rgba(139,92,246,0.2)' }}>
            <CalendarClock size={24} color="var(--brand-accent)" />
          </div>
          <div>
            <h2 style={{ fontSize: '1.6rem', margin: 0, letterSpacing: '-0.5px' }}>Planificateur</h2>
            <div className="text-muted" style={{ fontSize: '14px', marginTop: '4px' }}>
              6 modes de scheduling intelligent — inspiré de l'OS scheduling (CS162)
            </div>
          </div>
        </div>
        <button onClick={() => setShowCreate(v => !v)} style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 22px',
          background: showCreate ? 'var(--bg-glass)' : 'linear-gradient(135deg, var(--brand-primary), var(--brand-accent))',
          color: 'var(--text-primary)', border: showCreate ? '1px solid var(--border-subtle)' : 'none',
          borderRadius: 'var(--radius-full)', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
          boxShadow: showCreate ? 'none' : '0 4px 18px rgba(139,92,246,0.4)'
        }}>
          <Plus size={16} /> {showCreate ? 'Annuler' : 'Nouveau CRON'}
        </button>
      </div>

      {/* Mode Legend */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        {(Object.entries(MODE_LABELS) as [ScheduleMode, typeof MODE_LABELS[ScheduleMode]][]).map(([mode, info]) => (
          <div key={mode} className="glass-panel" style={{ padding: '12px 14px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: info.color, flexShrink: 0, marginTop: '5px' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '12px', color: info.color }}>{info.label}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{info.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="glass-panel p-6" style={{ border: '1px solid rgba(139,92,246,0.3)' }}>
          <h3 style={{ margin: '0 0 20px', fontSize: '1rem', color: 'var(--brand-accent)' }}>Créer un nouveau CRON</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Nom</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Audit Sécurité"
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', color: 'var(--text-primary)', fontSize: '14px', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Intervalle</label>
              <select value={form.interval} onChange={e => setForm(f => ({ ...f, interval: e.target.value }))}
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', color: 'var(--text-primary)', fontSize: '14px' }}>
                {INTERVALS.map(i => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Agent</label>
              <select value={form.agentId} onChange={e => setForm(f => ({ ...f, agentId: e.target.value }))}
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', color: 'var(--text-primary)', fontSize: '14px' }}>
                {AGENTS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: 600 }}>LLM Mode</label>
              <select value={form.llmMode} onChange={e => setForm(f => ({ ...f, llmMode: e.target.value as 'local' | 'cloud' | 'hybrid' }))}
                style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: '10px', color: 'var(--text-primary)', fontSize: '14px' }}>
                <option value="local">Local (Ollama)</option>
                <option value="cloud">Cloud (NVIDIA)</option>
                <option value="hybrid">Hybrid (Privacy Router)</option>
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', fontWeight: 600 }}>Mode de Scheduling</label>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {(Object.keys(MODE_LABELS) as ScheduleMode[]).map(m => (
                  <button key={m} onClick={() => setForm(f => ({ ...f, mode: m }))} style={{
                    padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    background: form.mode === m ? `${MODE_LABELS[m].color}22` : 'var(--bg-glass)',
                    border: `1px solid ${form.mode === m ? MODE_LABELS[m].color : 'var(--border-subtle)'}`,
                    color: form.mode === m ? MODE_LABELS[m].color : 'var(--text-secondary)',
                    transition: 'all 0.15s'
                  }}>
                    {MODE_LABELS[m].label}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <AlertCircle size={11} />
                {MODE_LABELS[form.mode].desc}
              </div>
            </div>
          </div>
          <button onClick={handleCreate} style={{
            padding: '10px 28px', background: 'linear-gradient(135deg, var(--brand-primary), var(--brand-accent))',
            color: 'var(--text-primary)', border: 'none', borderRadius: 'var(--radius-full)', cursor: 'pointer', fontWeight: 700, fontSize: '14px'
          }}>
            Créer le CRON
          </button>
        </div>
      )}

      {/* Cron List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {loading && <div className="text-muted" style={{ textAlign: 'center', padding: '32px' }}>Chargement...</div>}
        {!loading && crons.length === 0 && (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
            Aucun CRON planifié — créez-en un ci-dessus
          </div>
        )}
        {crons.map(cron => {
          const modeInfo = MODE_LABELS[cron.mode as ScheduleMode] ?? { label: cron.mode, color: '#a1a1aa', desc: '' };
          return (
            <div key={cron.id} className="glass-panel" style={{
              padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '20px',
              border: '1px solid var(--border-subtle)',
              opacity: cron.active ? 1 : 0.55,
              transition: 'all 0.2s'
            }}>
              {/* Toggle */}
              <button onClick={() => handleToggle(cron.id, !cron.active)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: cron.active ? '#10b981' : '#52525b', flexShrink: 0 }}>
                {cron.active ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
              </button>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: '1rem' }}>{cron.name}</span>
                  <span style={{ fontSize: '11px', background: `${modeInfo.color}22`, color: modeInfo.color, padding: '3px 9px', borderRadius: '99px', fontWeight: 700, border: `1px solid ${modeInfo.color}44` }}>
                    {modeInfo.label}
                  </span>
                  <span style={{ fontSize: '11px', background: 'var(--bg-glass)', color: 'var(--text-secondary)', padding: '3px 8px', borderRadius: '6px', fontFamily: 'var(--mono)' }}>
                    /{cron.interval}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '20px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {cron.llmMode === 'local' ? <Server size={11} /> : <Zap size={11} />}
                    {cron.agentId} · {cron.llmMode}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Clock size={11} /> Dernier: {formatRelative(cron.lastRun)}
                  </span>
                  {cron.active && (
                    <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Clock size={11} /> Prochain: {formatNext(cron.nextRun)}
                    </span>
                  )}
                  <span style={{ fontFamily: 'var(--mono)' }}>×{cron.runCount}</span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                <button onClick={() => handleRun(cron.id)} disabled={running === cron.id} style={{
                  display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px',
                  background: running === cron.id ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.08)',
                  color: 'var(--brand-primary)', border: '1px solid rgba(59,130,246,0.2)',
                  borderRadius: '10px', cursor: 'pointer', fontWeight: 600, fontSize: '12px', transition: 'all 0.2s'
                }}>
                  <Play size={13} />
                  {running === cron.id ? 'Lancé...' : 'Lancer'}
                </button>
                <button onClick={() => handleDelete(cron.id)} style={{
                  display: 'flex', alignItems: 'center', padding: '8px 10px',
                  background: 'rgba(239,68,68,0.06)', color: '#ef4444',
                  border: '1px solid rgba(239,68,68,0.15)', borderRadius: '10px', cursor: 'pointer'
                }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
