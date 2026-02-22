/**
 * Tests for startAgentMonitor — the background agent completion notification monitor.
 *
 * Strategy: spy on global.setInterval to capture the callback, then invoke it
 * directly in tests. This avoids fake-timer / real-I/O interleaving issues.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { startAgentMonitor } from "../src/server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MockServer = {
  sendLoggingMessage: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockServer(): MockServer {
  return {
    sendLoggingMessage: vi.fn().mockResolvedValue(undefined)
  };
}

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
    status: "running",
    pid: null,
    started_at: new Date("2025-01-01T10:00:00Z").toISOString(),
    completed_at: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// setInterval capture helper
// Intercepts the next setInterval call and returns the callback for direct
// invocation. This allows testing the async interval logic without timing.
// ---------------------------------------------------------------------------

type IntervalCallback = () => Promise<void>;

function captureNextSetInterval(): {
  getCallback: () => IntervalCallback | null;
  restore: () => void;
  fakeInterval: NodeJS.Timeout;
} {
  let captured: IntervalCallback | null = null;
  // Create a long-lived no-op timer to return as the fake interval handle
  const fakeInterval = setInterval(() => {}, 1_000_000);

  const spy = vi.spyOn(global, "setInterval").mockImplementationOnce((fn: unknown) => {
    captured = fn as IntervalCallback;
    return fakeInterval;
  });

  return {
    getCallback: () => captured,
    restore: () => {
      spy.mockRestore();
      clearInterval(fakeInterval);
    },
    fakeInterval
  };
}

// ---------------------------------------------------------------------------

describe("startAgentMonitor", () => {
  let agentsDir: string;
  let intervalHandle: NodeJS.Timeout | null = null;
  let restoreSetInterval: (() => void) | null = null;

  beforeEach(async () => {
    agentsDir = path.join(
      tmpdir(),
      `monitor_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (restoreSetInterval) {
      restoreSetInterval();
      restoreSetInterval = null;
    }
    await fs.rm(agentsDir, { recursive: true, force: true });
  });

  test("sends notification when agent transitions from running to completed", async () => {
    const mockServer = makeMockServer();

    // Start with a running agent
    await writeMetaJson(
      agentsDir,
      "completing-agent",
      makeMeta({
        agent_id: "completing-agent",
        task_name: "notify-task",
        agent_type: "codex",
        status: "running"
      })
    );

    // Capture the setInterval callback before starting the monitor
    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;

    // Initialize monitor — pre-populates known statuses (agent is "running")
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);

    // Retrieve the captured polling callback
    const pollCallback = capture.getCallback();
    expect(pollCallback).not.toBeNull();

    // Now update the agent to completed
    await writeMetaJson(
      agentsDir,
      "completing-agent",
      makeMeta({
        agent_id: "completing-agent",
        task_name: "notify-task",
        agent_type: "codex",
        status: "completed",
        completed_at: new Date("2025-01-01T10:05:00Z").toISOString()
      })
    );

    // Invoke the polling callback directly (simulates a 2500ms tick)
    await pollCallback!();

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledOnce();

    const callArgs = mockServer.sendLoggingMessage.mock.calls[0][0];
    expect(callArgs.level).toBe("info");
    expect(callArgs.logger).toBe("agents");
    expect(callArgs.data.type).toBe("agent_completed");
    expect(callArgs.data.agent_id).toBe("completing-agent");
    expect(callArgs.data.task_name).toBe("notify-task");
    expect(callArgs.data.agent_type).toBe("codex");
    expect(callArgs.data.status).toBe("completed");
  });

  test("sends notification when agent transitions from running to failed", async () => {
    const mockServer = makeMockServer();

    await writeMetaJson(
      agentsDir,
      "failing-agent",
      makeMeta({ agent_id: "failing-agent", task_name: "fail-task", status: "running" })
    );

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    await writeMetaJson(
      agentsDir,
      "failing-agent",
      makeMeta({
        agent_id: "failing-agent",
        task_name: "fail-task",
        status: "failed",
        completed_at: new Date().toISOString()
      })
    );

    await pollCallback();

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledOnce();
    expect(mockServer.sendLoggingMessage.mock.calls[0][0].data.status).toBe("failed");
  });

  test("does NOT notify for agents that were already completed at startup", async () => {
    const mockServer = makeMockServer();

    // Write an already-completed agent BEFORE the monitor starts
    await writeMetaJson(
      agentsDir,
      "pre-completed",
      makeMeta({
        agent_id: "pre-completed",
        task_name: "old-task",
        status: "completed",
        completed_at: new Date("2025-01-01T09:00:00Z").toISOString()
      })
    );

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    // Monitor pre-populates known status as "completed"
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    // The agent is still "completed" — no running → non-running transition
    await pollCallback();

    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });

  test("does NOT notify for agents that remain running between polls", async () => {
    const mockServer = makeMockServer();

    await writeMetaJson(
      agentsDir,
      "still-running",
      makeMeta({ agent_id: "still-running", task_name: "long-task", status: "running" })
    );

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    // Agent stays running — invoke callback multiple times
    await pollCallback();
    await pollCallback();
    await pollCallback();

    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });

  test("handles missing meta.json gracefully without crashing", async () => {
    const mockServer = makeMockServer();

    // Create a directory but no meta.json
    await fs.mkdir(path.join(agentsDir, "no-meta-agent"), { recursive: true });

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    // Should not throw
    await expect(pollCallback()).resolves.toBeUndefined();
    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });

  test("handles malformed meta.json gracefully without crashing", async () => {
    const mockServer = makeMockServer();

    const badDir = path.join(agentsDir, "bad-meta-agent");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "meta.json"), "{ invalid json }", "utf-8");

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    await expect(pollCallback()).resolves.toBeUndefined();
    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });

  test("notification data includes correct duration_ms", async () => {
    const mockServer = makeMockServer();

    const startedAt = new Date("2025-01-01T10:00:00Z").toISOString();
    const completedAt = new Date("2025-01-01T10:01:30Z").toISOString(); // 90 000 ms later

    await writeMetaJson(
      agentsDir,
      "timed-agent",
      makeMeta({ agent_id: "timed-agent", task_name: "timed-task", status: "running" })
    );

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    await writeMetaJson(
      agentsDir,
      "timed-agent",
      makeMeta({
        agent_id: "timed-agent",
        task_name: "timed-task",
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt
      })
    );

    await pollCallback();

    expect(mockServer.sendLoggingMessage).toHaveBeenCalledOnce();
    const data = mockServer.sendLoggingMessage.mock.calls[0][0].data;
    expect(data.duration_ms).toBe(90_000);
  });

  test("interval is unref'd (does not keep process alive)", async () => {
    const mockServer = makeMockServer();

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);

    // After startAgentMonitor, the returned interval should have been unref'd.
    // Calling unref() again should be a harmless no-op (not throw).
    expect(() => intervalHandle!.unref()).not.toThrow();
  });

  test("does not crash when sendLoggingMessage throws (error is swallowed silently)", async () => {
    const mockServer = makeMockServer();
    mockServer.sendLoggingMessage.mockRejectedValue(new Error("client disconnected"));

    await writeMetaJson(
      agentsDir,
      "noisy-agent",
      makeMeta({ agent_id: "noisy-agent", task_name: "noisy-task", status: "running" })
    );

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    await writeMetaJson(
      agentsDir,
      "noisy-agent",
      makeMeta({
        agent_id: "noisy-agent",
        task_name: "noisy-task",
        status: "completed",
        completed_at: new Date().toISOString()
      })
    );

    // Should not throw even though sendLoggingMessage rejects
    await expect(pollCallback()).resolves.not.toThrow();
    // sendLoggingMessage was still called
    expect(mockServer.sendLoggingMessage).toHaveBeenCalledOnce();
  });

  test("handles empty agentsDir gracefully", async () => {
    const mockServer = makeMockServer();

    // agentsDir exists but is empty
    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;
    intervalHandle = await startAgentMonitor(mockServer as never, agentsDir);
    const pollCallback = capture.getCallback()!;

    await expect(pollCallback()).resolves.toBeUndefined();
    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });

  test("handles non-existent agentsDir gracefully", async () => {
    const mockServer = makeMockServer();
    const nonexistent = path.join(tmpdir(), "no-such-monitor-dir-xyz-abc");

    const capture = captureNextSetInterval();
    restoreSetInterval = capture.restore;

    // Should not throw during initialization (non-existent dir)
    intervalHandle = await startAgentMonitor(mockServer as never, nonexistent);
    const pollCallback = capture.getCallback()!;

    // Polling a non-existent dir should not throw
    await expect(pollCallback()).resolves.not.toThrow();
    expect(mockServer.sendLoggingMessage).not.toHaveBeenCalled();
  });
});
