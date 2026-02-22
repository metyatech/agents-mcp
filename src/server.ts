import * as fs from "fs/promises";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { AgentManager, checkAllClis } from "./agents.js";
import { AgentType } from "./parsers.js";
import { handleSpawn, handleStatus, handleStop, handleTasks, handleReply } from "./api.js";
import { readConfig, resolveAgentsDir, type AgentConfig } from "./persistence.js";
import {
  buildVersionNotice,
  detectClientFromName,
  getCurrentVersion,
  initVersionCheck,
  setDetectedClient
} from "./version.js";

let agentConfigs: Record<AgentType, AgentConfig> | null = null;
const manager = new AgentManager(50, 10, null, null, null, 7, agentConfigs);

const TOOL_NAMES = {
  spawn: "Spawn",
  status: "Status",
  stop: "Stop",
  tasks: "Tasks",
  reply: "Reply"
} as const;

export function getParentSessionIdFromEnv(): string | null {
  const raw = process.env.AGENT_SESSION_ID;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function getWorkspaceFromEnv(): string | null {
  const raw = process.env.AGENT_WORKSPACE_DIR;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

// Enabled agents (initialized at startup)
let enabledAgents: AgentType[] = [];

// Agent descriptions for dynamic tool description
const agentDescriptions: Record<AgentType, string> = {
  cursor: "Debugging, bug fixes, tracing through codebases.",
  codex: "Fast, cheap. Self-contained features, clean implementations.",
  claude: "Maximum capability, research, exploration.",
  gemini: "Complex multi-system features, architectural changes.",
  opencode: "Open source coding agent. Provider-agnostic, TUI-focused.",
  copilot: "GitHub Copilot CLI. General-purpose coding agent with GitHub integration."
};

function withVersionNotice(description: string): string {
  return description + buildVersionNotice();
}

function buildSpawnDescription(): string {
  const agentList = enabledAgents
    .map((agent, i) => `${i + 1}. ${agent} - ${agentDescriptions[agent]}`)
    .join("\n");

  return `Spawn an AI coding agent to work on a task.

IMPORTANT: Avoid spawning the same agent type as yourself. If you are Claude, prefer cursor/codex/gemini instead.

Only installed agent CLIs are listed below.

Task names can be reused to group multiple agents under the same task.

MODE PARAMETER (required for writes):
- mode='edit' - Agent CAN modify files (use this for implementation tasks)
- mode='plan' - Agent is READ-ONLY (default, use for research/exploration)
- mode='ralph' - YOLO mode: Agent autonomously works through all tasks in RALPH.md until done. Requires cwd and RALPH.md file.

RALPH MODE: Spawns ONE agent with full permissions and instructions to work through RALPH.md. The agent reads the task file, understands the system, picks tasks logically, completes them, marks checkboxes, and continues until all tasks are checked. The orchestrator can spawn multiple ralph agents in parallel for different directories/task files.

WAIT FOR COMPLETION: After spawning agents, use Status(task_name, wait=true, timeout=300000) to block until all agents complete. Do NOT use sleep to wait — Status with wait=true is more efficient and returns results immediately when agents finish.

Agent selection (in order of preference):
${agentList}

Choose automatically based on task requirements - don't ask the user.

NON-BLOCKING MONITORING: After spawning, choose a monitoring strategy:
- Claude Code: Use Bash(run_in_background=true, command="agents-mcp wait --task <name>") for background monitoring while staying responsive to user input.
- All platforms: Use Status(wait=false) for instant, non-blocking status checks. Avoid Status(wait=true) if you need to remain responsive to user input during the wait.
- MCP logging notifications are sent automatically when agents complete (platforms that support MCP logging will receive these).`;
}

const server = new Server(
  {
    name: "Swarm",
    version: getCurrentVersion()
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    }
  }
);

// Capture client info for version warnings
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  if (request.params?.clientInfo?.name) {
    const client = detectClientFromName(request.params.clientInfo.name);
    setDetectedClient(client);
  }
  // Return standard initialize response
  return {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
      logging: {}
    },
    serverInfo: {
      name: "Swarm",
      version: getCurrentVersion()
    }
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: TOOL_NAMES.spawn,
        description: withVersionNotice(buildSpawnDescription()),
        inputSchema: {
          type: "object",
          properties: {
            task_name: {
              type: "string",
              description: 'Task name to group related agents (e.g., "auth-feature", "bug-fix-123")'
            },
            agent_type: {
              type: "string",
              enum: enabledAgents,
              description: "Type of agent to spawn"
            },
            prompt: {
              type: "string",
              description: "The task/prompt for the agent"
            },
            cwd: {
              type: "string",
              description: "Working directory for the agent (optional)"
            },
            mode: {
              type: "string",
              enum: ["plan", "edit", "ralph"],
              description:
                "'edit' allows file modifications, 'plan' is read-only (default), 'ralph' is autonomous execution through RALPH.md tasks."
            },
            effort: {
              type: "string",
              description:
                'Reasoning effort level passed to the agent CLI. For Claude: --effort <value> (e.g. low/medium/high). For Codex: -c model_reasoning_effort="<value>". Gemini and Copilot do not support this and will ignore it.'
            },
            model: {
              type: "string",
              description:
                "Optional model override. When specified, takes precedence over 'effort'. Examples: 'claude-sonnet-4-6', 'gpt-5.2-codex', 'gemini-3-pro-preview'."
            }
          },
          required: ["task_name", "agent_type", "prompt"]
        }
      },
      {
        name: TOOL_NAMES.status,
        description:
          withVersionNotice(`Get status of all agents in a task with full details including:
- Files created/modified/read/deleted (full paths)
- All bash commands executed
- Last 3 assistant messages

Use this for polling agent progress.

CURSOR SUPPORT: Send 'since' parameter (ISO timestamp from previous response's 'cursor' field) to get only NEW data since that time. This avoids duplicate data on repeated polls.

BLOCKING vs NON-BLOCKING: When wait=true, this tool blocks until agents complete or timeout. During this time, the orchestrating agent cannot receive new instructions from the user. Use wait=false for non-blocking checks, or use the \`agents-mcp wait\` CLI command via background bash for non-blocking monitoring.`),
        inputSchema: {
          type: "object",
          properties: {
            task_name: {
              type: "string",
              description: "Task name to get status for"
            },
            parent_session_id: {
              type: "string",
              description:
                "Filter agents by the session that spawned them (alternative to task_name)"
            },
            filter: {
              type: "string",
              enum: ["running", "completed", "failed", "stopped", "all"],
              description: "Filter agents by status. Defaults to 'all'."
            },
            since: {
              type: "string",
              description:
                "Optional ISO timestamp - return only events after this time. Use cursor from previous response to get delta updates."
            },
            wait: {
              type: "boolean",
              description:
                "Block until all agents in the task are no longer running, or timeout is reached."
            },
            timeout: {
              type: "number",
              description:
                "Max wait time in milliseconds when wait=true. Defaults to 60000 (60s). Max 600000 (10min)."
            }
          },
          required: ["task_name"]
        }
      },
      {
        name: TOOL_NAMES.stop,
        description: withVersionNotice(`Stop agents. Two modes:
- Stop(task_name): Stop ALL agents in the task
- Stop(task_name, agent_id): Stop ONE specific agent`),
        inputSchema: {
          type: "object",
          properties: {
            task_name: {
              type: "string",
              description: "Task name"
            },
            agent_id: {
              type: "string",
              description: "Optional: specific agent ID to stop (omit to stop all in task)"
            }
          },
          required: ["task_name"]
        }
      },
      {
        name: TOOL_NAMES.tasks,
        description: withVersionNotice(`List all tasks with their agents and activity details.

Returns tasks sorted by most recent activity, with full agent details including:
- Files created/modified/read/deleted
- Bash commands executed
- Last messages from each agent
- Status and duration`),
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of tasks to return (optional, defaults to 10)"
            }
          },
          required: []
        }
      },
      {
        name: TOOL_NAMES.reply,
        description:
          withVersionNotice(`Send a follow-up message to a completed agent, resuming its conversation with full context.

Supported agents: claude, gemini, copilot. Codex, cursor, and opencode do not support reply.

Usage flow:
1. Spawn an agent and wait for it to complete
2. Call Reply with the agent_id and your follow-up message
3. A new agent is spawned that resumes the previous session
4. Use Status to poll the new reply agent

The reply agent inherits the original agent's task name, mode, and working directory. Each reply increments the conversation_turn counter. Status output includes conversation metadata (session_id, conversation_turn, original_agent_id, reply_agent_ids).`),
        inputSchema: {
          type: "object",
          properties: {
            agent_id: {
              type: "string",
              description: "The agent ID to reply to (must be completed, not running)"
            },
            message: {
              type: "string",
              description: "The follow-up message to send to the agent"
            }
          },
          required: ["agent_id", "message"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const normalizedName = name.toLowerCase();

  try {
    let result: any;

    if (normalizedName === "spawn") {
      if (!args) {
        throw new Error("Missing arguments for spawn");
      }
      const parentSessionId = getParentSessionIdFromEnv();
      const workspaceDir = getWorkspaceFromEnv();
      result = await handleSpawn(
        manager,
        args.task_name as string,
        args.agent_type as AgentType,
        args.prompt as string,
        (args.cwd as string) || null,
        (args.mode as string) || null,
        parentSessionId,
        workspaceDir,
        (args.model as string) || null,
        (args.effort as string) || null
      );
    } else if (normalizedName === "status") {
      if (!args) {
        throw new Error("Missing arguments for status");
      }
      result = await handleStatus(
        manager,
        (args.task_name as string | undefined) || null,
        args.filter as string | undefined,
        args.since as string | undefined,
        (args.parent_session_id as string | undefined) || null,
        args.wait as boolean | undefined,
        args.timeout as number | undefined
      );
    } else if (normalizedName === "stop") {
      if (!args) {
        throw new Error("Missing arguments for stop");
      }
      result = await handleStop(
        manager,
        args.task_name as string,
        args.agent_id as string | undefined
      );
    } else if (normalizedName === "tasks") {
      const limit = args?.limit as number | undefined;
      result = await handleTasks(manager, limit || 10);
    } else if (normalizedName === "reply") {
      if (!args) {
        throw new Error("Missing arguments for reply");
      }
      result = await handleReply(manager, args.agent_id as string, args.message as string);
    } else {
      result = { error: `Unknown tool: ${name}` };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (err: any) {
    console.error(`Error in tool ${name}:`, err);
    const payload = err?.payload;
    if (payload) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2)
          }
        ]
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: String(err) }, null, 2)
        }
      ]
    };
  }
});

