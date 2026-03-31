// React is used implicitly via JSX transform
import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  Handle,
  Position,
} from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, Server, Play, Square, Activity, Bot, RefreshCw, Loader2, FileText, PlusCircle, Cpu, Shield, X, Terminal } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { TaskChatDrawer, useTaskChat } from './TaskChatDrawer';
import type { TaskChatContext } from './TaskChatDrawer';

const BASE = 'http://localhost:4000';

// ─── Context pour openChat (évite de passer la fn dans node data ReactFlow) ───
const AgentChatCtx = createContext<((ctx: TaskChatContext) => void) | null>(null);

// ─── Types ────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  label: string;
  role: string;
  model: string;
  provider?: string;
  gpu?: boolean;
  policies?: string;
  status: 'active' | 'offline';
  parentId: string | null;
  position: { x: number; y: number };
}

interface NemoSandbox {
  name: string;
  default: boolean;
  model: string;
  provider: string;
  gpu: boolean;
  policies: string;
  status: string;
}

interface AgentNodeData {
  label: string;
  role: string;
  model: string;
  provider?: string;
  gpu?: boolean;
  policies?: string;
  status: string;
  agentId: string;
  onToggle: (id: string, currentStatus: string) => void;
  onLogs: (id: string) => void;
  toggling: boolean;
  isNemoClaw: boolean;
  [key: string]: unknown;
}

// ─── AgentNode ────────────────────────────────────────────────────────────────

const AgentNode = ({ data }: { data: AgentNodeData }) => {
  const isRunning = data.status === 'active';
  const openChat = useContext(AgentChatCtx);

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: `1px solid ${isRunning ? 'var(--status-success)' : 'var(--border-subtle)'}`,
      borderRadius: '12px',
      padding: '16px',
      minWidth: '220px',
      boxShadow: 'var(--shadow-md)',
      position: 'relative',
      transition: 'border-color 0.3s',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--border-subtle)' }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '12px', gap: '8px' }}>
        <div style={{
          background: isRunning ? 'rgba(16, 185, 129, 0.1)' : 'rgba(161, 161, 170, 0.1)',
          padding: '8px', borderRadius: '8px',
          color: isRunning ? 'var(--status-success)' : 'var(--text-muted)',
          flexShrink: 0,
        }}>
          <Bot size={20} />
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{data.label}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{data.role}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Modèle :</span>
          <span style={{ fontWeight: 500, color: 'var(--text-secondary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.model}</span>
        </div>
        {data.provider && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Provider :</span>
            <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{data.provider}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Statut :</span>
          <span style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            color: isRunning ? 'var(--status-success)' : 'var(--text-muted)', fontWeight: 600,
          }}>
            {isRunning ? <Activity size={12} /> : <Square size={12} />}
            {isRunning ? 'Actif' : 'Hors ligne'}
          </span>
        </div>
        {data.isNemoClaw && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
            {data.gpu && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.1)', color: 'var(--brand-accent)', fontWeight: 700 }}><Cpu size={9} style={{ display: 'inline', marginRight: 2 }} />GPU</span>}
            <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 4, background: 'rgba(16,185,129,0.1)', color: '#10b981', fontWeight: 700 }}><Shield size={9} style={{ display: 'inline', marginRight: 2 }} />Sandbox</span>
            {data.policies && data.policies !== 'none' && <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.1)', color: '#3b82f6', fontWeight: 700 }}>{data.policies}</span>}
          </div>
        )}
      </div>

      <div style={{ paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
        {openChat && (
          <button
            onClick={() => openChat({ taskId: data.agentId, taskName: data.label, agent: data.label, llmModel: data.model, status: data.status, module: 'agent' })}
            title="Chat avec cet agent"
            style={{
              padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border-subtle)',
              background: 'var(--bg-glass)', color: 'var(--brand-accent)', fontSize: '0.8rem',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            💬
          </button>
        )}
        <button
          onClick={() => data.onLogs(data.agentId)}
          style={{
            flex: 1, padding: '6px 0', borderRadius: '6px', border: '1px solid var(--border-subtle)',
            background: 'var(--bg-glass)', color: 'var(--text-primary)', fontSize: '0.8rem',
            cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px',
          }}
        >
          <Terminal size={12} /> Logs
        </button>
        <button
          disabled={data.toggling}
          onClick={() => data.onToggle(data.agentId, data.status)}
          style={{
            flex: 1, padding: '6px 0', borderRadius: '6px', border: 'none',
            background: isRunning ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
            color: isRunning ? '#ef4444' : '#10b981', fontSize: '0.8rem',
            cursor: data.toggling ? 'not-allowed' : 'pointer',
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px',
            opacity: data.toggling ? 0.6 : 1,
          }}
        >
          {data.toggling
            ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            : isRunning ? <><Square size={12} /> Stop</> : <><Play size={12} /> Start</>
          }
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--border-subtle)' }} />
    </div>
  );
};

