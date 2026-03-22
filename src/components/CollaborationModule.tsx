import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge
} from '@xyflow/react';
import type { Connection, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, Save, Plus, Check } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';

const nodeStyle = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  borderRadius: '8px',
  padding: '10px',
};

const defaultNodes: Node[] = [
  { id: '1', position: { x: 50,  y: 150 }, data: { label: 'Ext: Telegram Input' },        type: 'input', style: { ...nodeStyle, borderColor: 'var(--brand-primary)' } },
  { id: '2', position: { x: 300, y: 150 }, data: { label: 'NemoClaw Router' },              style: { ...nodeStyle, borderColor: 'var(--brand-accent)', background: 'rgba(139,92,246,0.1)' } },
  { id: '3', position: { x: 600, y: 50  }, data: { label: 'TinyClaw (Local Analysis)' },   style: { ...nodeStyle, borderColor: 'var(--status-success)' } },
  { id: '4', position: { x: 600, y: 250 }, data: { label: 'Webhook: n8n Workflow' },        style: { ...nodeStyle, borderColor: '#f97316' } },
];

const defaultEdges: Edge[] = [
  { id: 'e1-2', source: '1', target: '2', animated: true, style: { stroke: 'var(--brand-primary)' } },
  { id: 'e2-3', source: '2', target: '3', label: 'If Local Task',   style: { stroke: 'var(--status-success)' } },
  { id: 'e2-4', source: '2', target: '4', label: 'If Automation',   style: { stroke: '#f97316' } },
];

export const CollaborationModule = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState(defaultNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultEdges);
  const [saving, setSaving]              = useState(false);
  const [saved, setSaved]                = useState(false);

  // Load pipeline from server on mount
  useEffect(() => {
    apiFetch(`${BASE}/api/pipeline`).then(r => r.json()).then(data => {
      if (data?.nodes?.length) setNodes(data.nodes);
      if (data?.edges?.length) setEdges(data.edges);
    }).catch(() => {});
  }, []);

  const onConnect = useCallback(
    (params: Edge | Connection) => setEdges(eds => addEdge(params, eds)),
    [setEdges]
  );

  const handleAddNode = () => {
    const id = `node-${Date.now()}`;
    const newNode: Node = {
      id,
      position: { x: Math.random() * 400 + 100, y: Math.random() * 200 + 100 },
      data: { label: 'Nouveau Nœud' },
      style: { ...nodeStyle },
    };
    setNodes(nds => [...nds, newNode]);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`${BASE}/api/pipeline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes, edges }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (_) {}
    setSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', paddingBottom: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'var(--brand-primary)', padding: '12px', borderRadius: '14px', color: 'var(--text-primary)' }}>
            <Network size={28} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Collaborations & Pipelines</h2>
            <div className="text-muted" style={{ marginTop: '4px' }}>Orchestrez vos agents NemoClaw et webhooks externes visuellement.</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={handleAddNode} style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
            borderRadius: '8px', border: '1px solid var(--border-subtle)',
            background: 'var(--bg-glass)', color: 'var(--text-primary)',
            cursor: 'pointer', fontWeight: 500,
          }}>
            <Plus size={18} /> Ajouter Nœud
          </button>
          <button onClick={handleSave} disabled={saving} style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 24px',
            borderRadius: '8px', border: 'none',
            background: saved ? 'rgba(16,185,129,0.15)' : 'var(--brand-primary)',
            color: saved ? '#10b981' : '#fff',
            cursor: 'pointer', fontWeight: 600,
            transition: 'all 0.2s',
          }}>
            {saved ? <Check size={18} /> : <Save size={18} />}
            {saved ? 'Sauvegardé !' : saving ? 'Sauvegarde…' : 'Sauvegarder'}
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ flexGrow: 1, borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--border-subtle)', minHeight: '600px' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          colorMode="dark"
        >
          <Controls style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }} />
          <MiniMap style={{ background: 'var(--bg-surface)' }} maskColor="rgba(0,0,0,0.5)" nodeColor="var(--brand-primary)" />
          <Background gap={12} size={1} color="var(--border-subtle)" />
        </ReactFlow>
      </div>
    </div>
  );
};
