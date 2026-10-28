export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { content: string; status: TaskStatus }

export type AgentRow = {
  id: string
  description: string
  type: string
  model?: string
  effort?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  tokens: number
  costUsd: number
  contextTokens: number
  startedAt: number
  endedAt?: number
  tasks: Task[]
  lastTool?: string
  toolCount: number
}

export type Cache = {
  // When the main loop's last model response arrived: the prompt cache's TTL counts from it.
  lastAt: number
  // Share of that request's input the cache served, 0 to 1.
  hit: number
  // That request's input in tokens, and the model that read it: what a cold cache would bill in full.
  tokens: number
  model: string
  isWorking: boolean
  warnedAt: number
}

export type Handoff =
  | { status: 'idle' }
  | { status: 'writing' }
  | { status: 'ready'; text: string; at: number; note?: string }
  | { status: 'failed'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      plan: Task[]
      agents: AgentRow[]
      tick: number
      lastTickAt: number
      totalTokens: number
      turnStartedAt: number
      isBandHidden: boolean
      cache: Cache
      selected: string | null
      handoff: Handoff
    }
  }
}
