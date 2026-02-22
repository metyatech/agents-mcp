import { Server } from "@modelcontextprotocol/sdk/server/index.js";
export declare function getParentSessionIdFromEnv(): string | null;
export declare function getWorkspaceFromEnv(): string | null;
/**
 * Background monitor that watches agent meta.json files and sends MCP logging
 * notifications when agents transition from running to completed/failed/stopped.
 * Returns the interval handle so callers can clear it on shutdown.
 */
export declare function startAgentMonitor(monitorServer: Server, agentsDir: string): Promise<NodeJS.Timeout>;
export declare function runServer(): Promise<void>;
//# sourceMappingURL=server.d.ts.map