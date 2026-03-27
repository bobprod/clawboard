import { useState, useEffect } from 'react';
import { ToyBrick, Search, Trash2, Edit3, Plus, Code, X, Save, RefreshCw, Check, ToggleLeft, ToggleRight } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

const BASE = 'http://localhost:4000';

interface Skill {
  id: string;
  name: string;
  version: string;
  source: string;
  desc: string;
  content: string;
  status: 'active' | 'inactive';
  installedAt: string;
  tags?: string[];
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)', fontSize: '0.875rem', outline: 'none',
  fontFamily: 'inherit', boxSizing: 'border-box',
};

export const SkillsModule = () => {
  const [skills, setSkills]           = useState<Skill[]>([]);
  const [search, setSearch]           = useState('');
  const [selected, setSelected]       = useState<Skill | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showForm, setShowForm]       = useState(false);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [toast, setToast]             = useState<string | null>(null);
  const [form, setForm]               = useState({ name: '', desc: '', version: '1.0.0', source: 'local', content: '' });

  useEffect(() => {
    apiFetch(`${BASE}/api/skills`).then(r => r.json()).then(d => setSkills(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const showMsg = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const handleSelect = (skill: Skill) => {
    setSelected(skill);
    setEditContent(skill.content || `# ${skill.name}\n\n## Description\n${skill.desc}\n\n## Instructions\n\n`);
    setShowForm(false);
  };

  const handleSaveContent = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await apiFetch(`${BASE}/api/skills/${selected.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const updated = await r.json();
      setSkills(prev => prev.map(s => s.id === selected.id ? updated : s));
      setSelected(updated);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch { showMsg('Erreur sauvegarde'); }
    setSaving(false);
  };

  const handleToggle = async (skill: Skill) => {
    const newStatus = skill.status === 'active' ? 'inactive' : 'active';
    const r = await apiFetch(`${BASE}/api/skills/${skill.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    }).then(r => r.json()).catch(() => null);
    if (r) setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, status: newStatus } : s));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce skill ?')) return;
    await apiFetch(`${BASE}/api/skills/${id}`, { method: 'DELETE' }).catch(() => {});
    setSkills(prev => prev.filter(s => s.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const r = await apiFetch(`${BASE}/api/skills`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, status: 'active' }),
      });
      const s = await r.json();
      setSkills(prev => [...prev, s]);
      setForm({ name: '', desc: '', version: '1.0.0', source: 'local', content: '' });
      setShowForm(false);
      showMsg('✓ Skill créé');
    } catch { showMsg('Erreur création'); }
    setSaving(false);
  };

  const filtered = skills.filter(s => !search || [s.name, s.desc, s.source].some(v => v.toLowerCase().includes(search.toLowerCase())));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, height: '100%', paddingBottom: 32 }}>
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 24, zIndex: 9999, background: '#10b981', color: '#fff', padding: '10px 18px', borderRadius: 10, fontWeight: 600, fontSize: '13px', boxShadow: '0 4px 20px rgba(16,185,129,0.4)' }}>{toast}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ background: 'var(--brand-accent)', padding: 12, borderRadius: 14, color: '#fff' }}>
            <ToyBrick size={28} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0, color: 'var(--text-primary)' }}>Skills & Plugins Hub</h2>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: 4 }}>{skills.length} skill{skills.length !== 1 ? 's' : ''} installé{skills.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <button onClick={() => { setShowForm(v => !v); setSelected(null); }} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
          borderRadius: 10, border: 'none', background: showForm ? 'var(--bg-glass)' : 'var(--brand-accent)',
          color: showForm ? 'var(--text-primary)' : '#fff', cursor: 'pointer', fontWeight: 600,
        }}>
          {showForm ? <X size={16} /> : <Plus size={18} />}{showForm ? 'Annuler' : 'Créer un Skill'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) 2fr', gap: 20, flex: 1, minHeight: 0 }}>

        {/* Left: list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher…" style={{ ...inputStyle, paddingLeft: 32 }} />
          </div>

          {/* Skills list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
                {skills.length === 0 ? 'Aucun skill. Créez le premier.' : 'Aucun résultat.'}
              </div>
            )}
            {filtered.map(skill => (
              <div key={skill.id} onClick={() => handleSelect(skill)} style={{
                padding: '14px 16px', borderRadius: 12,
                background: selected?.id === skill.id ? 'rgba(139,92,246,0.1)' : 'var(--bg-glass)',
                border: `1px solid ${selected?.id === skill.id ? 'rgba(139,92,246,0.4)' : 'var(--border-subtle)'}`,
                cursor: 'pointer', transition: 'all 0.15s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ padding: 8, background: 'rgba(139,92,246,0.12)', borderRadius: 8 }}>
                      <Code size={16} color="var(--brand-accent)" />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{skill.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>v{skill.version} · {skill.source}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={e => { e.stopPropagation(); handleToggle(skill); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: skill.status === 'active' ? '#10b981' : 'var(--text-muted)', display: 'flex' }}>
                      {skill.status === 'active' ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                    </button>
                    <button onClick={e => { e.stopPropagation(); handleDelete(skill.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', display: 'flex', opacity: 0.7 }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.4 }}>{skill.desc}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: 4, fontWeight: 600, background: skill.status === 'active' ? 'rgba(16,185,129,0.12)' : 'rgba(161,161,170,0.12)', color: skill.status === 'active' ? '#10b981' : 'var(--text-muted)' }}>
                    {skill.status === 'active' ? 'Actif' : 'Inactif'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: editor or create form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 14, overflow: 'hidden' }}>
          {showForm ? (
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>Nouveau Skill</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Nom *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} placeholder="my-skill" />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Version</label>
                  <input value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} style={inputStyle} placeholder="1.0.0" />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Source</label>
                  <select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="local">Local</option>
                    <option value="github">GitHub</option>
                    <option value="npm">NPM</option>
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Description</label>
                  <input value={form.desc} onChange={e => setForm(f => ({ ...f, desc: e.target.value }))} style={inputStyle} placeholder="Courte description…" />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Contenu SKILL.md</label>
                <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} rows={12} style={{ ...inputStyle, fontFamily: 'var(--mono)', fontSize: '13px', resize: 'vertical', lineHeight: 1.6 }} placeholder={`# mon-skill\n\n## Description\n...\n\n## Instructions\n...`} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', background: 'var(--bg-glass)', border: '1px solid var(--border-subtle)', borderRadius: 8, color: 'var(--text-secondary)', cursor: 'pointer' }}>Annuler</button>
                <button onClick={handleCreate} disabled={!form.name.trim() || saving} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px',
                  background: 'var(--brand-accent)', color: '#fff', border: 'none',
                  borderRadius: 8, cursor: 'pointer', fontWeight: 600, opacity: !form.name.trim() ? 0.5 : 1,
                }}>
                  <Save size={14} />{saving ? 'Création…' : 'Créer'}
                </button>
              </div>
            </div>
          ) : selected ? (
            <>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-glass)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontWeight: 600 }}>
                  <Edit3 size={16} color="var(--text-secondary)" />
                  {selected.name}.md
                </div>
                <button onClick={handleSaveContent} disabled={saving} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
                  background: saved ? 'rgba(16,185,129,0.12)' : 'var(--brand-accent)',
                  color: saved ? '#10b981' : '#fff', border: 'none', borderRadius: 8,
                  cursor: 'pointer', fontWeight: 600, fontSize: '13px',
                }}>
                  {saved ? <Check size={14} /> : saving ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
                  {saved ? 'Sauvegardé !' : 'Enregistrer'}
                </button>
              </div>
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                style={{ flex: 1, background: 'var(--bg-surface)', color: 'var(--text-primary)', padding: 20, border: 'none', resize: 'none', outline: 'none', fontSize: '13px', lineHeight: 1.7, fontFamily: 'var(--mono)', minHeight: 400 }}
              />
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: 300, color: 'var(--text-muted)', gap: 12 }}>
              <Code size={32} style={{ opacity: 0.3 }} />
              <span style={{ fontSize: '14px' }}>Sélectionnez un skill pour éditer son SKILL.md</span>
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};
