export type ContextViewTokens = { fresh: number; reused: number; written: number }

declare module 'claude-code' {
  interface PluginState {
    'klod': { breakdown: SessionContextBreakdown | null; cachedAt: number | null; refreshes: number; isKeepWarm: boolean; tokens: ContextViewTokens; usd: number | null; limits: SessionRateLimit[]; agents: AgentInfo[]; agentTools: Record<string, string>; recentPrompts: string[]; isTopicCheck: boolean }
  }
}
