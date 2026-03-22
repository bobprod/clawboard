import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Settings, Server, Key, User, Bell, Shield, Save, Check,
  Loader2, Trash2, ExternalLink, RefreshCw,
  Zap, AlertTriangle, Info, Wifi, WifiOff, CheckCircle,
} from 'lucide-react';
import { useApiKeys } from '../hooks/useApiKeys';
import { apiFetch } from '../lib/apiFetch';

// ─── Provider catalogue ───────────────────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  shortName?: string;
  category: string;
  color: string;
  logo: string;           // emoji fallback
  keyPrefix?: string;     // hint for key format
  docsUrl: string;
  models: string[];
}

const PROVIDERS: Provider[] = [
  // ── Tier 1 — International AI labs
  {
    id: 'anthropic', name: 'Anthropic', category: 'International',
    color: '#d97757', logo: '🤖',
    keyPrefix: 'sk-ant-',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  {
    id: 'openai', name: 'OpenAI', category: 'International',
    color: '#10a37f', logo: '🧠',
    keyPrefix: 'sk-',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
  },
  {
    id: 'gemini', name: 'Google Gemini', shortName: 'Gemini', category: 'International',
    color: '#4285f4', logo: '✨',
    keyPrefix: 'AIza',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'mistral', name: 'Mistral AI', shortName: 'Mistral', category: 'International',
    color: '#ff7000', logo: '💨',
    docsUrl: 'https://console.mistral.ai/api-keys/',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    id: 'cohere', name: 'Cohere', category: 'International',
    color: '#39594d', logo: '🔷',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
    models: ['command-r-plus', 'command-r', 'command'],
  },
  {
    id: 'xai', name: 'xAI / Grok', shortName: 'xAI', category: 'International',
    color: '#1da1f2', logo: '𝕏',
    keyPrefix: 'xai-',
    docsUrl: 'https://console.x.ai/',
    models: ['grok-2-latest', 'grok-beta'],
  },

  // ── Tier 2 — Asie & nouvelles frontières
  {
    id: 'moonshot', name: 'MoonShot (Kimi)', shortName: 'Kimi', category: 'Asie',
    color: '#1677ff', logo: '🌙',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: ['kimi-k2', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  },
  {
    id: 'deepseek', name: 'DeepSeek', category: 'Asie',
    color: '#0070f3', logo: '🌊',
    keyPrefix: 'sk-',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  },
  {
    id: 'qwen', name: 'Alibaba Qwen', shortName: 'Qwen', category: 'Asie',
    color: '#ff6a00', logo: '🏔️',
    docsUrl: 'https://bailian.console.aliyun.com/',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct'],
  },
  {
    id: 'minimax', name: 'MiniMax', category: 'Asie',
    color: '#7c3aed', logo: '⚡',
    docsUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    models: ['abab6.5s-chat', 'abab6.5g-chat', 'abab5.5-chat'],
  },
  {
    id: 'baidu', name: 'Baidu ERNIE', shortName: 'ERNIE', category: 'Asie',
    color: '#2932e1', logo: '🐻',
    docsUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    models: ['ERNIE-4.0-8K', 'ERNIE-3.5-8K'],
  },
  {
    id: 'zhipu', name: 'Zhipu AI (GLM)', shortName: 'GLM', category: 'Asie',
    color: '#0066ff', logo: '🧿',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4', 'glm-4-flash', 'glm-3-turbo'],
  },

  // ── Tier 3 — Infrastructure & agrégateurs
  {
    id: 'openrouter', name: 'OpenRouter', category: 'Agrégateurs',
    color: '#6d28d9', logo: '🔀',
    keyPrefix: 'sk-or-',
    docsUrl: 'https://openrouter.ai/settings/keys',
    models: ['openrouter/auto', '300+ modèles disponibles'],
  },
  {
    id: 'huggingface', name: 'HuggingFace', shortName: 'HF', category: 'Agrégateurs',
    color: '#ff9d00', logo: '🤗',
    keyPrefix: 'hf_',
    docsUrl: 'https://huggingface.co/settings/tokens',
    models: ['Inference API', 'Serverless endpoints'],
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', shortName: 'NVIDIA', category: 'Agrégateurs',
    color: '#76b900', logo: '⚙️',
    docsUrl: 'https://build.nvidia.com/settings/api-key',
    models: ['llama-3.1-nemotron-70b', 'mixtral-8x22b', 'phi-3-medium'],
  },
  {
    id: 'together', name: 'Together AI', shortName: 'Together', category: 'Agrégateurs',
    color: '#e11d48', logo: '🤝',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    models: ['Llama-3.3-70B', 'Mixtral-8x22B', 'Qwen2.5-72B'],
  },
  {
    id: 'groq', name: 'Groq', category: 'Agrégateurs',
    color: '#f97316', logo: '⚡',
    keyPrefix: 'gsk_',
    docsUrl: 'https://console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'gemma2-9b-it', 'mixtral-8x7b'],
  },
  {
    id: 'perplexity', name: 'Perplexity', category: 'Agrégateurs',
    color: '#20b2aa', logo: '🔍',
    keyPrefix: 'pplx-',
    docsUrl: 'https://www.perplexity.ai/settings/api',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  },
];

const CATEGORIES = ['International', 'Asie', 'Agrégateurs'];

// ─── Settings sections ────────────────────────────────────────────────────────

type Section = 'server' | 'apikeys' | 'security' | 'notifications' | 'profile';

const NAV: { id: Section; label: string; icon: any; badge?: () => number }[] = [
  { id: 'server',        label: 'Serveur & Connexions', icon: Server },
  { id: 'apikeys',       label: 'Clés API & BYOK',      icon: Key },
  { id: 'security',      label: 'Règles de Sécurité',   icon: Shield },
  { id: 'notifications', label: 'Notifications',         icon: Bell },
  { id: 'profile',       label: 'Profil Utilisateur',    icon: User },
];

// ─── KeyRow component ─────────────────────────────────────────────────────────

const KeyRow = ({
  provider,
  value,
  onChange,
  onClear,
}: {
  provider: Provider;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) => {
  const [show, setShow] = useState(false);
  const [draft, setDraft] = useState(value);
  const configured = value.trim().length > 0;

  useEffect(() => { setDraft(value); }, [value]);

  const handleBlur = () => {
    if (draft !== value) onChange(draft);
  };

  const maskedValue = configured
    ? value.slice(0, 6) + '•'.repeat(Math.max(0, Math.min(value.length - 10, 20))) + value.slice(-4)
    : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '13px 16px', borderRadius: 12,
      background: configured ? 'rgba(16,185,129,0.04)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${configured ? 'rgba(16,185,129,0.15)' : 'var(--border-subtle)'}`,
      transition: 'all 0.2s',
    }}>
      {/* Logo + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 170 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, flexShrink: 0,
          background: `${provider.color}18`,
          border: `1px solid ${provider.color}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.1rem',
        }}>
          {provider.logo}
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
            {provider.shortName || provider.name}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {provider.models.slice(0, 2).join(' · ')}
          </div>
        </div>
      </div>

      {/* Input */}
      <div style={{ flex: 1, position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={show ? draft : (configured ? maskedValue : draft)}
          onChange={e => { setDraft(e.target.value); }}
          onFocus={() => { setShow(true); setDraft(value); }}
          onBlur={() => { setShow(false); handleBlur(); }}
          placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : 'Collez votre clé API…'}
          style={{
            width: '100%', padding: '9px 12px',
            background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-subtle)',
            borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.82rem',
            fontFamily: 'var(--mono)', outline: 'none', letterSpacing: show ? 0 : 1,
          }}
          onFocusCapture={e => { e.currentTarget.style.borderColor = 'var(--brand-primary)'; }}
          onBlurCapture={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
        />
      </div>

      {/* Status + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {/* Status badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', borderRadius: 20,
          background: configured ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)',
          fontSize: '0.7rem', fontWeight: 600,
          color: configured ? '#10b981' : 'var(--text-muted)',
          whiteSpace: 'nowrap',
        }}>
          {configured ? <><CheckCircle size={11} /> Configuré</> : <>Non configuré</>}
        </div>

        {/* Docs link */}
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Obtenir une clé ${provider.name}`}
          style={{
            width: 28, height: 28, borderRadius: 6, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)',
            color: 'var(--text-muted)', textDecoration: 'none', transition: 'all 0.2s',
          }}
          onMouseOver={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.1)'; e.currentTarget.style.color = '#3b82f6'; }}
          onMouseOut={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <ExternalLink size={13} />
        </a>

        {/* Clear button */}
        {configured && (
          <button
            onClick={onClear}
            title="Effacer la clé"
            style={{
              width: 28, height: 28, borderRadius: 6, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)',
              color: 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.2s',
            }}
            onMouseOver={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = '#ef4444'; }}
            onMouseOut={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Section: API Keys ────────────────────────────────────────────────────────

const ApiKeysSection = () => {
  const { keys, setKey, clearKey, syncToBackend, syncing, lastSync, syncError, configuredCount } = useApiKeys();
  const [searchFilter, setSearchFilter] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('Tous');

  const filtered = PROVIDERS.filter(p => {
    const matchSearch = !searchFilter ||
      p.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
      p.category.toLowerCase().includes(searchFilter.toLowerCase());
    const matchCat = activeCategory === 'Tous' || p.category === activeCategory;
    return matchSearch && matchCat;
  });

  const handleSyncAndSave = async () => {
    await syncToBackend();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 18px', borderRadius: 12,
        background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.2)',
      }}>
        <Zap size={18} color="var(--brand-accent)" />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>BYOK — Bring Your Own Key</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
            Vos clés sont stockées localement (localStorage) et envoyées uniquement à votre backend ClawBoard sur{' '}
            <code style={{ background: 'rgba(0,0,0,0.2)', padding: '1px 5px', borderRadius: 4 }}>localhost:4000</code>.
            Elles ne transitent jamais vers des serveurs externes.
          </div>
        </div>
        <div style={{
          padding: '5px 12px', borderRadius: 20,
          background: configuredCount > 0 ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${configuredCount > 0 ? 'rgba(16,185,129,0.3)' : 'var(--border-subtle)'}`,
          fontSize: '0.8rem', fontWeight: 700,
          color: configuredCount > 0 ? '#10b981' : 'var(--text-muted)',
          whiteSpace: 'nowrap',
        }}>
          {configuredCount} / {PROVIDERS.length} configuré{configuredCount > 1 ? 's' : ''}
        </div>
      </div>

      {/* Warning */}
      <div style={{
        display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10,
        background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.2)',
      }}>
        <AlertTriangle size={15} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ fontSize: '0.78rem', color: '#f59e0b', lineHeight: 1.5 }}>
          Ne partagez jamais vos clés API. Cliquez sur <strong>Enregistrer &amp; Synchroniser</strong> pour que Lia puisse utiliser le bon modèle lors de vos conversations.
        </span>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Rechercher un provider…"
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          style={{
            flex: 1, minWidth: 180, padding: '8px 12px',
            background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-subtle)',
            borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.83rem', outline: 'none',
          }}
        />
        {['Tous', ...CATEGORIES].map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            style={{
              padding: '7px 14px', borderRadius: 20, fontSize: '0.8rem', fontWeight: 600,
              cursor: 'pointer', transition: 'all 0.2s',
              background: activeCategory === cat ? 'var(--brand-primary)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${activeCategory === cat ? 'var(--brand-primary)' : 'var(--border-subtle)'}`,
              color: activeCategory === cat ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Provider groups */}
      {(activeCategory === 'Tous' ? CATEGORIES : [activeCategory]).map(cat => {
        const catProviders = filtered.filter(p => p.category === cat);
        if (catProviders.length === 0) return null;
        return (
          <div key={cat}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
              {cat}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {catProviders.map(p => (
                <KeyRow
                  key={p.id}
                  provider={p}
                  value={keys[p.id] || ''}
                  onChange={v => setKey(p.id, v)}
                  onClear={() => clearKey(p.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Sync footer */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 18px', borderRadius: 12,
        background: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)',
        marginTop: 4,
      }}>
        <div style={{ flex: 1 }}>
          {syncError ? (
            <div style={{ fontSize: '0.8rem', color: '#ef4444', display: 'flex', gap: 6, alignItems: 'center' }}>
              <AlertTriangle size={13} /> {syncError}
            </div>
          ) : lastSync ? (
            <div style={{ fontSize: '0.8rem', color: '#10b981', display: 'flex', gap: 6, alignItems: 'center' }}>
              <CheckCircle size={13} /> Synchronisé le {lastSync.toLocaleTimeString('fr-FR')}
            </div>
          ) : (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Cliquez sur Enregistrer pour que Lia utilise ces clés.
            </div>
          )}
        </div>
        <button
          onClick={handleSyncAndSave}
          disabled={syncing}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 20px', borderRadius: 8, border: 'none',
            background: 'var(--brand-primary)', color: '#fff',
            cursor: syncing ? 'not-allowed' : 'pointer', fontWeight: 700,
            fontSize: '0.85rem', transition: 'all 0.2s',
          }}
        >
          {syncing ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={15} />}
          Enregistrer &amp; Synchroniser
        </button>
      </div>
    </div>
  );
};

// ─── Section: Server ─────────────────────────────────────────────────────────

const ServerSection = () => {
  const [pingResult, setPingResult] = useState<'idle' | 'ok' | 'error'>('idle');
  const [pinging, setPinging] = useState(false);

  const ping = async () => {
    setPinging(true); setPingResult('idle');
    try {
      const r = await apiFetch('http://localhost:4000/api/ping', { signal: AbortSignal.timeout(3000) });
      setPingResult(r.ok ? 'ok' : 'error');
    } catch { setPingResult('error'); }
    finally { setPinging(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600 }}>
          ClawBoard Backend URL
        </label>
        <input type="text" defaultValue="http://localhost:4000" style={{ width: '100%', padding: 14, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-subtle)', borderRadius: 10, color: '#fff', fontSize: 15, outline: 'none' }} />
      </div>
      <div>
        <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, fontWeight: 600 }}>
          Ollama Local Host
        </label>
        <input type="text" defaultValue="http://127.0.0.1:11434" style={{ width: '100%', padding: 14, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-subtle)', borderRadius: 10, color: '#fff', fontSize: 15, outline: 'none' }} />
      </div>
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.85rem', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" defaultChecked style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--brand-primary)' }} />
          Activer WebHooks entrants (Port 5050)
        </label>
        <div className="text-muted" style={{ fontSize: 13, marginLeft: 28, marginTop: 6 }}>
          Déclenche ClawBoard depuis Telegram, Discord, n8n, etc.
        </div>
      </div>

      <div style={{ background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.2)', padding: 20, borderRadius: 12 }}>
        <h4 style={{ margin: '0 0 8px', color: 'var(--brand-accent)', fontSize: '1rem' }}>Test de Connexion Backend</h4>
        <p style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--text-secondary)' }}>
          Vérifiez la connectivité avec le cœur NemoClaw.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={ping}
            disabled={pinging}
            style={{ padding: '10px 20px', background: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, color: '#fff', cursor: 'pointer', fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}
          >
            {pinging ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Wifi size={15} />}
            Lancer le Ping
          </button>
          {pingResult === 'ok' && <span style={{ color: '#10b981', display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600, fontSize: '0.85rem' }}><CheckCircle size={16} /> Connecté</span>}
          {pingResult === 'error' && <span style={{ color: '#ef4444', display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600, fontSize: '0.85rem' }}><WifiOff size={16} /> Hors ligne</span>}
        </div>
      </div>
    </div>
  );
};

// ─── Placeholder sections ─────────────────────────────────────────────────────

const PlaceholderSection = ({ title, desc }: { title: string; desc: string }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 16, textAlign: 'center' }}>
    <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(139,92,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Info size={24} color="var(--brand-accent)" />
    </div>
    <div>
      <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 6 }}>{title}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: 340 }}>{desc}</div>
    </div>
    <div style={{ padding: '6px 16px', borderRadius: 20, background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.2)', color: 'var(--brand-accent)', fontSize: '0.78rem', fontWeight: 600 }}>
      Bientôt disponible
    </div>
  </div>
);

