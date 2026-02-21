export type AgentType = 'codex' | 'gemini' | 'cursor' | 'claude' | 'opencode' | 'copilot';
export declare function normalizeEvents(agentType: AgentType, raw: any): any[];
export declare function normalizeEvent(agentType: AgentType, raw: any): any;
export declare function parseEvent(agentType: AgentType, line: string): any[] | null;
//# sourceMappingURL=parsers.d.ts.map