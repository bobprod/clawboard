import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, Play, Square, Trash2, Copy, ChevronRight, Loader2 } from 'lucide-react';

const BASE = 'http://localhost:4000';
const WS_BASE = BASE.replace('http', 'ws');

// ─── Types ────────────────────────────────────────────────────────────────────

type LineType = 'input' | 'output' | 'error' | 'system' | 'success';

interface TermLine {
  id: number;
  type: LineType;
  text: string;
  ts: string;
}

// ─── Builtin commands (no network) ────────────────────────────────────────────

const BUILTINS: Record<string, (args: string[]) => string> = {
  clear: () => '__CLEAR__',
  help: () => [
    '  Commandes disponibles :',
    '  ────────────────────────────────────────',
    '  help               Afficher cette aide',
    '  clear              Effacer le terminal',
    '  version            Version de Nemoclaw',
    '  status             Statut du gateway',
    '  tasks              Lister les tâches actives',
    '  run <task-id>      Rejouer une tâche',
    '  logs <task-id>     Afficher les logs d'une tâche',
    '  health             Vérifier la santé du système',
    '  echo <texte>       Répéter le texte',
    '  date               Date et heure actuelles',
  ].join('\n'),
  version: () => '  Nemoclaw v2.4.1 (OpenClaw-NVIDIA fork) — Clawboard UI v1.0.0',
  date: () => `  ${new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' })}`,
  echo: (args) => `  ${args.join(' ')}`,
};

// ─── Line renderer ────────────────────────────────────────────────────────────

const LINE_COLOR: Record<LineType, string> = {
  input:   '#94a3b8',
  output:  '#e2e8f0',
  error:   '#f87171',
  system:  '#6b7280',
  success: '#4ade80',
};

// ─── History ──────────────────────────────────────────────────────────────────

const HIST_KEY = 'clawboard-terminal-history';
const loadHistory = (): string[] => {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
};
const saveHistory = (h: string[]) => {
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-200)));
};

// ─── Component ────────────────────────────────────────────────────────────────

let lineId = 0;
const mkLine = (type: LineType, text: string): TermLine => ({
  id: ++lineId, type, text,
  ts: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
});

