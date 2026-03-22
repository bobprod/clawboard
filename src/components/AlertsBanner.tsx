import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, AlertCircle, Info, X, Bell, BellOff, Settings } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';
const SETTINGS_KEY = 'clawboard-alerts-settings';

interface AlertSettings {
  dailyCostWarn:    number;   // €/$  default 20
  dailyCostCrit:    number;   // €/$  default 50
  contextPct:       number;   // %    default 80
  enabled:          boolean;
}

const DEFAULT_SETTINGS: AlertSettings = {
  dailyCostWarn: 20,
  dailyCostCrit: 50,
  contextPct:    80,
  enabled:       true,
};

export interface Alert {
  id:       string;
  severity: 'error' | 'warn' | 'info';
  icon:     React.ReactNode;
  title:    string;
  detail:   string;
}

function loadSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
}

function saveSettings(s: AlertSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function AlertsBanner() {
  const [alerts,      setAlerts]      = useState<Alert[]>([]);
  const [dismissed,   setDismissed]   = useState<Set<string>>(new Set());
  const [settings,    setSettings]    = useState<AlertSettings>(loadSettings);
  const [showConfig,  setShowConfig]  = useState(false);
  const [draftCfg,    setDraftCfg]    = useState<AlertSettings>(loadSettings);

  const buildAlerts = useCallback(async () => {
    if (!settings.enabled) { setAlerts([]); return; }
    const next: Alert[] = [];

    // 1 ── Gateway health
    try {
      const r = await apiFetch(`${BASE}/api/health`);
      if (!r.ok) {
        next.push({
          id: 'gateway-down', severity: 'error',
          icon: <AlertCircle size={15} />,
          title: 'Gateway Nemoclaw inaccessible',
          detail: `Statut HTTP ${r.status} — vérifiez que le backend tourne sur :4000`,
        });
      }
    } catch {
      next.push({
        id: 'gateway-down', severity: 'error',
        icon: <AlertCircle size={15} />,
        title: 'Gateway Nemoclaw inaccessible',
        detail: 'Impossible de joindre le backend sur :4000',
      });
    }

    // 2 ── Failed crons
    try {
      const [archivesRes, cronsRes] = await Promise.all([
        apiFetch(`${BASE}/api/archives`),
        apiFetch(`${BASE}/api/recurrences`),
      ]);
      const archives: any[] = await archivesRes.json();
      const crons:    any[] = await cronsRes.json();

      const failedCrons = crons.filter(c => c.active && c.modeleId && (() => {
        const last = archives
          .filter(a => a.modeleId === c.modeleId)
          .sort((a, b) => new Date(b.startedAt ?? b.date ?? 0).getTime() - new Date(a.startedAt ?? a.date ?? 0).getTime())[0];
        if (!last) return false;
        return last.exitCode !== 0 && last.status !== 'ok' && last.status !== 'completed';
      })());

      if (failedCrons.length > 0) {
        next.push({
          id: 'cron-failed', severity: 'error',
          icon: <AlertCircle size={15} />,
          title: `${failedCrons.length} CRON${failedCrons.length > 1 ? 's' : ''} en échec`,
          detail: failedCrons.map(c => c.name).join(', '),
        });
      }

      // 3 ── Daily cost
      const today = new Date().toISOString().slice(0, 10);
      const todayCost = archives
        .filter(a => (a.startedAt ?? a.date ?? '').startsWith(today))
        .reduce((sum, a) => sum + (typeof a.cost === 'number' ? a.cost : parseFloat(a.cost ?? '0') || 0), 0);

      if (todayCost >= settings.dailyCostCrit) {
        next.push({
          id: 'cost-crit', severity: 'error',
          icon: <AlertCircle size={15} />,
          title: `Coût journalier critique : $${todayCost.toFixed(2)}`,
          detail: `Seuil critique de $${settings.dailyCostCrit} dépassé — ${archives.filter(a => (a.startedAt ?? a.date ?? '').startsWith(today)).length} exécutions aujourd'hui`,
        });
      } else if (todayCost >= settings.dailyCostWarn) {
        next.push({
          id: 'cost-warn', severity: 'warn',
          icon: <AlertTriangle size={15} />,
          title: `Coût journalier élevé : $${todayCost.toFixed(2)}`,
          detail: `Seuil d'alerte de $${settings.dailyCostWarn} atteint`,
        });
      }
    } catch { /* silently ignore data fetch errors */ }

    // 4 ── Tasks with high context usage
    try {
      const tasksRes = await apiFetch(`${BASE}/api/tasks`);
      const allTasks: any[] = await tasksRes.json();
      const highCtx = allTasks.filter(t => {
        if (t.status !== 'running') return false;
        const used  = (t.tokensUsed?.prompt ?? 0) + (t.tokensUsed?.completion ?? 0);
        const limit = t.contextLimit ?? 128000;
        return used / limit >= settings.contextPct / 100;
      });
      if (highCtx.length > 0) {
        next.push({
          id: 'context-high', severity: 'warn',
          icon: <AlertTriangle size={15} />,
          title: `Contexte > ${settings.contextPct}% sur ${highCtx.length} tâche${highCtx.length > 1 ? 's' : ''}`,
          detail: highCtx.map(t => t.name || t.title).join(', '),
        });
      }
    } catch { /* silently ignore */ }

    setAlerts(next);
  }, [settings]);

  useEffect(() => {
    buildAlerts();
    const interval = setInterval(buildAlerts, 60_000);
    return () => clearInterval(interval);
  }, [buildAlerts]);

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (!settings.enabled && visible.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => { const s = { ...settings, enabled: true }; setSettings(s); saveSettings(s); }} style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '5px 12px', borderRadius: 8, cursor: 'pointer', fontSize: '11px', fontWeight: 600,
          background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
        }}>
          <Bell size={12} /> Alertes désactivées
        </button>
      </div>
    );
  }

  if (visible.length === 0 && !showConfig) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Config panel */}
      {showConfig && (
        <div style={{
          padding: '16px 20px', borderRadius: 12,
          background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Settings size={14} /> Seuils d'alertes
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Coût warn ($)</span>
              <input type="number" min={1} value={draftCfg.dailyCostWarn}
                onChange={e => setDraftCfg(d => ({ ...d, dailyCostWarn: Number(e.target.value) }))}
                style={{ padding: '6px 10px', borderRadius: 7, background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', fontFamily: 'var(--mono)' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Coût critique ($)</span>
              <input type="number" min={1} value={draftCfg.dailyCostCrit}
                onChange={e => setDraftCfg(d => ({ ...d, dailyCostCrit: Number(e.target.value) }))}
                style={{ padding: '6px 10px', borderRadius: 7, background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', fontFamily: 'var(--mono)' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Contexte (%)</span>
              <input type="number" min={50} max={100} value={draftCfg.contextPct}
                onChange={e => setDraftCfg(d => ({ ...d, contextPct: Number(e.target.value) }))}
                style={{ padding: '6px 10px', borderRadius: 7, background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', fontFamily: 'var(--mono)' }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { const s = { ...draftCfg, enabled: false }; setSettings(s); saveSettings(s); setShowConfig(false); }} style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: '12px', fontWeight: 600,
              background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
            }}><BellOff size={12} /> Désactiver</button>
            <button onClick={() => { saveSettings(draftCfg); setSettings(draftCfg); setShowConfig(false); buildAlerts(); }} style={{
              padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: '12px', fontWeight: 700,
              background: 'var(--brand-accent)', color: '#fff', border: 'none',
            }}>Enregistrer</button>
          </div>
        </div>
      )}

      {/* Alert rows */}
      {visible.map(alert => (
        <div key={alert.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px', borderRadius: 10,
          background: alert.severity === 'error' ? 'rgba(239,68,68,0.08)' : alert.severity === 'warn' ? 'rgba(245,158,11,0.08)' : 'rgba(59,130,246,0.08)',
          border: `1px solid ${alert.severity === 'error' ? 'rgba(239,68,68,0.3)' : alert.severity === 'warn' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)'}`,
          color: alert.severity === 'error' ? '#ef4444' : alert.severity === 'warn' ? '#f59e0b' : '#3b82f6',
          animation: 'fadeInDown 0.25s ease',
        }}>
          {alert.icon}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: '13px' }}>{alert.title}</span>
            {alert.detail && (
              <span style={{ marginLeft: 8, fontSize: '12px', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                — {alert.detail}
              </span>
            )}
          </div>
          <button onClick={() => setShowConfig(v => !v)} title="Configurer les seuils" style={{
            background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6,
            color: 'inherit', display: 'flex', padding: 4,
          }}><Settings size={13} /></button>
          <button onClick={() => setDismissed(d => new Set([...d, alert.id]))} title="Ignorer" style={{
            background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6,
            color: 'inherit', display: 'flex', padding: 4,
          }}><X size={14} /></button>
        </div>
      ))}

      <style>{`@keyframes fadeInDown { from { transform: translateY(-8px); opacity: 0; } to { transform: none; opacity: 1; } }`}</style>
    </div>
  );
}