// ─── SettingsModule ───────────────────────────────────────────────────────────

export const SettingsModule = () => {
  const [searchParams] = useSearchParams();
  const initSection = (searchParams.get('tab') as Section) ?? 'server';
  const [section, setSection] = useState<Section>(
    NAV.some(n => n.id === initSection) ? initSection : 'server'
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { syncToBackend, configuredCount } = useApiKeys();

  // sync section when ?tab= changes (e.g. navigating from topbar menu)
  useEffect(() => {
    const tab = searchParams.get('tab') as Section;
    if (tab && NAV.some(n => n.id === tab)) setSection(tab);
  }, [searchParams]);

  const handleGlobalSave = async () => {
    setIsSaving(true);
    if (section === 'apikeys') await syncToBackend();
    else await new Promise(r => setTimeout(r, 600));
    setIsSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const renderContent = () => {
    switch (section) {
      case 'server':        return <ServerSection />;
      case 'apikeys':       return <ApiKeysSection />;
      case 'security':      return <PlaceholderSection title="Règles de Sécurité" desc="Gérez les listes blanches d'IP, les permissions par agent, et les politiques de rate-limiting." />;
      case 'notifications': return <PlaceholderSection title="Notifications" desc="Configurez les alertes Telegram, Discord, e-mail et webhooks pour les événements système." />;
      case 'profile':       return <PlaceholderSection title="Profil Utilisateur" desc="Personnalisez votre nom, avatar, fuseau horaire et préférences de langue." />;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 32 }}>
      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ background: 'var(--brand-primary)', padding: 12, borderRadius: 14, color: '#fff' }}>
            <Settings size={28} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0 }}>Paramètres Systèmes</h2>
            <div className="text-muted" style={{ marginTop: 4 }}>
              Configuration globale, clés API BYOK, sécurité.
              {configuredCount > 0 && (
                <span style={{ marginLeft: 10, color: '#10b981', fontWeight: 600 }}>
                  {configuredCount} clé{configuredCount > 1 ? 's' : ''} configurée{configuredCount > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        </div>

        <button
          onClick={handleGlobalSave}
          disabled={isSaving}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 24px', borderRadius: 8, border: 'none',
            background: saved ? 'var(--status-success)' : 'var(--brand-primary)',
            color: '#fff', cursor: isSaving ? 'not-allowed' : 'pointer',
            fontWeight: 600, transition: 'all 0.3s',
            boxShadow: saved ? '0 0 15px rgba(16,185,129,0.4)' : 'none',
          }}
        >
          {isSaving ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> : saved ? <Check size={18} /> : <Save size={18} />}
          {isSaving ? 'Enregistrement…' : saved ? 'Sauvegardé !' : 'Enregistrer'}
        </button>
      </div>

      {/* 2-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 260px) 1fr', gap: 32, alignItems: 'start' }}>
        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NAV.map(item => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setSection(item.id)}
                style={{
                  padding: '13px 16px', borderRadius: 12,
                  display: 'flex', alignItems: 'center', gap: 12,
                  background: active ? 'rgba(139,92,246,0.12)' : 'transparent',
                  border: active ? '1px solid rgba(139,92,246,0.25)' : '1px solid transparent',
                  color: active ? 'var(--brand-accent)' : 'var(--text-secondary)',
                  textAlign: 'left', fontWeight: active ? 700 : 500,
                  cursor: 'pointer', transition: 'all 0.15s', fontSize: '0.9rem',
                }}
                onMouseOver={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseOut={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <Icon size={18} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.id === 'apikeys' && configuredCount > 0 && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700,
                    background: 'rgba(16,185,129,0.15)', color: '#10b981',
                  }}>
                    {configuredCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Content panel */}
        <div className="glass-panel" style={{ padding: 32 }}>
          <h3 style={{
            margin: '0 0 20px', fontSize: '1.1rem',
            paddingBottom: 16, borderBottom: '1px solid var(--border-subtle)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            {(() => { const n = NAV.find(n => n.id === section); const Icon = n?.icon; return Icon ? <Icon size={18} color="var(--brand-accent)" /> : null; })()}
            {NAV.find(n => n.id === section)?.label}
          </h3>
          {renderContent()}
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};
