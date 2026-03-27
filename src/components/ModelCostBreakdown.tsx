import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/apiFetch';
import { DollarSign } from 'lucide-react';

const BASE = 'http://localhost:4000';

type Period = '7d' | '30d' | 'all';

interface ModelStat {
  model:  string;
  runs:   number;
  cost:   number;
  tokens: number;
}

const MODEL_COLORS: Record<string, string> = {
  claude:    '#8b5cf6',
  nemotron:  '#76b900',
  llama:     '#0064c8',
  deepseek:  '#1a73e8',
  gemini:    '#4285f4',
  kimi:      '#3b82f6',
  qwq:       '#9333ea',
  local:     '#10b981',
};

function modelColor(id: string): string {
  const lower = id.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return '#a1a1aa';
}

function modelLabel(id: string): string {
  if (!id) return '—';
  if (id.includes('claude'))           return 'Claude Sonnet';
  if (id.includes('nemotron-ultra'))   return 'Nemotron Ultra';
  if (id.includes('nemotron-super'))   return 'Nemotron Super';
  if (id.includes('llama-3.1-405'))    return 'Llama 405B';
  if (id.includes('deepseek'))         return 'DeepSeek V3';
  if (id.includes('kimi'))             return 'Kimi K2.5';
  if (id.includes('qwq'))              return 'QwQ 32B';
  if (id.includes('gemini'))           return 'Gemini Flash';
  if (id.includes('ollama'))           return 'Qwen Local';
  return id.split('/').pop()?.slice(0, 14) ?? id;
}

function cutoffFor(period: Period): number {
  const now = Date.now();
  if (period === '7d')  return now - 7  * 86_400_000;
  if (period === '30d') return now - 30 * 86_400_000;
  return 0;
}

export function ModelCostBreakdown() {
  const [archives, setArchives] = useState<any[]>([]);
  const [period,   setPeriod]   = useState<Period>('30d');

  useEffect(() => {
    apiFetch(`${BASE}/api/archives`).then(r => r.json()).then(d => setArchives(Array.isArray(d) ? d : (d.archives ?? d.data ?? []))).catch(() => {});
  }, []);

  const cutoff = cutoffFor(period);
  const filtered = archives.filter(a => {
    const t = new Date(a.startedAt ?? a.date ?? 0).getTime();
    return t >= cutoff;
  });

  // Aggregate by model
  const map: Record<string, ModelStat> = {};
  for (const a of filtered) {
    const model = a.llmModel ?? 'unknown';
    if (!map[model]) map[model] = { model, runs: 0, cost: 0, tokens: 0 };
    map[model].runs++;
    map[model].cost   += typeof a.cost === 'number' ? a.cost : parseFloat(a.cost ?? '0') || 0;
    map[model].tokens += (a.promptTokens ?? 0) + (a.completionTokens ?? a.tokens ?? 0);
  }
  const stats = Object.values(map).sort((a, b) => b.cost - a.cost);
  const maxCost = Math.max(...stats.map(s => s.cost), 0.0001);
  const totalCost = stats.reduce((s, m) => s + m.cost, 0);

  return (
    <div className="glass-panel p-6" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <DollarSign size={17} color="#10b981" />
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Coûts par modèle LLM</h2>
        {/* Period tabs */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, background: 'var(--bg-glass)', padding: '3px', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          {(['7d', '30d', 'all'] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: period === p ? 'rgba(16,185,129,0.15)' : 'transparent',
              color: period === p ? '#10b981' : 'var(--text-muted)',
              fontWeight: 600, fontSize: '11px', transition: 'all 0.15s',
            }}>
              {p === '7d' ? '7 jours' : p === '30d' ? '30 jours' : 'Tout'}
            </button>
          ))}
        </div>
      </div>

      {/* Total */}
      {totalCost > 0 && (
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          Total période : <strong style={{ color: '#10b981', fontSize: '15px' }}>${totalCost.toFixed(4)}</strong>
          <span style={{ marginLeft: 10, opacity: 0.6 }}>· {filtered.length} exécutions</span>
        </div>
      )}

      {/* Bars */}
      {stats.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px', opacity: 0.6 }}>
          Aucune exécution sur cette période
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stats.map(s => {
            const pct   = (s.cost / maxCost) * 100;
            const share = totalCost > 0 ? (s.cost / totalCost) * 100 : 0;
            const color = modelColor(s.model);
            return (
              <div key={s.model} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{modelLabel(s.model)}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{s.runs} run{s.runs !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{(s.tokens / 1000).toFixed(1)}k tk</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, color, fontFamily: 'var(--mono)', minWidth: 64, textAlign: 'right' }}>
                      ${s.cost.toFixed(4)}
                    </span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', minWidth: 34, textAlign: 'right' }}>
                      {share.toFixed(0)}%
                    </span>
                  </div>
                </div>
                {/* Bar */}
                <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${color}aa, ${color})`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
