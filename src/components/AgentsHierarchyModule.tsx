// React is used implicitly via JSX transform
import { useState, useEffect, useCallback } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
} from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, Server, Play, Square, Activity, Bot, RefreshCw, Loader2, FileText } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  label: string;
  role: string;
  model: string;
  status: 'active' | 'offline';
  parentId: string | null;
  position: { x: number; y: number };
}

interface AgentNodeData {
  label: string;
  role: string;
  model: string;
  status: string;
  agentId: string;
  onToggle: (id: string, currentStatus: string) => void;
  toggling: boolean;
  [key: string]: unknown;
}

// ─── AgentNode ────────────────────────────────────────────────────────────────

const AgentNode = ({ data }: { data: AgentNodeData }) => {
  const isRunning = data.status === 'active';

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
          <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{data.model}</span>
        </div>
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
      </div>

      <div style={{ paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
        <button
          onClick={() => window.open(`/tasks?agent=${data.agentId}`, '_self')}
          style={{
            flex: 1, padding: '6px 0', borderRadius: '6px', border: '1px solid var(--border-subtle)',
            background: 'var(--bg-glass)', color: 'var(--text-primary)', fontSize: '0.8rem',
            cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px',
          }}
        >
          <FileText size={12} /> Logs
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

function agentsToFlow(agents: Agent[], onToggle: AgentNodeData['onToggle'], toggling: Set<string>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = agents.map(a => ({
    id: a.id,
    type: 'agentNode',
    position: a.position,
    data: {
      label: a.label, role: a.role, model: a.model, status: a.status,
      agentId: a.id, onToggle, toggling: toggling.has(a.id),
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

// ─── AgentsHierarchyModule ────────────────────────────────────────────────────

export const AgentsHierarchyModule = () => {
  const [agents, setAgents]           = useState<Agent[]>([]);
  const [loading, setLoading]         = useState(true);
  const [demo, setDemo]               = useState(false);
  const [toggling, setToggling]       = useState<Set<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${BASE}/api/agents`);
      if (!res.ok) throw new Error('not ok');
      const data: Agent[] = await res.json();
      setAgents(data);
      setDemo(false);
    } catch {
      setAgents(MOCK_AGENTS);
      setDemo(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleToggle = useCallback(async (id: string, currentStatus: string) => {
    setToggling(prev => new Set([...prev, id]));
    const action = currentStatus === 'active' ? 'stop' : 'run';
    try {
      const res = await apiFetch(`${BASE}/api/agents/${id}/${action}`, { method: 'POST' });
      if (res.ok) {
        const updated: Agent = await res.json();
        setAgents(prev => prev.map(a => a.id === id ? updated : a));
      }
    } catch {
      // Optimistic update for demo mode
      setAgents(prev => prev.map(a => a.id === id
        ? { ...a, status: currentStatus === 'active' ? 'offline' : 'active' }
        : a
      ));
    } finally {
      setToggling(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, []);

  // Rebuild ReactFlow nodes/edges whenever agents or toggling changes
  useEffect(() => {
    const { nodes: n, edges: e } = agentsToFlow(agents, handleToggle, toggling);
    setNodes(n);
    setEdges(e);
  }, [agents, toggling, handleToggle, setNodes, setEdges]);

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
            <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Hiérarchie des Agents</h2>
            <div className="text-muted" style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: 12 }}>
              Visualisez et gérez votre flotte d'agents IA en temps réel.
              {demo && <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: '0.72rem', fontWeight: 700 }}>Démo</span>}
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
          <button style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
            borderRadius: '8px', border: '1px solid var(--border-subtle)',
            background: 'var(--bg-glass)', color: 'var(--text-primary)',
            cursor: 'pointer', fontWeight: 500,
          }}>
            <Server size={16} /> Gérer les nœuds
          </button>
        </div>
      </div>

      {/* Graph */}
      <div className="glass-panel" style={{ flexGrow: 1, borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--border-subtle)', minHeight: '560px' }}>
        {loading ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', gap: 10 }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> Chargement des agents…
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            colorMode="dark"
            attributionPosition="bottom-right"
          >
            <Controls style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }} />
            <MiniMap style={{ background: 'var(--bg-surface)' }} maskColor="rgba(0,0,0,0.5)" nodeColor="var(--brand-primary)" />
            <Background gap={16} size={1} color="var(--border-subtle)" />
          </ReactFlow>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};
