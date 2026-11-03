export type NodeStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export type AgentNode = {
  role: 'planner' | 'coder' | 'reviewer'
  model: string
  effort?: string
  agentId?: string
  status: NodeStatus
  startedAt?: number
  endedAt?: number
  tokensIn: number
  tokensOut: number
  tokensCached: number
  /** Characters handed to the agent (its prompt). */
  inChars: number
  /** Characters it handed back (its report). */
  outChars: number
  /** The last few tool calls it made, newest last. */
  activity: string[]
  toolCalls: number
  /** First lines of its report. */
  summary?: string
  /** What it was handed (its prompt), capped. */
  prompt?: string
  /** What it handed back (its whole report), capped. */
  report?: string
}

export type Step = {
  n: number
  title: string
  brief: string
  files: string[]
  dependsOn: number[]
  node: AgentNode
}

export type Run = {
  id: string
  task: string
  status: 'planning' | 'coding' | 'reviewing' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  planSummary?: string
  planner: AgentNode
  steps: Step[]
  reviewer: AgentNode
  verdict?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    executor: {
      runs: Shaped<Run[]>
      selected: number
      /** Which agent's details are open: 'planner', 'reviewer', a step number as text, or '' for none. */
      focus: string
    }
  }
}
