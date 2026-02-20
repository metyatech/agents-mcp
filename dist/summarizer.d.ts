export declare function getErrorSnippets(events: any[], maxItems?: number): string[];
export declare const PRIORITY: Record<string, string[]>;
/**
 * Collapse sequential events of the same type into summary entries.
 * Returns a cleaner list of events suitable for output.
 */
export declare function collapseEvents(events: any[], maxEvents?: number): any[];
/**
 * Get a breakdown of tool calls by type.
 */
export declare function getToolBreakdown(events: any[]): Record<string, number>;
export declare function groupAndFlattenEvents(events: any[]): any[];
export declare class AgentSummary {
    agentId: string;
    agentType: string;
    status: string;
    duration: string | null;
    filesModified: Set<string>;
    filesCreated: Set<string>;
    filesRead: Set<string>;
    filesDeleted: Set<string>;
    toolsUsed: Set<string>;
    toolCallCount: number;
    bashCommands: string[];
    errors: string[];
    warnings: string[];
    finalMessage: string | null;
    eventCount: number;
    lastActivity: string | null;
    eventsCache: any[];
    constructor(agentId: string, agentType: string, status: string, duration?: string | null, eventCount?: number);
    toDict(detailLevel?: 'brief' | 'standard' | 'detailed'): any;
    private truncate;
}
export declare function summarizeEvents(agentId: string, agentType: string, status: string, events: any[], duration?: string | null): AgentSummary;
export declare function getDelta(agentId: string, agentType: string, status: string, events: any[], since?: string | number): any;
export declare function filterEventsByPriority(events: any[], includeLevels?: string[] | null): any[];
export declare function getLastTool(events: any[]): string | null;
export interface QuickStatus {
    agent_id: string;
    agent_type: string;
    status: string;
    files_created: number;
    files_modified: number;
    files_deleted: number;
    files_read: number;
    tool_count: number;
    last_commands: string[];
    has_errors: boolean;
    last_message: string | null;
}
export declare function getToolUses(events: any[]): Array<{
    tool: string;
    args: any;
}>;
export declare function getLastMessages(events: any[], count?: number): string[];
export declare function getQuickStatus(agentId: string, agentType: string, status: string, events: any[]): QuickStatus;
export declare function getStatusSummary(agentId: string, agentType: string, status: string, events: any[], duration?: string | null): string;
//# sourceMappingURL=summarizer.d.ts.map