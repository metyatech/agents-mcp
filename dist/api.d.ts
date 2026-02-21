import { AgentManager } from './agents.js';
import { AgentType } from './parsers.js';
export interface SpawnResult {
    task_name: string;
    agent_id: string;
    agent_type: string;
    status: string;
    started_at: string;
}
export interface ReplyResult {
    agent_id: string;
    original_agent_id: string;
    agent_type: string;
    task_name: string;
    conversation_turn: number;
    status: string;
    started_at: string;
}
export interface AgentStatusDetail {
    agent_id: string;
    agent_type: string;
    status: string;
    duration: string | null;
    files_created: string[];
    files_modified: string[];
    files_read: string[];
    files_deleted: string[];
    bash_commands: string[];
    last_messages: string[];
    tool_count: number;
    has_errors: boolean;
    errors: string[];
    diagnostics?: {
        log_paths: {
            agent_dir: string;
            stdout: string;
            meta: string;
        };
        log_tail: string[];
        tail_errors: string[];
    };
    cursor: string;
    conversation_turn?: number;
    original_agent_id?: string | null;
    reply_agent_ids?: string[];
    session_id?: string | null;
}
export interface TaskStatusResult {
    task_name: string;
    agents: AgentStatusDetail[];
    summary: {
        running: number;
        completed: number;
        failed: number;
        stopped: number;
    };
    cursor: string;
}
export interface StopResult {
    task_name: string;
    stopped: string[];
    already_stopped: string[];
    not_found: string[];
}
export interface TaskInfo {
    task_name: string;
    agent_count: number;
    running: number;
    completed: number;
    failed: number;
    stopped: number;
    workspace_dir: string | null;
    created_at: string;
    modified_at: string;
}
export interface TasksResult {
    tasks: TaskInfo[];
}
export declare function handleSpawn(manager: AgentManager, taskName: string, agentType: AgentType, prompt: string, cwd: string | null, mode: string | null, effort?: 'fast' | 'default' | 'detailed' | null, parentSessionId?: string | null, workspaceDir?: string | null, model?: string | null): Promise<SpawnResult>;
export declare function handleStatus(manager: AgentManager, taskName: string | null | undefined, filter?: string, since?: string, // Optional ISO timestamp - return only events after this time
parentSessionId?: string | null): Promise<TaskStatusResult>;
export declare function handleTasks(manager: AgentManager, limit?: number): Promise<TasksResult>;
export declare function handleStop(manager: AgentManager, taskName: string, agentId?: string): Promise<StopResult | {
    error: string;
}>;
export declare function handleReply(manager: AgentManager, agentId: string, message: string): Promise<ReplyResult>;
//# sourceMappingURL=api.d.ts.map