const nodeTypes = { agentNode: AgentNode };


// ─── Mock fallback (endpoint absent) ─────────────────────────────────────────

const MOCK_AGENTS: Agent[] = [
  { id: 'main', label: 'NemoClaw Router',  role: 'Main Orchestrator',   model: 'claude-sonnet-4-6', status: 'active',  parentId: null,   position: { x: 300, y: 50  } },
  { id: 'sub1', label: 'Code Architect',   role: 'Software Engineer',   model: 'llama-3.2',         status: 'active',  parentId: 'main', position: { x: 50,  y: 300 } },
  { id: 'sub2', label: 'Data Analyst',     role: 'Data processing',     model: 'claude-haiku-4-5',  status: 'offline', parentId: 'main', position: { x: 300, y: 300 } },
  { id: 'sub3', label: 'Security Scanner', role: 'Vulnerability check', model: 'qwen-2.5',          status: 'active',  parentId: 'main', position: { x: 550, y: 300 } },
];

function agentsToFlow(agents: Agent[], onToggle: AgentNodeData['onToggle'], onLogs: AgentNodeData['onLogs'], toggling: Set<string>, isNemoClaw: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = agents.map(a => ({
    id: a.id,
    type: 'agentNode',
    position: a.position,
    data: {
      label: a.label, role: a.role, model: a.model, status: a.status,
      provider: a.provider, gpu: a.gpu, policies: a.policies,
      agentId: a.id, onToggle, onLogs, toggling: toggling.has(a.id), isNemoClaw,
    },
  }));
  const edges: Edge[] = agents
    .filter(a => a.parentId)
    .map(a => ({
      id: `e-${a.parentId}-${a.id}`,
      source: a.parentId as string,
      target: a.id,
      animated: a.status === 'active',
      style: { stroke: a.status === 'active' ? 'var(--brand-primary)' : 'var(--border-subtle)' },
    }));
  return { nodes, edges };
}

// ─── Log drawer for NemoClaw sandbox logs ─────────────────────────────────────

const LogDrawer = ({ name, onClose }: { name: string; onClose: () => void }) => {
  const [lines, setLines] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`${BASE}/api/nemoclaw/${encodeURIComponent(name)}/logs`);
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.done) { es.close(); return; }
        if (d.line) setLines(prev => [...prev.slice(-300), d.line]);
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [name]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', pointerEvents: 'none' }}>
      <div style={{ width: 560, height: '80vh', background: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)', borderRadius: '16px 0 0 0', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', pointerEvents: 'all' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={16} color="var(--brand-accent)" /> Logs — {name}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}><X size={16} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', fontFamily: 'var(--mono)', fontSize: '12px', color: '#10b981', background: 'rgba(0,0,0,0.3)' }}>
          {lines.length === 0
            ? <span style={{ color: 'var(--text-muted)' }}>En attente de logs…</span>
            : lines.map((l, i) => <div key={i}>{l}</div>)
          }
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
};

// ─── Sandbox templates ────────────────────────────────────────────────────────

