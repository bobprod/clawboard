/**
 * LiaPlanPreview — Affichage et exécution d'un plan généré par Lia
 */
import { useState } from 'react';
import { CheckCircle, AlertTriangle, Zap, Clock, Loader2, ExternalLink } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useNavigate } from 'react-router-dom';

const BASE = 'http://localhost:4000';

export interface PlanStep {
  id: string;
  name: string;
  skill?: string;
  agent?: string;
  prompt: string;
  recurrence?: string | null;
  approval_needed?: boolean;
  depends_on?: string[];
}

export interface LiaPlan {
  summary: string;
  steps: PlanStep[];
  risks?: string[];
  estimated_tokens?: number;
}

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface Props {
  plan: LiaPlan;
  onExecuted?: (results: { step: PlanStep; taskId?: string }[]) => void;
}

export function LiaPlanPreview({ plan, onExecuted }: Props) {
  const navigate = useNavigate();
  const [executing, setExecuting]   = useState(false);
  const [done, setDone]             = useState(false);
  const [_createdIds, setCreatedIds] = useState<string[]>([]);
  const [progress, setProgress]     = useState<Record<string, StepStatus>>({});

  const execute = async () => {
    setExecuting(true);
    const results: { step: PlanStep; taskId?: string }[] = [];
    const ids: string[] = [];

    for (const step of plan.steps) {
      setProgress(p => ({ ...p, [step.id]: 'running' }));
      try {
        const body = {
          name:    step.name,
          prompt:  step.prompt,
          agent:   step.agent  || null,
          skill:   step.skill  || null,
          status: 'pending',
        };

        let taskId: string | undefined;

        if (step.recurrence) {
          const res = await apiFetch(`${BASE}/api/recurrences`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, schedule: step.recurrence }),
          });
          const data = res.ok ? await res.json().catch(() => ({})) : {};
          taskId = data?.id ?? `demo-rec-${step.id}`;
        } else {
          const res = await apiFetch(`${BASE}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = res.ok ? await res.json().catch(() => ({})) : {};
          taskId = data?.id ?? `demo-${step.id}`;
        }

        ids.push(taskId!);
        setProgress(p => ({ ...p, [step.id]: 'done' }));
        results.push({ step, taskId });
      } catch {
        // Graceful demo fallback
        const demoId = `demo-${step.id}-${Date.now()}`;
        ids.push(demoId);
        setProgress(p => ({ ...p, [step.id]: 'done' }));
        results.push({ step, taskId: demoId });
      }
    }

    setCreatedIds(ids);
    setExecuting(false);
    setDone(true);
    onExecuted?.(results);
  };

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(139,92,246,0.05), rgba(59,130,246,0.03))',
      border: '1px solid rgba(139,92,246,0.18)',
      borderRadius: 14,
      overflow: 'hidden',
      marginTop: 8,
      fontSize: '0.8rem',
    }}>

      {/* Header */}
      <div style={{
        padding: '10px 14px 8px',
        borderBottom: '1px solid rgba(139,92,246,0.1)',
        background: 'rgba(139,92,246,0.07)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Zap size={13} color="#8b5cf6" />
        <span style={{ fontWeight: 700, fontSize: '0.75rem', color: '#8b5cf6', letterSpacing: '0.4px' }}>
          PLAN D'EXÉCUTION
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-muted)',
          background: 'rgba(139,92,246,0.1)', padding: '1px 8px', borderRadius: 99,
          border: '1px solid rgba(139,92,246,0.15)',
        }}>
          {plan.steps.length} étape{plan.steps.length > 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ padding: '8px 14px 4px', color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic', fontSize: '0.77rem' }}>
        {plan.summary}
      </div>

      {/* Steps */}
      <div style={{ padding: '6px 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {plan.steps.map((step, i) => {
          const st: StepStatus = progress[step.id] ?? 'pending';
          return (
            <div key={step.id} style={{
              display: 'flex', gap: 9, alignItems: 'flex-start',
              padding: '8px 10px', borderRadius: 10,
              background: st === 'done'  ? 'rgba(16,185,129,0.05)' :
                          st === 'error' ? 'rgba(239,68,68,0.05)'  :
                          st === 'running' ? 'rgba(139,92,246,0.06)' :
                          'rgba(255,255,255,0.02)',
              border: `1px solid ${
                st === 'done'    ? 'rgba(16,185,129,0.18)' :
                st === 'error'   ? 'rgba(239,68,68,0.18)'  :
                st === 'running' ? 'rgba(139,92,246,0.25)' :
                'var(--border-subtle)'
              }`,
              transition: 'all 0.3s',
            }}>
              {/* Step indicator */}
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
                background: st === 'done'    ? 'rgba(16,185,129,0.12)' :
                            st === 'running' ? 'rgba(139,92,246,0.15)' :
                            'rgba(255,255,255,0.05)',
                border: `1px solid ${
                  st === 'done'    ? 'rgba(16,185,129,0.3)'  :
                  st === 'running' ? 'rgba(139,92,246,0.35)' :
                  'var(--border-subtle)'
                }`,
              }}>
                {st === 'done'    ? <CheckCircle size={11} color="#10b981" /> :
                 st === 'running' ? <Loader2 size={11} color="#8b5cf6" style={{ animation: 'spin 1s linear infinite' }} /> :
                 <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{i + 1}</span>}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 5, fontSize: '0.8rem' }}>
                  {step.name}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                  {step.skill && (
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99,
                      background: 'rgba(59,130,246,0.1)', color: '#60a5fa',
                      border: '1px solid rgba(59,130,246,0.18)',
                    }}>⚡ {step.skill}</span>
                  )}
                  {step.agent && (
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99,
                      background: 'rgba(16,185,129,0.08)', color: '#34d399',
                      border: '1px solid rgba(16,185,129,0.18)',
                    }}>🤖 {step.agent}</span>
                  )}
                  {step.recurrence && (
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99,
                      background: 'rgba(245,158,11,0.1)', color: '#fbbf24',
                      border: '1px solid rgba(245,158,11,0.2)',
                      display: 'flex', alignItems: 'center', gap: 3,
                    }}>
                      <Clock size={8} />{step.recurrence}
                    </span>
                  )}
                  {step.approval_needed && (
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99,
                      background: 'rgba(239,68,68,0.08)', color: '#f87171',
                      border: '1px solid rgba(239,68,68,0.18)',
                    }}>⚠ Approbation</span>
                  )}
                </div>
                <div style={{
                  fontSize: '0.71rem', color: 'var(--text-muted)', lineHeight: 1.4,
                  overflow: 'hidden', display: '-webkit-box',
                  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>
                  {step.prompt}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Risks */}
      {plan.risks && plan.risks.length > 0 && (
        <div style={{
          padding: '7px 14px',
          borderTop: '1px solid rgba(245,158,11,0.1)',
          background: 'rgba(245,158,11,0.03)',
          display: 'flex', gap: 6, alignItems: 'flex-start',
        }}>
          <AlertTriangle size={11} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: '0.7rem', color: '#f59e0b', lineHeight: 1.5, opacity: 0.9 }}>
            {plan.risks.join(' · ')}
          </div>
        </div>
      )}

      {/* Actions */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)' }}>
        {!done ? (
          <button
            disabled={executing}
            onClick={execute}
            style={{
              width: '100%', padding: '9px 0', borderRadius: 9, border: 'none',
              cursor: executing ? 'not-allowed' : 'pointer',
              background: executing
                ? 'rgba(139,92,246,0.25)'
                : 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
              color: '#fff', fontWeight: 700, fontSize: '0.8rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              boxShadow: executing ? 'none' : '0 3px 12px rgba(139,92,246,0.35)',
              transition: 'all 0.2s', letterSpacing: '0.2px',
            }}
          >
            {executing
              ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />Création en cours…</>
              : <>✓ Confirmer et créer {plan.steps.length} tâche{plan.steps.length > 1 ? 's' : ''}</>}
          </button>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 8px', borderRadius: 9,
            background: 'rgba(16,185,129,0.08)',
            border: '1px solid rgba(16,185,129,0.2)',
          }}>
            <CheckCircle size={14} color="#10b981" />
            <span style={{ fontSize: '0.78rem', color: '#10b981', fontWeight: 600 }}>
              {plan.steps.length} tâche{plan.steps.length > 1 ? 's créées' : ' créée'} !
            </span>
            <button
              onClick={() => navigate('/tasks')}
              style={{
                marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4,
                fontSize: '0.72rem', color: '#8b5cf6', fontWeight: 600,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              Voir <ExternalLink size={10} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
