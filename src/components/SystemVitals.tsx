import { Cpu, MemoryStick, Clock, Wifi, WifiOff } from 'lucide-react';
import { useSSE } from '../hooks/useSSE';

interface Vitals {
  cpu: number;
  ram: { used: number; total: number; pct: number };
  uptime: number;
  platform: string;
  hostname: string;
  loadAvg: number[];
}

const Bar = ({ pct, color }: { pct: number; color: string }) => (
  <div style={{ height: '6px', background: 'rgba(255,255,255,0.07)', borderRadius: '99px', overflow: 'hidden' }}>
    <div style={{
      height: '100%', width: `${Math.min(pct, 100)}%`,
      background: color,
      borderRadius: '99px',
      transition: 'width 1.5s ease',
      boxShadow: `0 0 8px ${color}55`
    }} />
  </div>
);

const formatUptime = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
};

const cpuColor = (pct: number) =>
  pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#10b981';

const ramColor = (pct: number) =>
  pct > 85 ? '#ef4444' : pct > 60 ? '#f59e0b' : '#3b82f6';

export const SystemVitals = () => {
  const { data: vitals, connected } = useSSE<Vitals | null>('/api/vitals', null);

  return (
    <div className="glass-panel p-6" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
          Vitaux Système
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: connected ? '#10b981' : '#ef4444' }}>
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? 'Live' : 'Hors ligne'}
        </div>
      </div>

      {!vitals ? (
        <div className="text-muted" style={{ fontSize: '13px', textAlign: 'center', padding: '8px 0' }}>
          {connected ? 'Chargement...' : 'Backend hors ligne — démarrez server.mjs'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* CPU */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: cpuColor(vitals.cpu) }}>
                <Cpu size={14} />
                <span style={{ fontSize: '13px', fontWeight: 600 }}>CPU</span>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '13px', color: cpuColor(vitals.cpu) }}>
                {vitals.cpu}%
              </span>
            </div>
            <Bar pct={vitals.cpu} color={cpuColor(vitals.cpu)} />
          </div>

          {/* RAM */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: ramColor(vitals.ram.pct) }}>
                <MemoryStick size={14} />
                <span style={{ fontSize: '13px', fontWeight: 600 }}>RAM</span>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: '13px', color: ramColor(vitals.ram.pct) }}>
                {vitals.ram.used} / {vitals.ram.total} MB
              </span>
            </div>
            <Bar pct={vitals.ram.pct} color={ramColor(vitals.ram.pct)} />
          </div>

          {/* Uptime + hostname */}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '4px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Clock size={12} />
              Uptime: <span style={{ fontFamily: 'var(--mono)', color: '#a1a1aa' }}>{formatUptime(vitals.uptime)}</span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
              {vitals.platform} · {vitals.hostname}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
