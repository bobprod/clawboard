# Clawboard — Instructions de développement

Frontend React + TypeScript + Vite pour **Nemoclaw** (version sécurisée d'OpenClaw by NVIDIA).

## Stack technique
- React 18, TypeScript strict, Vite
- React Router v6 (`useNavigate`, `useLocation`)
- Joyride (product tours)
- Lucide React (icônes)
- `apiFetch` wrapper : `src/lib/apiFetch.ts`
- Backend Nemoclaw : `http://localhost:4000`
- `npx tsc --noEmit` doit toujours passer à zéro erreurs

## Architecture
```
src/
  App.tsx              — Router, sidebar, ThemeSwitcher, AppShell
  index.css            — Variables CSS + 6 thèmes
  components/          — Tous les composants
  hooks/               — useSSE, useApiKeys…
  lib/                 — apiFetch
  data/                — mockData
```

## Composants implémentés

### Dashboard (`Dashboard.tsx`)
- `AlertsBanner` — smart alerts, polling 60s, seuils localStorage `clawboard-alerts-settings`
- `ActivityHeatmap` — heatmap 30j, streak, tooltip hover
- `ModelCostBreakdown` — coût par modèle, 3 périodes (7j/30j/all)
- `AgentChat` — chat flottant SSE, multi-agents, tool calls
- `ApprovalsWidget` — flux d'approbation humain, risque élevé/moyen/faible, Approuver/Rejeter, expiration
- `GatewayProbes` — probes santé providers, latence, auto-refresh 60s
- `DashboardTour` — tour Joyride 9 étapes, 1ère visite auto, relançable menu profil

### Tâches (`TachesPage.tsx`)
- Tab Tâches : clone, rejouer FAILED, dropdown, navigate avec prefill
- Tab Modèles : badges last-exec (✓ OK / ✕ FAIL) via archives cross-ref
- Tab Récurrences : badge ÉCHEC sur modèles en échec
- Tab Archives : search + filtres status + export CSV

### Création (`TaskCreator.tsx`)
- Auto-save draft : localStorage key `clawboard-task-creator-draft`
- Clone/Rejouer : `useLocation().state?.prefill`
- ValidationBanner : warnings (no-model error, no-dest warn, short-prompt warn)
- `SkillsPicker` intégré (remplace input texte pour le champ Skill)
- Compteur mots/chars, timeout suggéré, save-as-model toggle

### Mémoire (`MemoryModule.tsx`)
- Quick-access : MEMORY.md, HEARTBEAT.md, CLAUDE.md, NOTES.md
- Filtre par type, modes Edit / Split / Preview
- Rendu Markdown inline (regex, zero dépendance)
- Sync indicator, `GET /api/memory`, `PATCH /api/memory/:id`

### Skills (`SkillsModule.tsx` + `SkillsPicker.tsx`)
- Page complète + modale picker réutilisable (props: `value`, `onChange`)
- Filtres catégorie (local/github/npm), cartes status/tags
- `GET /api/skills`

### Terminal (`TerminalModule.tsx`)
- Route `/terminal` dans la nav sidebar
- Historique ↑↓, Ctrl+L clear, Ctrl+C annuler
- Builtins : help, clear, version, status, tasks, run \<id\>, logs \<id\>
- Fallback graceful si `/api/shell` absent

## Thèmes (6) — `src/index.css` + `THEMES` dans `App.tsx`
| id | Nom | Accent |
|---|---|---|
| `dark` | Dark | #8b5cf6 |
| `light` | Light | #7c3aed |
| `synthwave` | Synthwave | #ff2d78 |
| `nord` | Nord | #88c0d0 |
| `catppuccin` | Catppuccin Mocha | #cba6f7 |
| `ocean` | Deep Ocean | #38bdf8 |

Clé localStorage : `clawboard-theme`

## Endpoints Nemoclaw utilisés
```
GET  /api/tasks              (+ ?stream=1 SSE, ?status=running)
POST /api/tasks/:id/run
GET  /api/archives
GET  /api/recurrences
GET  /api/modeles
POST /api/modeles
GET  /api/memory
PATCH /api/memory/:id
GET  /api/skills
GET  /api/health
POST /api/chat               (SSE streaming)
GET  /api/quota              (SSE)
GET  /api/approvals          (mock graceful si absent)
POST /api/approvals/:id      (decision: approve|reject)
GET  /api/health/probes      (mock graceful si absent)
POST /api/shell              (terminal, mock graceful si absent)
```

## Patterns importants
- **Mock graceful** : tous les endpoints optionnels ont un `.catch()` qui injecte des données de démo
- **data-tour** attributes : présents sur les éléments ciblés par les tours Joyride
- **SSE** : `useSSE` hook + `EventSource` / `ReadableStream` dans AgentChat
- **Clone prefill** : `navigate('/tasks/new', { state: { prefill: task } })`
- **CSS vars** : toujours utiliser `var(--bg-glass)`, `var(--border-subtle)`, etc. — jamais de couleurs hardcodées

## Backlog restant
- QR code pairing Telegram/Discord dans TaskCreator
- Git log viewer (`GitLogModule.tsx`)
- TOTP MFA dans `SecurityModule.tsx`
- Brancher `/api/approvals` réel quand disponible côté Nemoclaw