const SANDBOX_TEMPLATES = [
  { id: 'generaliste',  label: 'Généraliste',   icon: '🤖', model: 'nvidia/nemotron-3-super-120b-a12b',        provider: 'nvidia', policies: 'pypi, npm',              desc: 'Assistant polyvalent — Nemotron 120B' },
  { id: 'code-agent',   label: 'Code Agent',    icon: '💻', model: 'meta/llama-3.1-405b-instruct',             provider: 'nvidia', policies: 'pypi, npm, docker',       desc: 'Spécialisé développement — Llama 405B' },
  { id: 'data-agent',   label: 'Data Agent',    icon: '📊', model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',  provider: 'nvidia', policies: 'pypi, filesystem',        desc: 'Analyse de données — Nemotron Ultra 253B' },
  { id: 'security-agent', label: 'Security',    icon: '🛡️', model: 'deepseek-ai/deepseek-v3.2',               provider: 'nvidia', policies: 'none',                    desc: 'Audit sécurité — DeepSeek V3 (isolé)' },
  { id: 'writer',       label: 'Writer',        icon: '✍️', model: 'claude-sonnet-4-6',                        provider: 'anthropic', policies: 'npm',                  desc: 'Rédaction créative — Claude Sonnet' },
];

// ─── NewSandboxModal ──────────────────────────────────────────────────────────

const NewSandboxModal = ({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (name: string, model: string, provider: string) => Promise<void>;
}) => {
  const [selectedTemplate, setSelectedTemplate] = useState(SANDBOX_TEMPLATES[0]);
  const [customName, setCustomName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveName = customName.trim() || selectedTemplate.id;

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      await onCreate(effectiveName, selectedTemplate.model, selectedTemplate.provider);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erreur création sandbox');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 18, padding: 32, width: '100%', maxWidth: 520, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ background: 'rgba(118,185,0,0.15)', borderRadius: 10, padding: 9, color: '#76b900' }}>
              <PlusCircle size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>Nouveau Sandbox Spécialisé</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>Choisissez un template et un nom</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 6, borderRadius: 8 }}><X size={18} /></button>
        </div>

        {/* Templates */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Template</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SANDBOX_TEMPLATES.map(t => (
              <button key={t.id} onClick={() => setSelectedTemplate(t)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: selectedTemplate.id === t.id ? 'rgba(118,185,0,0.08)' : 'var(--bg-glass)',
                border: `1px solid ${selectedTemplate.id === t.id ? 'rgba(118,185,0,0.35)' : 'var(--border-subtle)'}`,
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: '1.4rem', width: 28, textAlign: 'center', flexShrink: 0 }}>{t.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '13px', color: selectedTemplate.id === t.id ? '#76b900' : 'var(--text-primary)' }}>{t.label}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 1 }}>{t.desc}</div>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: 'var(--mono)', background: 'var(--bg-glass)', padding: '2px 6px', borderRadius: 4 }}>{t.policies}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Nom du sandbox (optionnel)</div>
          <input
            value={customName}
            onChange={e => setCustomName(e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase())}
            placeholder={selectedTemplate.id}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none', fontFamily: 'var(--mono)', boxSizing: 'border-box' }}
          />
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Nom final : <strong style={{ fontFamily: 'var(--mono)', color: '#76b900' }}>{effectiveName}</strong></div>
        </div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 12 }}>{error}</div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Annuler</button>
          <button onClick={handleCreate} disabled={creating} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 22px', borderRadius: 8, border: 'none', background: creating ? 'rgba(118,185,0,0.4)' : 'rgba(118,185,0,0.85)', color: '#fff', cursor: creating ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}>
            {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <PlusCircle size={14} />}
            {creating ? 'Création…' : `Créer ${selectedTemplate.icon}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── AgentsHierarchyModule ────────────────────────────────────────────────────

export const AgentsHierarchyModule = () => {
  const [agents, setAgents]         = useState<Agent[]>([]);
  const [loading, setLoading]       = useState(true);
  const [demo, setDemo]             = useState(false);
  const [nemoclawOk, setNemoclawOk] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [logsFor, setLogsFor]       = useState<string | null>(null);
  const [toggling, setToggling]     = useState<Set<string>>(new Set());
  const [showNewModal,  setShowNewModal]  = useState(false);
  const { chatCtx, openChat, closeChat } = useTaskChat();

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      // Try NemoClaw sandboxes first
      const ncRes = await apiFetch(`${BASE}/api/nemoclaw/sandboxes`);
      if (ncRes.ok) {
        const sandboxes: NemoSandbox[] = await ncRes.json();
        if (sandboxes.length > 0) {
          const cols = Math.max(1, Math.ceil(Math.sqrt(sandboxes.length)));
          const converted: Agent[] = sandboxes.map((s, i) => ({
            id: s.name, label: s.name,
            role: s.default ? 'Default Sandbox' : 'NemoClaw Sandbox',
            model: s.model || 'nemotron', provider: s.provider,
            gpu: s.gpu, policies: s.policies,
            status: s.status === 'active' ? 'active' : 'offline',
            parentId: null,
            position: { x: (i % cols) * 280 + 50, y: Math.floor(i / cols) * 220 + 50 },
          }));
          setAgents(converted);
          setNemoclawOk(true);
          setDemo(false);
          setLoading(false);
          return;
        }
      }
    } catch { /* fall through */ }
    // Fallback to /api/agents (mock or existing)
    try {
      const res = await apiFetch(`${BASE}/api/agents`);
      if (!res.ok) throw new Error('not ok');
      const data: Agent[] = await res.json();
      setAgents(data);
      setNemoclawOk(false);
      setDemo(false);
    } catch {
      setAgents(MOCK_AGENTS);
      setNemoclawOk(false);
      setDemo(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleToggle = useCallback(async (id: string, currentStatus: string) => {
    if (nemoclawOk) {
      // NemoClaw: destroy or reconnect
      if (currentStatus === 'active') {
        if (!confirm(`Détruire le sandbox "${id}" ? Cette action est irréversible.`)) return;
        setToggling(prev => new Set([...prev, id]));
        try {
          await apiFetch(`${BASE}/api/nemoclaw/${id}/destroy`, { method: 'POST' });
          await fetchAgents();
        } catch { /* ignore */ } finally {
          setToggling(prev => { const s = new Set(prev); s.delete(id); return s; });
        }
      }
      return;
    }
    setToggling(prev => new Set([...prev, id]));
    const action = currentStatus === 'active' ? 'stop' : 'run';
    try {
      const res = await apiFetch(`${BASE}/api/agents/${id}/${action}`, { method: 'POST' });
      if (res.ok) {
        const updated: Agent = await res.json();
        setAgents(prev => prev.map(a => a.id === id ? updated : a));
      }
    } catch {
      setAgents(prev => prev.map(a => a.id === id
        ? { ...a, status: currentStatus === 'active' ? 'offline' : 'active' }
        : a
      ));
    } finally {
      setToggling(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [nemoclawOk, fetchAgents]);

  const handleOnboard = useCallback(async () => {
    setOnboarding(true);
    try {
      const res = await apiFetch(`${BASE}/api/nemoclaw/onboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'main', provider: 'nvidia' }) });
      const d = await res.json();
      if (d.ok) { alert('Onboarding lancé ! Rechargez dans quelques secondes.'); fetchAgents(); }
      else alert(`Erreur : ${d.error || 'Onboarding échoué'}`);
    } catch (e: unknown) {
      alert(`Erreur onboarding : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOnboarding(false);
    }
  }, [fetchAgents]);

  const handleCreateSandbox = useCallback(async (name: string, model: string, provider: string) => {
    const res = await apiFetch(`${BASE}/api/nemoclaw/onboard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, model }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Onboarding échoué');
    await fetchAgents();
  }, [fetchAgents]);

  const activeCount  = agents.filter(a => a.status === 'active').length;
  const offlineCount = agents.filter(a => a.status === 'offline').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', paddingBottom: '20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'var(--brand-primary)', padding: '12px', borderRadius: '14px', color: '#fff' }}>
            <Network size={28} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Agents NemoClaw</h2>
            <div className="text-muted" style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: 12 }}>
              Sandboxes sécurisés NemoClaw (NVIDIA OpenShell)
              {nemoclawOk && <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', color: '#10b981', fontSize: '0.72rem', fontWeight: 700 }}>● NemoClaw connecté</span>}
              {!nemoclawOk && demo && <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: '0.72rem', fontWeight: 700 }}>Démo</span>}
              {!nemoclawOk && !demo && <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(161,161,170,0.1)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700 }}>NemoClaw non installé</span>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Stats */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ padding: '6px 14px', borderRadius: 8, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', color: '#10b981', fontSize: '0.82rem', fontWeight: 600 }}>
              {activeCount} actif{activeCount > 1 ? 's' : ''}
            </div>
            <div style={{ padding: '6px 14px', borderRadius: 8, background: 'rgba(161,161,170,0.1)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '0.82rem', fontWeight: 600 }}>
              {offlineCount} hors ligne
            </div>
          </div>
          {nemoclawOk && (
            <button
              onClick={() => setShowNewModal(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
                borderRadius: '8px', border: 'none',
                background: 'rgba(118,185,0,0.85)', color: '#fff',
                cursor: 'pointer', fontWeight: 600,
              }}
            >
              <PlusCircle size={16} />
              Nouveau Sandbox
            </button>
          )}
          <button
            onClick={fetchAgents}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
              borderRadius: '8px', border: '1px solid var(--border-subtle)',
              background: 'var(--bg-glass)', color: 'var(--text-primary)',
              cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 500, opacity: loading ? 0.6 : 1,
            }}
          >
            {loading
              ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              : <RefreshCw size={16} />}
            Actualiser
          </button>
          {!nemoclawOk && (
            <button style={{
              display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
              borderRadius: '8px', border: '1px solid var(--border-subtle)',
              background: 'var(--bg-glass)', color: 'var(--text-primary)',
              cursor: 'pointer', fontWeight: 500,
            }}>
              <Server size={16} /> Gérer les nœuds
            </button>
          )}
        </div>
      </div>

      {/* NemoClaw info banner when not connected */}
      {!nemoclawOk && !demo && (
        <div style={{ padding: '14px 20px', borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Server size={16} color="#3b82f6" style={{ flexShrink: 0 }} />
          <span>
            <strong>NemoClaw non détecté.</strong> Installez-le dans WSL Ubuntu avec :<br />
            <code style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4 }}>
              curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
            </code>
            &nbsp;puis <code style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: 4 }}>nemoclaw onboard</code>
          </span>
        </div>
      )}

      {/* Graph */}
      <div className="glass-panel" style={{ flexGrow: 1, borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--border-subtle)', minHeight: '560px' }}>
        {loading ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 10 }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> Chargement des agents…
          </div>
        ) : (() => {
          const { nodes: dn, edges: de } = agentsToFlow(agents, handleToggle, setLogsFor, toggling, nemoclawOk);
          const flowKey = agents.map(a => `${a.id}:${a.status}`).join('|');
          return (
            <AgentChatCtx.Provider value={openChat}>
              <ReactFlow
                key={flowKey}
                defaultNodes={dn}
                defaultEdges={de}
                nodeTypes={nodeTypes}
                fitView
                colorMode="dark"
                attributionPosition="bottom-right"
              >
                <Controls style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }} />
                <MiniMap style={{ background: 'var(--bg-surface)' }} maskColor="rgba(0,0,0,0.5)" nodeColor="var(--brand-primary)" />
                <Background gap={16} size={1} color="var(--border-subtle)" />
              </ReactFlow>
            </AgentChatCtx.Provider>
          );
        })()}
      </div>

      <TaskChatDrawer ctx={chatCtx} onClose={closeChat} />
      {logsFor && <LogDrawer name={logsFor} onClose={() => setLogsFor(null)} />}
      {showNewModal && (
        <NewSandboxModal
          onClose={() => setShowNewModal(false)}
          onCreate={handleCreateSandbox}
        />
      )}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};
