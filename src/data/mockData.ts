export interface Agent {
  id: string;
  name: string;
  avatarUrl?: string;
  status: 'idle' | 'working' | 'offline';
  systemPrompt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'planned' | 'pending' | 'running' | 'completed' | 'failed';
  agentId: string;
  llmMode: 'local' | 'cloud' | 'hybrid';
  channelTarget: {
    platform: 'discord' | 'telegram' | 'whatsapp' | 'webhook';
    targetId: string;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tokensUsed?: { prompt: number; completion: number };
  cost?: number;
}

export const mockAgents: Agent[] = [
  { id: 'agent-main', name: 'NemoClaw-Main', status: 'idle', systemPrompt: 'Vous êtes l\'orchestrateur principal...' },
  { id: 'agent-support', name: 'TinyClaw-Support', status: 'working', systemPrompt: 'Assistant de support sur Telegram.' },
  { id: 'agent-veille', name: 'Veille-Bot', status: 'offline', systemPrompt: 'Crawler de news tech.' },
];

export const mockTasks: Task[] = [
  {
    id: 'tsk_101',
    title: 'Analyse Github Repos',
    description: 'Scrapper les dépôts trending et résumer les nouveautés AI.',
    status: 'running',
    agentId: 'agent-veille',
    llmMode: 'hybrid',
    channelTarget: { platform: 'discord', targetId: '1098273645' },
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    startedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 'tsk_102',
    title: 'Répondre au ticket #45',
    description: 'Un utilisateur n\'arrive pas à installer the module sur docker.',
    status: 'completed',
    agentId: 'agent-support',
    llmMode: 'local',
    channelTarget: { platform: 'telegram', targetId: '@bob_user' },
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    completedAt: new Date(Date.now() - 1000 * 60 * 115).toISOString(),
    tokensUsed: { prompt: 1045, completion: 430 },
    cost: 0.003,
  },
  {
    id: 'tsk_103',
    title: 'Audit Quotidien Sécurité',
    description: 'Scanner les logs d\'OpenShell pour détecter les fuites de PII.',
    status: 'planned',
    agentId: 'agent-main',
    llmMode: 'cloud',
    channelTarget: { platform: 'webhook', targetId: 'n8n.local/webhook/sec' },
    createdAt: new Date().toISOString(),
  }
];

export const mockKpis = {
  activeTasks: 1,
  completedToday: 12,
  failedToday: 0,
  cronsActive: 4,
  totalApiCost24h: 2.64
};
