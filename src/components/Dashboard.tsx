import { useState, useEffect } from 'react';
import { Activity, CheckCircle, Clock, AlertCircle, TrendingUp } from 'lucide-react';
import { useSSE } from '../hooks/useSSE';
import { apiFetch } from '../lib/apiFetch';
import { SystemVitals } from './SystemVitals';
import { FuelGauges } from './FuelGauges';
import { AlertsBanner } from './AlertsBanner';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ModelCostBreakdown } from './ModelCostBreakdown';
import { AgentChat } from './AgentChat';
import { ApprovalsWidget } from './ApprovalsWidget';
import { GatewayProbes } from './GatewayProbes';
import { GatewayPresence } from './GatewayPresence';
import { DashboardTour } from './DashboardTour';
import type { Task } from '../data/mockData';

const statusStyle = (status: string) => ({
  padding: '5px 12px',
  borderRadius: '99px',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.5px',
  background:
    status === 'completed' ? 'rgba(16,185,129,0.12)' :
    status === 'running'   ? 'rgba(59,130,246,0.12)'  :
    status === 'failed'    ? 'rgba(239,68,68,0.12)'   :
    'rgba(255,255,255,0.06)',
  color:
    status === 'completed' ? 'var(--status-success)' :
    status === 'running'   ? 'var(--brand-primary)'  :
    status === 'failed'    ? 'var(--status-error)'   :
    'var(--text-secondary)',
});

export const Dashboard = () => {
  const { data: liveTasks } = useSSE<Task[] | null>('/api/tasks?stream=1', null);
  const tasks = liveTasks ?? [];
  const [cronsActive, setCronsActive] = useState(0);

  useEffect(() => {
    apiFetch('http://localhost:4000/api/recurrences').then(r => r.json()).then((crons: any[]) => {
      setCronsActive(crons.filter(c => c.active).length);
    }).catch(() => {});
  }, []);

  const kpis = {
    activeTasks:    tasks.filter(t => t.status === 'running').length,
    completedToday: tasks.filter(t => t.status === 'completed').length,
    failedToday:    tasks.filter(t => t.status === 'failed').length,
    cronsActive,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* ── Dashboard Tour ────────────────────────────────────────────── */}
      <DashboardTour />

      {/* ── Smart Alerts Banner ────────────────────────────────────────── */}
      <div data-tour="dashboard-alerts">
        <AlertsBanner />
      </div>

      {/* ── KPI Cards ─────────────────────────────────────────────────── */}
      <div data-tour="dashboard-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
        <div className="glass-panel p-6" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '14px', background: 'rgba(59,130,246,0.1)', borderRadius: '14px', color: 'var(--brand-primary)' }}>
            <Activity size={26} />
          </div>
          <div>
            <div className="text-muted">Tâches Actives</div>
            <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-0.5px' }}>{kpis.activeTasks}</div>
          </div>
        </div>

        <div className="glass-panel p-6" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '14px', background: 'rgba(16,185,129,0.1)', borderRadius: '14px', color: 'var(--status-success)' }}>
            <CheckCircle size={26} />
          </div>
          <div>
            <div className="text-muted">Complétées Aujourd'hui</div>
            <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-0.5px' }}>{kpis.completedToday}</div>
          </div>
        </div>

        <div className="glass-panel p-6" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '14px', background: 'rgba(139,92,246,0.1)', borderRadius: '14px', color: 'var(--brand-accent)' }}>
            <Clock size={26} />
          </div>
          <div>
            <div className="text-muted">CRONs Actifs</div>
            <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-0.5px' }}>{kpis.cronsActive}</div>
          </div>
        </div>

        <div className="glass-panel p-6" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ padding: '14px', background: 'rgba(239,68,68,0.1)', borderRadius: '14px', color: 'var(--status-error)' }}>
            <AlertCircle size={26} />
          </div>
          <div>
            <div className="text-muted">Échecs (24h)</div>
            <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-0.5px' }}>{kpis.failedToday}</div>
          </div>
        </div>
      </div>

      {/* ── Vitals + Fuel Gauges ──────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <SystemVitals />
        <FuelGauges />
      </div>

      {/* ── Activity Heatmap ──────────────────────────────────────────── */}
      <div data-tour="dashboard-heatmap">
        <ActivityHeatmap />
      </div>

      {/* ── Cost breakdown + Flux ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>

        {/* Per-model cost breakdown */}
        <div data-tour="dashboard-costs">
          <ModelCostBreakdown />
        </div>

        {/* Flux d'exécutions récentes */}
        <div className="glass-panel p-6">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
            <TrendingUp size={18} color="var(--brand-primary)" />
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Flux d'Exécutions</h2>
            {liveTasks && (
              <span style={{ marginLeft: 'auto', fontSize: '11px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulseDot 2s ease-in-out infinite' }} />
                Live
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: 360, overflowY: 'auto' }}>
            {(tasks.length ? tasks : []).map(task => (
              <div key={task.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 14px',
                background: 'var(--bg-glass)',
                borderRadius: '10px',
                border: '1px solid var(--border-subtle)',
                transition: 'background 0.2s',
                cursor: 'pointer',
              }}
              onMouseOver={e => (e.currentTarget as HTMLElement).style.opacity = '0.85'}
              onMouseOut={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(task as any).name || task.title}
                  </div>
                  <div className="text-muted" style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px' }}>
                    <span>{task.agentId}</span>
                    <span>·</span>
                    <span style={{ fontFamily: 'var(--mono)', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: '3px', fontSize: '10px' }}>
                      {((task as any).llmModel?.split('/').pop() ?? task.llmMode ?? '—').toUpperCase()}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                  {task.tokensUsed && (task.tokensUsed.prompt + task.tokensUsed.completion) > 0 && (
                    <span style={{ color: 'var(--status-success)', fontFamily: 'var(--mono)', fontWeight: 600, fontSize: '12px' }}>
                      ${Number(task.cost ?? 0).toFixed(4)}
                    </span>
                  )}
                  <span style={statusStyle(task.status)}>{task.status?.toUpperCase() ?? '—'}</span>
                </div>
              </div>
            ))}
            {tasks.length === 0 && (
              <div className="text-muted" style={{ textAlign: 'center', padding: '24px', fontSize: '13px' }}>
                Aucune tâche récente
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Approvals + Gateway Probes ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div data-tour="dashboard-approvals">
          <ApprovalsWidget />
        </div>
        <div data-tour="dashboard-probes">
          <GatewayProbes />
        </div>
      </div>

      {/* ── Presence + placeholder ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <GatewayPresence />
      </div>

      {/* ── Agent Chat (floating) ──────────────────────────────────────── */}
      <AgentChat />

      <style>{`
        @keyframes pulseDot {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
};