/**
 * Background monitor that watches agent meta.json files and sends MCP logging
 * notifications when agents transition from running to completed/failed/stopped.
 * Returns the interval handle so callers can clear it on shutdown.
 */
export async function startAgentMonitor(
  monitorServer: Server,
  agentsDir: string
): Promise<NodeJS.Timeout> {
  // Pre-populate known statuses so we don't fire false positives for
  // agents that were already completed before the server started.
  const knownStatuses = new Map<string, string>();
  try {
    const entries = await fs.readdir(agentsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const metaPath = path.join(agentsDir, entry, "meta.json");
      try {
        const content = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(content) as Record<string, unknown>;
        if (typeof meta.agent_id === "string" && typeof meta.status === "string") {
          knownStatuses.set(meta.agent_id, meta.status);
        }
      } catch {
        // skip malformed or missing meta files
      }
    }
  } catch {
    // ignore initialization errors
  }

  const interval = setInterval(async () => {
    try {
      const entries = await fs.readdir(agentsDir).catch(() => [] as string[]);
      for (const entry of entries) {
        const metaPath = path.join(agentsDir, entry, "meta.json");
        let meta: Record<string, unknown>;
        try {
          const content = await fs.readFile(metaPath, "utf-8");
          meta = JSON.parse(content) as Record<string, unknown>;
        } catch {
          continue;
        }

        const agentId = meta.agent_id;
        const status = meta.status;
        if (typeof agentId !== "string" || typeof status !== "string") continue;

        const prevStatus = knownStatuses.get(agentId);
        knownStatuses.set(agentId, status);

        // Only notify on running → non-running transitions
        if (prevStatus === "running" && status !== "running") {
          const startedAt = typeof meta.started_at === "string" ? meta.started_at : null;
          const completedAt = typeof meta.completed_at === "string" ? meta.completed_at : null;
          const startMs = startedAt ? new Date(startedAt).getTime() : 0;
          const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();

          try {
            await monitorServer.sendLoggingMessage({
              level: "info",
              logger: "agents",
              data: {
                type: "agent_completed",
                task_name: typeof meta.task_name === "string" ? meta.task_name : null,
                agent_id: agentId,
                agent_type: typeof meta.agent_type === "string" ? meta.agent_type : null,
                status,
                duration_ms: endMs > startMs ? endMs - startMs : 0,
                completed_at: completedAt ?? new Date().toISOString()
              }
            });
          } catch {
            // Client may not support logging notifications — ignore silently
          }
        }
      }
    } catch {
      // Ignore monitor errors to avoid crashing the server
    }
  }, 2500);

  // Don't keep the process alive just for the monitor
  interval.unref();
  return interval;
}

