import { useState, useEffect } from 'react';
import { Shield, ShieldCheck, Activity, Lock, Globe, FileCode, ToggleLeft, ToggleRight } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';

interface Guardrail {
  id: string;
  name: string;
  enabled: boolean;
}

interface SecEvent {
  time: string;
  type: 'block' | 'allow';
  desc: string;
  reason: string;
  taskId?: string;
}

const iconFor = (name: string) => {
  if (name.toLowerCase().includes('npm') || name.toLowerCase().includes('pypi') || name.toLowerCase().includes('file') || name.toLowerCase().includes('code')) return <FileCode size={16} />;
  if (name.toLowerCase().includes('network') || name.toLowerCase().includes('outbound')) return <Globe size={16} />;
  return <Lock size={16} />;
};

export const SecurityModule = () => {
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [events, setEvents]         = useState<SecEvent[]>([]);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch(`${BASE}/api/security/guardrails`).then(r => r.json()).catch(() => []),
      apiFetch(`${BASE}/api/security/events`).then(r => r.json()).catch(() => []),
    ]).then(([g, e]) => {
      setGuardrails(g);
      setEvents(e);
      setLoading(false);
    });
  }, []);

  const handleToggle = async (g: Guardrail) => {
    const next = !g.enabled;
    setGuardrails(prev => prev.map(x => x.id === g.id ? { ...x, enabled: next } : x));
    await apiFetch(`${BASE}/api/security/guardrails`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: g.id, enabled: next }),
    }).catch(() => {});
  };

  const blocked = events.filter(e => e.type === 'block').length;
  const allowed = events.filter(e => e.type === 'allow').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', paddingBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{ background: 'var(--brand-accent)', padding: '12px', borderRadius: '14px', color: 'var(--text-primary)' }}>
          <ShieldCheck size={28} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Sécurité & Privacy Router</h2>
          <div className="text-muted" style={{ marginTop: '4px' }}>
            {blocked} bloqué{blocked !== 1 ? 's' : ''} · {allowed} autorisé{allowed !== 1 ? 's' : ''} · surveillance proactive OpenShell
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-muted" style={{ textAlign: 'center', padding: '40px' }}>Chargement…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1.2fr) 2fr', gap: '24px', flexGrow: 1 }}>

          {/* Left Column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* Status */}
            <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', margin: 0, color: 'var(--text-primary)' }}>
                <Shield size={18} /> Statut Global du Noyau
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: 'rgba(16,185,129,0.05)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(16,185,129,0.2)' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--status-success)' }}>
                  <ShieldCheck size={24} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '1.2rem', color: 'var(--status-success)' }}>Sécurisé</div>
                  <div className="text-muted" style={{ fontSize: '13px' }}>NemoClaw Privacy Core actif et fonctionnel.</div>
                </div>
              </div>
            </div>

            {/* Guardrails */}
            <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', margin: 0, color: 'var(--text-primary)' }}>
                <Lock size={18} /> Garde-fous Actifs (Sandbox)
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {guardrails.map(g => (
                  <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', background: 'var(--bg-glass)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: g.enabled ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                      {iconFor(g.name)}
                      <span style={{ fontWeight: 500, fontSize: '14px' }}>{g.name}</span>
                    </div>
                    <button onClick={() => handleToggle(g)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: g.enabled ? '#10b981' : 'var(--text-muted)', display: 'flex', padding: 0 }}>
                      {g.enabled ? <ToggleRight size={26} /> : <ToggleLeft size={26} />}
                    </button>
                  </div>
                ))}
                {guardrails.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>Aucun garde-fou configuré</div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Events */}
          <div className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem', margin: 0, color: 'var(--text-primary)' }}>
                <Activity size={18} /> Radar de Filtrage & Logs (Temps Réel)
              </h3>
              <span style={{ fontSize: '12px', background: 'var(--bg-glass)', padding: '6px 12px', borderRadius: '16px', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                {events.length} événements récents
              </span>
            </div>

            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', paddingRight: '8px' }}>
              {events.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  Aucun événement récent
                </div>
              )}
              {events.map((ev, i) => (
                <div key={i} style={{
                  display: 'flex', gap: '16px', padding: '16px 20px', borderRadius: '8px',
                  background: ev.type === 'block' ? 'rgba(239,68,68,0.04)' : 'rgba(16,185,129,0.04)',
                  borderLeft: `4px solid ${ev.type === 'block' ? 'var(--status-error)' : 'var(--status-success)'}`,
                  borderTop: '1px solid var(--border-subtle)',
                  borderRight: '1px solid var(--border-subtle)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '13px', color: 'var(--text-secondary)', minWidth: '70px', marginTop: '2px' }}>
                    {ev.time ?? '—'}
                  </div>
                  <div style={{ flexGrow: 1 }}>
                    <div style={{ fontWeight: 600, color: ev.type === 'block' ? 'var(--status-error)' : 'var(--status-success)', marginBottom: '6px', fontSize: '0.9rem', letterSpacing: '0.5px' }}>
                      {ev.type === 'block' ? 'ACCÈS REFUSÉ' : 'ACCÈS AUTORISÉ'}
                    </div>
                    <div style={{ fontSize: '14px', lineHeight: 1.4, color: 'var(--text-primary)' }}>{ev.desc}</div>
                  </div>
                  <div style={{ fontSize: '12px', background: 'var(--bg-glass)', padding: '6px 12px', borderRadius: '6px', height: 'fit-content', fontWeight: 500, border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {ev.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
