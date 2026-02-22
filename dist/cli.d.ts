#!/usr/bin/env node
/**
 * Unified CLI and MCP server entry point for agents-mcp.
 *
 * Subcommands:
 *   status  --task <name>                Instant status check, returns immediately
 *   wait    --task <name> [--timeout ms] Poll until all agents complete or timeout
 *
 * Default (no subcommand): starts the MCP server (original behavior).
 *
 * Exported functions can be imported for programmatic use.
 */
export interface AgentStatusInfo {
    agent_id: string;
    task_name: string;
    agent_type: string;
    status: string;
    duration: string | null;
    started_at: string;
    completed_at: string | null;
}
export interface TaskStatusOutput {
    task_name: string;
    agents: AgentStatusInfo[];
    summary: {
        running: number;
        completed: number;
        failed: number;
        stopped: number;
    };
    timed_out: boolean;
}
export declare function getTaskAgents(taskName: string, agentsDir?: string): Promise<AgentStatusInfo[]>;
interface ParsedArgs {
    subcommand: string | null;
    taskName: string | null;
    timeout: number;
    help: boolean;
}
export declare function parseCliArgs(argv: string[]): ParsedArgs;
export declare function runStatusCommand(taskName: string, agentsDir?: string): Promise<TaskStatusOutput>;
export declare function runWaitCommand(taskName: string, timeout?: number, agentsDir?: string): Promise<TaskStatusOutput>;
export {};
//# sourceMappingURL=cli.d.ts.map