export const TerminalModule = () => {
  const [lines, setLines]         = useState<TermLine[]>([
    mkLine('system', '  ╔══════════════════════════════════════════════╗'),
    mkLine('system', '  ║  Nemoclaw Terminal  ·  Clawboard v1.0.0      ║'),
    mkLine('system', '  ╚══════════════════════════════════════════════╝'),
    mkLine('system', '  Tapez "help" pour la liste des commandes disponibles.'),
    mkLine('system', ''),
  ]);
  const [input,   setInput]       = useState('');
  const [running, setRunning]     = useState(false);
  const [history, setHistory]     = useState<string[]>(loadHistory);
  const [histIdx, setHistIdx]     = useState(-1);
  const [showTs,  setShowTs]      = useState(false);
  const inputRef  = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef     = useRef<WebSocket | null>(null);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Focus on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  const appendLines = useCallback((newLines: TermLine[]) => {
    setLines(prev => [...prev, ...newLines]);
  }, []);

  const clearTerminal = useCallback(() => {
    setLines([mkLine('system', '  Terminal effacé.')]);
  }, []);

  // ── Execute command ──────────────────────────────────────────────────────────
  const execute = useCallback(async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;

    // Echo input
    appendLines([mkLine('input', `$ ${cmd}`)]);

    // History
    setHistory(prev => {
      const next = [cmd, ...prev.filter(h => h !== cmd)];
      saveHistory(next);
      return next;
    });
    setHistIdx(-1);

    const [verb, ...args] = cmd.split(/\s+/);

    // ── Builtins ──────────────────────────────────────────────────────────────
    if (BUILTINS[verb]) {
      const result = BUILTINS[verb](args);
      if (result === '__CLEAR__') { clearTerminal(); return; }
      appendLines(result.split('\n').map(l => mkLine('output', l)));
      return;
    }

    // ── Remote commands ───────────────────────────────────────────────────────
    setRunning(true);
    try {
      if (verb === 'status' || verb === 'health') {
        const res = await fetch(`${BASE}/api/health`);
        const data = await res.json();
        appendLines([
          mkLine('success', `  ✓ Gateway: ${data.status ?? 'unknown'}`),
          mkLine('output',  `  ·  uptime: ${data.uptime ?? '—'}`),
          mkLine('output',  `  ·  version: ${data.version ?? '—'}`),
        ]);

      } else if (verb === 'tasks') {
        const res = await fetch(`${BASE}/api/tasks?status=running`);
        const tasks: any[] = await res.json();
        if (!tasks.length) {
          appendLines([mkLine('system', '  Aucune tâche active.')]);
        } else {
          appendLines([
            mkLine('output', `  ${tasks.length} tâche(s) active(s) :`),
            ...tasks.map(t => mkLine('output', `  · [${t.id}] ${t.name || t.title} — ${t.status}`)),
          ]);
        }

      } else if (verb === 'run' && args[0]) {
        const res = await fetch(`${BASE}/api/tasks/${args[0]}/run`, { method: 'POST' });
        if (res.ok) {
          appendLines([mkLine('success', `  ✓ Tâche ${args[0]} relancée avec succès.`)]);
        } else {
          appendLines([mkLine('error', `  ✗ Échec du lancement : HTTP ${res.status}`)]);
        }

      } else if (verb === 'logs' && args[0]) {
        // Stream logs via SSE or fetch
        const res = await fetch(`${BASE}/api/tasks/${args[0]}/logs`);
        const text = await res.text();
        const logLines = text.split('\n').slice(0, 50);
        appendLines(logLines.map(l => mkLine('output', `  ${l}`)));

      } else {
        // Forward to gateway shell endpoint
        const res = await fetch(`${BASE}/api/shell`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('text/event-stream')) {
            // Stream SSE
            const reader = res.body?.getReader();
            const decoder = new TextDecoder();
            if (reader) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const parsed = chunk.split('\n')
                  .filter(l => l.startsWith('data:'))
                  .map(l => l.slice(5).trim());
                if (parsed.length) {
                  appendLines(parsed.flatMap(p => p.split('\n').map(l => mkLine('output', `  ${l}`))));
                }
              }
            }
          } else {
            const data = await res.json();
            const out = data.stdout || data.output || JSON.stringify(data, null, 2);
            appendLines(out.split('\n').map((l: string) => mkLine('output', `  ${l}`)));
            if (data.stderr) {
              appendLines(data.stderr.split('\n').map((l: string) => mkLine('error', `  ${l}`)));
            }
          }
        } else {
          appendLines([mkLine('error', `  ✗ Commande inconnue : "${verb}". Tapez "help" pour l'aide.`)]);
        }
      }
    } catch (err: any) {
      appendLines([mkLine('error', `  ✗ ${err?.message || 'Erreur réseau'}`)]);
    } finally {
      setRunning(false);
    }
  }, [appendLines, clearTerminal]);

  // ── Submit handler ───────────────────────────────────────────────────────────
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || running) return;
    execute(input);
    setInput('');
  };

  // ── History navigation ───────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setInput(idx === -1 ? '' : history[idx] ?? '');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      clearTerminal();
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (running) setRunning(false);
      appendLines([mkLine('system', '  ^C')]);
      setInput('');
    }
  };

  const copyAll = () => {
    const text = lines.map(l => l.text).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="glass-panel" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        borderRadius: '12px 12px 0 0',
        flexShrink: 0,
      }}>
        <Terminal size={16} color="var(--brand-accent)" />
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Terminal Nemoclaw</span>

        {running && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#3b82f6', fontSize: 12 }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            En cours…
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {/* Toggle timestamps */}
          <button
            onClick={() => setShowTs(p => !p)}
            title="Afficher / masquer les timestamps"
            style={{
              background: showTs ? 'rgba(139,92,246,0.12)' : 'none',
              border: '1px solid ' + (showTs ? 'rgba(139,92,246,0.3)' : 'transparent'),
              borderRadius: 6, cursor: 'pointer',
              color: showTs ? 'var(--brand-accent)' : 'var(--text-muted)',
              padding: '4px 8px', fontSize: 11, fontWeight: 600,
            }}
          >
            HH:MM
          </button>

          {/* Copy */}
          <button
            onClick={copyAll}
            title="Copier tout"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 5, borderRadius: 6 }}
          >
            <Copy size={13} />
          </button>

          {/* Clear */}
          <button
            onClick={clearTerminal}
            title="Effacer (Ctrl+L)"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 5, borderRadius: 6 }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* ── Output area ─────────────────────────────────────────────────────── */}
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          flex: 1,
          background: 'var(--bg-surface)',
          padding: '14px 18px',
          overflowY: 'auto',
          fontFamily: 'var(--mono, "Fira Code", "Cascadia Code", monospace)',
          fontSize: '0.78rem',
          lineHeight: 1.75,
          cursor: 'text',
          minHeight: 300,
          maxHeight: 480,
        }}
      >
        {lines.map(line => (
          <div key={line.id} style={{ display: 'flex', gap: 10 }}>
            {showTs && (
              <span style={{ color: '#4b5563', flexShrink: 0, userSelect: 'none', fontSize: '0.7rem', lineHeight: 1.75, marginTop: 1 }}>
                {line.ts}
              </span>
            )}
            <span
              style={{
                color: LINE_COLOR[line.type],
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                opacity: line.type === 'system' ? 0.6 : 1,
              }}
            >
              {line.text}
            </span>
          </div>
        ))}

        {/* Running indicator */}
        {running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#4b5563', fontSize: '0.75rem' }}>
            <Loader2 size={11} style={{ animation: 'spin 0.8s linear infinite', color: '#3b82f6' }} />
            <span style={{ color: '#3b82f6' }}>exécution…</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input row ───────────────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border-subtle)',
          padding: '10px 14px',
          borderRadius: '0 0 12px 12px',
          flexShrink: 0,
        }}
      >
        <ChevronRight size={14} style={{ color: running ? '#3b82f6' : '#10b981', flexShrink: 0 }} />
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={false}
          autoComplete="off"
          spellCheck={false}
          placeholder={running ? 'Ctrl+C pour annuler…' : 'Entrez une commande…'}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontFamily: 'var(--mono, monospace)',
            fontSize: '0.78rem',
            color: running ? '#6b7280' : '#e2e8f0',
            caretColor: '#8b5cf6',
          }}
        />
        <button
          type="submit"
          disabled={!input.trim() || running}
          style={{
            background: 'rgba(139,92,246,0.1)',
            border: '1px solid rgba(139,92,246,0.2)',
            borderRadius: 6,
            color: 'var(--brand-accent)',
            cursor: 'pointer',
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            opacity: !input.trim() || running ? 0.4 : 1,
            transition: 'opacity 0.15s',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Play size={10} /> Exec
        </button>
      </form>

      {/* ── Shortcut hint ───────────────────────────────────────────────────── */}
      <div style={{
        padding: '5px 16px',
        fontSize: 10,
        color: 'var(--text-muted)',
        letterSpacing: '0.2px',
      }}>
        ↑↓ Historique &nbsp;·&nbsp; Ctrl+L Effacer &nbsp;·&nbsp; Ctrl+C Annuler &nbsp;·&nbsp; help Aide
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};
