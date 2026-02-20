import { AgentType } from './parsers.js';
export declare function resolveBaseDir(): Promise<string>;
export type EffortLevel = 'fast' | 'default' | 'detailed';
export type ModelOverrides = Partial<Record<AgentType, Partial<Record<EffortLevel, string>>>>;
export interface ProviderConfig {
    apiEndpoint: string | null;
}
export interface AgentModelConfig {
    fast: string;
    default: string;
    detailed: string;
}
export interface AgentConfig {
    command: string;
    enabled: boolean;
    models: AgentModelConfig;
    provider: string;
}
export interface SwarmConfig {
    agents: Record<AgentType, AgentConfig>;
    providers: Record<string, ProviderConfig>;
}
export interface ReadConfigResult {
    hasConfig: boolean;
    enabledAgents: AgentType[];
    agentConfigs: Record<AgentType, AgentConfig>;
    providerConfigs: Record<string, ProviderConfig>;
}
export declare function resolveAgentsDir(): Promise<string>;
export declare function readConfig(): Promise<ReadConfigResult>;
export declare function writeConfig(config: SwarmConfig): Promise<void>;
export declare function getModelForAgent(agentConfigs: Record<AgentType, AgentConfig>, agentType: AgentType, effort: EffortLevel): string;
export declare function setAgentEnabled(agentType: AgentType, enabled: boolean): Promise<void>;
//# sourceMappingURL=persistence.d.ts.map