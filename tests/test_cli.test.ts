/**
 * Tests for CLI commands: getTaskAgents, runStatusCommand, runWaitCommand, parseCliArgs
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { getTaskAgents, runStatusCommand, runWaitCommand, parseCliArgs } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeMetaJson(
  agentsDir: string,
  agentId: string,
  meta: Record<string, unknown>
): Promise<void> {
  const agentDir = path.join(agentsDir, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "meta.json"), JSON.stringify(meta), "utf-8");
}

function makeMeta(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    agent_id: "agent-001",
    task_name: "my-task",
    agent_type: "codex",
    status: "completed",
    pid: null,
    started_at: new Date("2025-01-01T10:00:00Z").toISOString(),
    completed_at: new Date("2025-01-01T10:01:00Z").toISOString(),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("getTaskAgents", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = path.join(
      tmpdir(),
      `cli_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(agentsDir, { recursive: true, force: true });
  });

  test("returns empty array when no agents exist", async () => {
    const result = await getTaskAgents("any-task", agentsDir);
    expect(result).toEqual([]);
  });

  test("returns empty array when directory does not exist", async () => {
    const nonexistent = path.join(tmpdir(), "does-not-exist-xyz");
    const result = await getTaskAgents("any-task", nonexistent);
    expect(result).toEqual([]);
  });

  test("returns only agents matching the task name", async () => {
    await writeMetaJson(
      agentsDir,
      "agent-a",
      makeMeta({ agent_id: "agent-a", task_name: "task-A" })
    );
    await writeMetaJson(
      agentsDir,
      "agent-b",
      makeMeta({ agent_id: "agent-b", task_name: "task-B" })
    );
    await writeMetaJson(
      agentsDir,
      "agent-c",
      makeMeta({ agent_id: "agent-c", task_name: "task-A" })
    );

    const result = await getTaskAgents("task-A", agentsDir);
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.agent_id).sort();
    expect(ids).toEqual(["agent-a", "agent-c"]);
  });

  test("returns correct AgentStatusInfo fields", async () => {
    const startedAt = new Date("2025-06-01T09:00:00Z").toISOString();
    const completedAt = new Date("2025-06-01T09:02:00Z").toISOString();
    await writeMetaJson(
      agentsDir,
      "agent-z",
      makeMeta({
        agent_id: "agent-z",
        task_name: "info-task",
        agent_type: "gemini",
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt
      })
    );

    const [info] = await getTaskAgents("info-task", agentsDir);
    expect(info.agent_id).toBe("agent-z");
    expect(info.task_name).toBe("info-task");
    expect(info.agent_type).toBe("gemini");
    expect(info.status).toBe("completed");
    expect(info.started_at).toBe(startedAt);
    expect(info.completed_at).toBe(completedAt);
  });

  test("detects dead process and reports status as completed", async () => {
    // Use a PID that is extremely unlikely to exist (max PID is 4194304 on Linux,
    // but we pick a safe large value). process.kill(pid, 0) will throw ESRCH.
    const deadPid = 99_999_991;
    await writeMetaJson(
      agentsDir,
      "dead-agent",
      makeMeta({
        agent_id: "dead-agent",
        task_name: "dead-task",
        status: "running",
        pid: deadPid,
        completed_at: null
      })
    );

    const [info] = await getTaskAgents("dead-task", agentsDir);
    // The process is dead, so the status should be overridden to "completed"
    expect(info.status).toBe("completed");
  });

  test("keeps status running when process is alive (current process)", async () => {
    await writeMetaJson(
      agentsDir,
      "alive-agent",
      makeMeta({
        agent_id: "alive-agent",
        task_name: "alive-task",
        status: "running",
        pid: process.pid, // current process is definitely alive
        completed_at: null
      })
    );

    const [info] = await getTaskAgents("alive-task", agentsDir);
    expect(info.status).toBe("running");
  });

  test("computes duration correctly for completed agent", async () => {
    const startedAt = new Date("2025-01-01T10:00:00Z").toISOString();
    const completedAt = new Date("2025-01-01T10:02:30Z").toISOString(); // 150 seconds later
    await writeMetaJson(
      agentsDir,
      "dur-agent",
      makeMeta({
        agent_id: "dur-agent",
        task_name: "dur-task",
        started_at: startedAt,
        completed_at: completedAt,
        status: "completed"
      })
    );

    const [info] = await getTaskAgents("dur-task", agentsDir);
    // 150 seconds = 2.5 minutes
    expect(info.duration).toBe("2.5 minutes");
  });

  test("computes duration in seconds for short-running agent", async () => {
    const startedAt = new Date("2025-01-01T10:00:00Z").toISOString();
    const completedAt = new Date("2025-01-01T10:00:45Z").toISOString(); // 45 seconds
    await writeMetaJson(
      agentsDir,
      "short-agent",
      makeMeta({
        agent_id: "short-agent",
        task_name: "short-task",
        started_at: startedAt,
        completed_at: completedAt,
        status: "completed"
      })
    );

    const [info] = await getTaskAgents("short-task", agentsDir);
    expect(info.duration).toBe("45 seconds");
  });

  test("skips entries that are not directories", async () => {
    // Create a plain file (not a directory) at the top level of agentsDir
    await fs.writeFile(path.join(agentsDir, "not-a-dir.txt"), "junk");
    await writeMetaJson(
      agentsDir,
      "real-agent",
      makeMeta({ agent_id: "real-agent", task_name: "skip-task" })
    );

    const result = await getTaskAgents("skip-task", agentsDir);
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe("real-agent");
  });

  test("skips agent directories with missing meta.json", async () => {
    // Directory with no meta.json
    await fs.mkdir(path.join(agentsDir, "no-meta"), { recursive: true });
    await writeMetaJson(
      agentsDir,
      "good-agent",
      makeMeta({ agent_id: "good-agent", task_name: "meta-task" })
    );

    const result = await getTaskAgents("meta-task", agentsDir);
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe("good-agent");
  });

  test("skips agent directories with malformed meta.json", async () => {
    const badDir = path.join(agentsDir, "bad-json-agent");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "meta.json"), "{ not valid json", "utf-8");
    await writeMetaJson(
      agentsDir,
      "good-agent2",
      makeMeta({ agent_id: "good-agent2", task_name: "bad-task" })
    );

    const result = await getTaskAgents("bad-task", agentsDir);
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe("good-agent2");
  });
});

// ---------------------------------------------------------------------------

describe("runStatusCommand", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = path.join(tmpdir(), `cli_sc_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(agentsDir, { recursive: true, force: true });
  });

  test("returns correct TaskStatusOutput structure with empty summary when no agents", async () => {
    const result = await runStatusCommand("no-agents-task", agentsDir);

    expect(result.task_name).toBe("no-agents-task");
    expect(result.agents).toEqual([]);
    expect(result.timed_out).toBe(false);
    expect(result.summary).toEqual({ running: 0, completed: 0, failed: 0, stopped: 0 });
  });

  test("returns correct summary counts for mixed-status agents", async () => {
    await writeMetaJson(
      agentsDir,
      "a1",
      makeMeta({
        agent_id: "a1",
        task_name: "count-task",
        status: "running",
        pid: process.pid,
        completed_at: null
      })
    );
    await writeMetaJson(
      agentsDir,
      "a2",
      makeMeta({ agent_id: "a2", task_name: "count-task", status: "completed" })
    );
    await writeMetaJson(
      agentsDir,
      "a3",
      makeMeta({ agent_id: "a3", task_name: "count-task", status: "failed" })
    );
    await writeMetaJson(
      agentsDir,
      "a4",
      makeMeta({ agent_id: "a4", task_name: "count-task", status: "stopped" })
    );
    await writeMetaJson(
      agentsDir,
      "a5",
      makeMeta({
        agent_id: "a5",
        task_name: "other-task",
        status: "running",
        pid: process.pid,
        completed_at: null
      })
    );

    const result = await runStatusCommand("count-task", agentsDir);

    expect(result.task_name).toBe("count-task");
    expect(result.agents).toHaveLength(4);
    expect(result.summary.running).toBe(1);
    expect(result.summary.completed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.stopped).toBe(1);
    expect(result.timed_out).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("runWaitCommand", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = path.join(tmpdir(), `cli_wc_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(agentsDir, { recursive: true, force: true });
  });

  test("returns immediately when no agents are running", async () => {
    const before = Date.now();
    const result = await runWaitCommand("empty-task", 5000, agentsDir);
    const elapsed = Date.now() - before;

    expect(result.task_name).toBe("empty-task");
    expect(result.timed_out).toBe(false);
    expect(result.summary.running).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  test("returns immediately when all agents are already completed", async () => {
    await writeMetaJson(
      agentsDir,
      "done-agent",
      makeMeta({ agent_id: "done-agent", task_name: "done-task", status: "completed" })
    );

    const before = Date.now();
    const result = await runWaitCommand("done-task", 5000, agentsDir);
    const elapsed = Date.now() - before;

    expect(result.timed_out).toBe(false);
    expect(result.summary.completed).toBe(1);
    expect(result.summary.running).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  test("sets timed_out=true when agents remain running past timeout", async () => {
    // Use current process PID so the agent stays "running"
    await writeMetaJson(
      agentsDir,
      "stuck-agent",
      makeMeta({
        agent_id: "stuck-agent",
        task_name: "stuck-task",
        status: "running",
        pid: process.pid,
        completed_at: null
      })
    );

    // timeout=50ms means deadline expires well before the 1000ms poll interval,
    // so one poll cycle (~1000ms) is all that runs before the loop exits
    const before = Date.now();
    const result = await runWaitCommand("stuck-task", 50, agentsDir);
    const elapsed = Date.now() - before;

    expect(result.timed_out).toBe(true);
    expect(result.summary.running).toBe(1);
    // Should finish in one poll cycle (<=1500ms with some slack)
    expect(elapsed).toBeLessThan(1500);
  }, 10_000);

  test("waits and detects agent completion mid-wait", async () => {
    // Write a running agent
    await writeMetaJson(
      agentsDir,
      "finishing-agent",
      makeMeta({
        agent_id: "finishing-agent",
        task_name: "finishing-task",
        status: "running",
        pid: 99_999_991, // dead PID so liveness check marks it completed
        completed_at: null
      })
    );

    // The dead PID causes getTaskAgents to report status="completed",
    // so runWaitCommand should detect no running agents and return immediately
    const result = await runWaitCommand("finishing-task", 5000, agentsDir);

    expect(result.timed_out).toBe(false);
    expect(result.summary.running).toBe(0);
    // The agent was "running" in meta but has a dead PID → reported as completed
    expect(result.summary.completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  test("parses status subcommand with --task", () => {
    const result = parseCliArgs(["node", "cli.js", "status", "--task", "my-task"]);
    expect(result.subcommand).toBe("status");
    expect(result.taskName).toBe("my-task");
    expect(result.help).toBe(false);
  });

  test("parses wait subcommand with --task and --timeout", () => {
    const result = parseCliArgs([
      "node",
      "cli.js",
      "wait",
      "--task",
      "my-task",
      "--timeout",
      "10000"
    ]);
    expect(result.subcommand).toBe("wait");
    expect(result.taskName).toBe("my-task");
    expect(result.timeout).toBe(10000);
  });

  test("clamps timeout to max 600000ms", () => {
    const result = parseCliArgs([
      "node",
      "cli.js",
      "wait",
      "--task",
      "t",
      "--timeout",
      "999999999"
    ]);
    expect(result.timeout).toBe(600_000);
  });

  test("sets default timeout when not specified", () => {
    const result = parseCliArgs(["node", "cli.js", "wait", "--task", "t"]);
    expect(result.timeout).toBe(300_000);
  });

  test("sets help=true when --help is present", () => {
    const result = parseCliArgs(["node", "cli.js", "status", "--help"]);
    expect(result.help).toBe(true);
  });

  test("sets help=true when -h shorthand is used", () => {
    const result = parseCliArgs(["node", "cli.js", "-h"]);
    expect(result.help).toBe(true);
  });

  test("accepts -t as shorthand for --task", () => {
    const result = parseCliArgs(["node", "cli.js", "status", "-t", "shorthand-task"]);
    expect(result.taskName).toBe("shorthand-task");
  });

  test("returns null taskName when --task is missing", () => {
    const result = parseCliArgs(["node", "cli.js", "status"]);
    expect(result.taskName).toBeNull();
  });

  test("returns null subcommand when only flags are provided (MCP server mode)", () => {
    const result = parseCliArgs(["node", "cli.js", "--task", "t"]);
    expect(result.subcommand).toBeNull();
    expect(result.taskName).toBe("t");
  });

  test("returns all nulls for empty argv", () => {
    const result = parseCliArgs(["node", "cli.js"]);
    expect(result.subcommand).toBeNull();
    expect(result.taskName).toBeNull();
    expect(result.help).toBe(false);
  });

  test("ignores invalid --timeout values", () => {
    const result = parseCliArgs([
      "node",
      "cli.js",
      "wait",
      "--task",
      "t",
      "--timeout",
      "notanumber"
    ]);
    // Should fall back to default
    expect(result.timeout).toBe(300_000);
  });

  test("ignores zero --timeout value", () => {
    const result = parseCliArgs(["node", "cli.js", "wait", "--task", "t", "--timeout", "0"]);
    // 0 is not > 0, so default is kept
    expect(result.timeout).toBe(300_000);
  });
});
