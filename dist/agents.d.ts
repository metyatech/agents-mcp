import { type AgentConfig } from './persistence.js';
import { AgentType } from './parsers.js';
/**
 * Compute the Lowest Common Ancestor (LCA) of multiple file paths.
 * Returns the deepest common directory shared by all paths.
 * Returns null if paths is empty or paths have no common ancestor (different roots).
 */
export declare function computePathLCA(paths: string[]): string | null;
export declare enum AgentStatus {
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    STOPPED = "stopped"
}
export type { AgentType } from './parsers.js';
export declare function buildWindowsSpawnPs1(cmd: string[], stdoutPath: string, workingDirectory: string): string;
/**
 * Split a shell command string into an argv array, handling single and double quotes.
 * Used for parsing AgentConfig.command strings from ~/.agents/swarm/config.json.
 *
 * Behaviour:
 *   - Single-quoted tokens: content is taken literally (no escape sequences).
 *   - Double-quoted tokens: \" and \\ are unescaped; all other chars are literal.
 *   - Unquoted whitespace (space/tab) separates tokens.
 *   - Throws on unterminated quotes.
 */
export declare function splitCommandTemplate(cmdStr: string): string[];
export declare const AGENT_COMMANDS: Record<AgentType, string[]>;
export type EffortLevel = 'fast' | 'default' | 'detailed';
export type EffortModelMap = Record<EffortLevel, Record<AgentType, string>>;
export declare function resolveEffortModelMap(baseOrAgentConfigs: EffortModelMap | Record<AgentType, AgentConfig>, overrides?: Partial<Record<AgentType, Partial<Record<EffortLevel, string>>>>): EffortModelMap;
export declare const EFFORT_MODEL_MAP: EffortModelMap;
declare const VALID_MODES: readonly ["plan", "edit", "ralph"];
type Mode = typeof VALID_MODES[number];
export declare function resolveMode(requestedMode: string | null | undefined, defaultMode?: Mode): Mode;
export declare function checkCliAvailable(agentType: AgentType): [boolean, string | null];
export declare function checkAllClis(): Record<string, {
    installed: boolean;
    path: string | null;
    error: string | null;
}>;
export declare function getAgentsDir(): Promise<string>;
export declare class AgentProcess {
    agentId: string;
    taskName: string;
    agentType: AgentType;
    prompt: string;
    cwd: string | null;
    workspaceDir: string | null;
    mode: Mode;
    pid: number | null;
    status: AgentStatus;
    startedAt: Date;
    completedAt: Date | null;
    parentSessionId: string | null;
    sessionId: string | null;
    conversationTurn: number;
    originalAgentId: string | null;
    replyAgentIds: string[];
    private eventsCache;
    private lastReadPos;
    private baseDir;
    constructor(agentId: string, taskName: string, agentType: AgentType, prompt: string, cwd?: string | null, mode?: Mode, pid?: number | null, status?: AgentStatus, startedAt?: Date, completedAt?: Date | null, baseDir?: string | null, parentSessionId?: string | null, workspaceDir?: string | null, sessionId?: string | null, conversationTurn?: number, originalAgentId?: string | null, replyAgentIds?: string[]);
    get isEditMode(): boolean;
    getAgentDir(): Promise<string>;
    getStdoutPath(): Promise<string>;
    getMetaPath(): Promise<string>;
    toDict(): any;
    duration(): string | null;
    get events(): any[];
    /**
     * Return the latest timestamp we have seen in the agent's events.
     * Falls back to null when none are available.
     */
    private getLatestEventTime;
    readNewEvents(): Promise<void>;
    saveMeta(): Promise<void>;
    static loadFromDisk(agentId: string, baseDir?: string | null): Promise<AgentProcess | null>;
    isProcessAlive(): boolean;
    updateStatusFromProcess(): Promise<void>;
    private reapProcess;
}
export declare class AgentManager {
    private agents;
    private maxAgents;
    private maxConcurrent;
    private agentsDir;
    private filterByCwd;
    private cleanupAgeDays;
    private defaultMode;
    private effortModelMap;
    private agentConfigs;
    private constructorAgentConfigs;
    private constructorAgentsDir;
    private initPromise;
    constructor(maxAgents?: number, maxConcurrent?: number, agentsDir?: string | null, defaultMode?: Mode | null, filterByCwd?: string | null, cleanupAgeDays?: number, agentConfigs?: Record<AgentType, AgentConfig> | null);
    getAgentsDirPath(): string;
    private initialize;
    private doInitialize;
    getDefaultMode(): Mode;
    setModelOverrides(agentConfigs: Record<AgentType, AgentConfig>): void;
    private loadExistingAgents;
    spawn(taskName: string, agentType: AgentType, prompt: string, cwd?: string | null, mode?: Mode | null, effort?: EffortLevel, parentSessionId?: string | null, workspaceDir?: string | null, model?: string | null): Promise<AgentProcess>;
    private buildCommand;
    private applyEditMode;
    private applyRalphMode;
    private static readonly REPLY_SUPPORTED_AGENTS;
    buildReplyCommand(agentType: AgentType, message: string, sessionId: string | null, mode: Mode, model: string, cwd?: string | null): string[];
    reply(originalAgent: AgentProcess, message: string, effort?: EffortLevel, model?: string | null): Promise<AgentProcess>;
    get(agentId: string): Promise<AgentProcess | null>;
    listAll(): Promise<AgentProcess[]>;
    listRunning(): Promise<AgentProcess[]>;
    listCompleted(): Promise<AgentProcess[]>;
    listByTask(taskName: string): Promise<AgentProcess[]>;
    listByParentSession(parentSessionId: string): Promise<AgentProcess[]>;
    stopByTask(taskName: string): Promise<{
        stopped: string[];
        alreadyStopped: string[];
    }>;
    stop(agentId: string): Promise<boolean>;
    private cleanupPartialAgent;
    private cleanupOldAgents;
}
//# sourceMappingURL=agents.d.ts.map