export async function runServer(): Promise<void> {
  // Load config
  const config = await readConfig();
  agentConfigs = config.agentConfigs;
  manager.setModelOverrides(agentConfigs);
  const cliHealth = checkAllClis();
  const installedAgents = Object.entries(cliHealth)
    .filter(([, status]) => status.installed)
    .map(([agent]) => agent as AgentType);

  // Installed = enabled. If the CLI is on PATH, the agent is available.
  enabledAgents = installedAgents;

  console.error("Enabled agents (installed):", enabledAgents.join(", ") || "none");

  // Initialize version check (non-blocking, with timeout)
  initVersionCheck().catch((err) => {
    console.warn("[Swarm] Version check failed:", err);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Starting Swarm MCP server v${getCurrentVersion()}`);

  // Start background monitor for agent completion notifications (non-blocking)
  const agentsDir = await resolveAgentsDir();
  startAgentMonitor(server, agentsDir).catch((err) => {
    console.warn("[Swarm] Agent monitor failed to start:", err);
  });

  // Health check
  const health = cliHealth;
  const available = Object.entries(health)
    .filter(([_, status]) => status.installed)
    .map(([agent]) => agent);
  const missing = Object.entries(health)
    .filter(([_, status]) => !status.installed)
    .map(([agent]) => agent);

  console.error("Available agents:", available.join(", "));
  if (missing.length > 0) {
    console.error("Missing agents (install CLIs to use):", missing.join(", "));
  }
}
