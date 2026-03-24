// React is used implicitly via JSX transform
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
import { Network, Server, Play, Square, Activity, Bot } from 'lucide-react';

interface AgentNodeData {
  label: string;
  role: string;
  model: string;
  status: string;
  [key: string]: unknown;
}

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
      position: 'relative'
    }}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--border-subtle)' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            background: isRunning ? 'rgba(16, 185, 129, 0.1)' : 'rgba(161, 161, 170, 0.1)',
            padding: '8px',
            borderRadius: '8px',
            color: isRunning ? 'var(--status-success)' : 'var(--text-muted)'
          }}>
            <Bot size={20} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{data.label}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{data.role}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Model:</span>
          <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{data.model}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Status:</span>
          <span style={{
            display: 'flex', alignItems: 'center', gap: '4px',
            color: isRunning ? 'var(--status-success)' : 'var(--text-muted)',
            fontWeight: 600
          }}>
            {isRunning ? <Activity size={12} /> : <Square size={12} />}
            {isRunning ? 'Active' : 'Offline'}
          </span>
        </div>
      </div>

      <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
        <button style={{
          flex: 1, padding: '6px 0', borderRadius: '6px', border: '1px solid var(--border-subtle)',
          background: 'var(--bg-glass)', color: 'var(--text-primary)', fontSize: '0.8rem',
          cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px'
        }}>
           Logs
        </button>
        <button style={{
          flex: 1, padding: '6px 0', borderRadius: '6px', border: 'none',
          background: isRunning ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)',
          color: isRunning ? '#ef4444' : '#10b981', fontSize: '0.8rem',
          cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px'
        }}>
          {isRunning ? <Square size={12} /> : <Play size={12} />}
          {isRunning ? 'Stop' : 'Start'}
        </button>
      </div>

      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--border-subtle)' }} />
    </div>
  );
};

const nodeTypes = {
  agentNode: AgentNode,
};

const initialNodes: Node[] = [
  {
    id: 'main',
    type: 'agentNode',
    position: { x: 300, y: 50 },
    data: { label: 'NemoClaw Router', role: 'Main Orchestrator', model: 'Claude 3.5 Sonnet', status: 'active' }
  },
  {
    id: 'sub1',
    type: 'agentNode',
    position: { x: 50, y: 300 },
    data: { label: 'Code Architect', role: 'Software Engineer', model: 'Llama 3.2', status: 'active' }
  },
  {
    id: 'sub2',
    type: 'agentNode',
    position: { x: 300, y: 300 },
    data: { label: 'Data Analyst', role: 'Data processing', model: 'Claude 3 Haiku', status: 'offline' }
  },
  {
    id: 'sub3',
    type: 'agentNode',
    position: { x: 550, y: 300 },
    data: { label: 'Security Scanner', role: 'Vulnerability check', model: 'Qwen 2.5', status: 'active' }
  },
];

const initialEdges: Edge[] = [
  { id: 'e-main-sub1', source: 'main', target: 'sub1', animated: true, style: { stroke: 'var(--brand-primary)' } },
  { id: 'e-main-sub2', source: 'main', target: 'sub2', animated: false, style: { stroke: 'var(--border-subtle)' } },
  { id: 'e-main-sub3', source: 'main', target: 'sub3', animated: true, style: { stroke: 'var(--brand-primary)' } },
];

export const AgentsHierarchyModule = () => {
  const [nodes, _setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, _setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', paddingBottom: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'var(--brand-primary)', padding: '12px', borderRadius: '14px', color: 'var(--text-primary)' }}>
            <Network size={28} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Hiérarchie des Agents</h2>
            <div className="text-muted" style={{ marginTop: '4px' }}>Visualisez et gérez votre flotte d'agents IA en temps réel.</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
           <button style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
            borderRadius: '8px', border: '1px solid var(--border-subtle)',
            background: 'var(--bg-glass)', color: 'var(--text-primary)',
            cursor: 'pointer', fontWeight: 500,
          }}>
             <Server size={18} /> Gérer les nœuds
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ flexGrow: 1, borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--border-subtle)', minHeight: '600px' }}>
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
      </div>
    </div>
  );
};
