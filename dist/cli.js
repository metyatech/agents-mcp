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
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
const WAIT_POLL_INTERVAL_MS = 1000;
const WAIT_DEFAULT_TIMEOUT_MS = 300_000;
const WAIT_MAX_TIMEOUT_MS = 600_000;
// ============================================================
// Agent directory resolution (mirrors persistence.ts)
// ============================================================
function getPrimaryAgentsDir() {
    return path.join(homedir(), ".agents", "swarm", "agents");
}
async function resolveAgentsDir() {
    const primary = getPrimaryAgentsDir();
    try {
        await fs.mkdir(primary, { recursive: true });
        return primary;
    }
    catch {
        const fallback = path.join(tmpdir(), "agents", "swarm", "agents");
        await fs.mkdir(fallback, { recursive: true }).catch(() => { });
        return fallback;
    }
}
// ============================================================
// Process liveness check (cross-platform)
// ============================================================
function isProcessAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        // process.kill(pid, 0) works on both Windows and Unix in Node.js.
        // Returns undefined if process exists, throws ESRCH if not.
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function computeDuration(startedAt, completedAt) {
    const start = new Date(startedAt).getTime();
    if (isNaN(start))
        return null;
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    if (isNaN(end))
        return null;
    const seconds = (end - start) / 1000;
    if (seconds < 60)
        return `${Math.floor(seconds)} seconds`;
    return `${(seconds / 60).toFixed(1)} minutes`;
}
async function readAgentMeta(agentsDir, agentId) {
    const metaPath = path.join(agentsDir, agentId, "meta.json");
    try {
        const content = await fs.readFile(metaPath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
export async function getTaskAgents(taskName, agentsDir) {
    const dir = agentsDir ?? (await resolveAgentsDir());
    const results = [];
    let entries;
    try {
        entries = await fs.readdir(dir);
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat?.isDirectory())
            continue;
        const meta = await readAgentMeta(dir, entry);
        if (!meta || meta.task_name !== taskName)
            continue;
        // Re-check process liveness for agents still marked as running
        let effectiveStatus = meta.status;
        if (effectiveStatus === "running" && meta.pid && !isProcessAlive(meta.pid)) {
            // Process is gone but meta says running — treat as completed (conservative guess)
            effectiveStatus = "completed";
        }
        results.push({
            agent_id: meta.agent_id,
            task_name: meta.task_name,
            agent_type: meta.agent_type,
            status: effectiveStatus,
            duration: computeDuration(meta.started_at, meta.completed_at),
            started_at: meta.started_at,
            completed_at: meta.completed_at
        });
    }
    return results;
}
function sumStatusCounts(agents) {
    const counts = { running: 0, completed: 0, failed: 0, stopped: 0 };
    for (const a of agents) {
        if (a.status === "running")
            counts.running++;
        else if (a.status === "completed")
            counts.completed++;
        else if (a.status === "failed")
            counts.failed++;
        else if (a.status === "stopped")
            counts.stopped++;
    }
    return counts;
}
export function parseCliArgs(argv) {
    const args = argv.slice(2); // skip node + script path
    let subcommand = null;
    let taskName = null;
    let timeout = WAIT_DEFAULT_TIMEOUT_MS;
    let help = false;
    let i = 0;
    if (args.length > 0 && !args[0].startsWith("-")) {
        subcommand = args[0];
        i = 1;
    }
    while (i < args.length) {
        const arg = args[i];
        if ((arg === "--task" || arg === "-t") && i + 1 < args.length) {
            taskName = args[++i];
        }
        else if (arg === "--timeout" && i + 1 < args.length) {
            const ms = parseInt(args[++i], 10);
            if (!isNaN(ms) && ms > 0)
                timeout = Math.min(ms, WAIT_MAX_TIMEOUT_MS);
        }
        else if (arg === "--help" || arg === "-h") {
            help = true;
        }
        i++;
    }
    return { subcommand, taskName, timeout, help };
}
function printHelp() {
    process.stderr.write(`Usage: agents-mcp [subcommand] [options]

Subcommands:
  status  --task <name>            Instant status check, returns immediately
  wait    --task <name>            Poll until all agents complete or timeout
  (none)                           Start MCP server (default)

Options:
  --task, -t <name>   Task name to monitor
  --timeout <ms>      Wait timeout in ms (default: ${WAIT_DEFAULT_TIMEOUT_MS}, max: ${WAIT_MAX_TIMEOUT_MS})
  --help, -h          Show this help

Exit codes:
  0   All agents completed (or MCP server exited normally)
  1   Timeout or error
  2   No agents found for task
`);
}
// ============================================================
// Exported command implementations (importable as module)
// ============================================================
export async function runStatusCommand(taskName, agentsDir) {
    const agents = await getTaskAgents(taskName, agentsDir);
    const summary = sumStatusCounts(agents);
    return { task_name: taskName, agents, summary, timed_out: false };
}
export async function runWaitCommand(taskName, timeout = WAIT_DEFAULT_TIMEOUT_MS, agentsDir) {
    const effectiveTimeout = Math.min(timeout, WAIT_MAX_TIMEOUT_MS);
    const deadline = Date.now() + effectiveTimeout;
    let agents = await getTaskAgents(taskName, agentsDir);
    let summary = sumStatusCounts(agents);
    while (summary.running > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
        agents = await getTaskAgents(taskName, agentsDir);
        summary = sumStatusCounts(agents);
    }
    const timedOut = summary.running > 0;
    return { task_name: taskName, agents, summary, timed_out: timedOut };
}
// ============================================================
// Main execution (only when run directly, not when imported)
// ============================================================
function checkIsMain() {
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const argv1 = process.argv[1];
        if (!argv1)
            return false;
        return path.resolve(thisFile) === path.resolve(argv1);
    }
    catch {
        // If we can't determine, assume we're the main module
        return true;
    }
}
async function main() {
    const { subcommand, taskName, timeout, help } = parseCliArgs(process.argv);
    if (subcommand === "status" || subcommand === "wait") {
        if (help) {
            printHelp();
            process.exit(0);
        }
        if (!taskName) {
            process.stderr.write("Error: --task <name> is required\n");
            process.exit(1);
        }
        if (subcommand === "status") {
            const result = await runStatusCommand(taskName);
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
            process.exit(result.agents.length === 0 ? 2 : 0);
        }
        else {
            process.stderr.write(`[agents-mcp] Waiting for task "${taskName}" (timeout: ${timeout}ms)...\n`);
            const result = await runWaitCommand(taskName, timeout);
            process.stdout.write(JSON.stringify(result, null, 2) + "\n");
            if (result.timed_out) {
                process.stderr.write(`[agents-mcp] Timed out with ${result.summary.running} agent(s) still running\n`);
                process.exit(1);
            }
            process.exit(result.agents.length === 0 ? 2 : 0);
        }
    }
    else {
        // MCP server mode — same signal handlers as original index.ts
        if (help) {
            printHelp();
            process.exit(0);
        }
        process.on("SIGTERM", () => {
            console.error("MCP server received SIGTERM");
            process.exit(128 + 15);
        });
        process.on("SIGINT", () => {
            console.error("MCP server received SIGINT");
            process.exit(128 + 2);
        });
        process.on("SIGPIPE", () => { });
        process.on("exit", () => {
            console.error("MCP server exiting");
        });
        const { runServer } = await import("./server.js");
        await runServer();
    }
}
if (checkIsMain()) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Fatal error:", message);
        process.exit(1);
    });
}
//# sourceMappingURL=cli.js.map