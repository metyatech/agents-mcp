import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  AGENT_COMMANDS,
  resolveMode,
  computePathLCA,
  splitCommandTemplate,
} from '../src/agents.js';

const TESTDATA_DIR = path.join(__dirname, 'testdata');

describe('computePathLCA', () => {
  test('returns null for empty array', () => {
    expect(computePathLCA([])).toBeNull();
  });

  test('returns the path itself for single path', () => {
    expect(computePathLCA(['/Users/test/project'])).toBe(path.resolve('/Users/test/project'));
  });

  test('finds LCA for paths with common ancestor', () => {
    const paths = [
      '/Users/test/monorepo/packages/a',
      '/Users/test/monorepo/packages/b',
      '/Users/test/monorepo/packages/c',
    ];
    expect(computePathLCA(paths)).toBe(path.resolve('/Users/test/monorepo/packages'));
  });

  test('finds LCA at root level for divergent paths', () => {
    const paths = [
      '/Users/test/project-a/src',
      '/Users/test/project-b/src',
    ];
    expect(computePathLCA(paths)).toBe(path.resolve('/Users/test'));
  });

  test('returns null for paths with no common segments', () => {
    const paths = [
      '/home/user/project',
      '/var/log/app',
    ];
    // These paths have no common directory segments (home vs var)
    const lca = computePathLCA(paths);
    expect(lca).toBeNull();
  });

  test('handles nested paths correctly', () => {
    const paths = [
      '/a/b/c/d/e',
      '/a/b/c/d',
      '/a/b/c',
    ];
    expect(computePathLCA(paths)).toBe(path.resolve('/a/b/c'));
  });

  test('filters out empty paths', () => {
    const paths = [
      '/Users/test/project',
      '',
      '  ',
      '/Users/test/project/src',
    ];
    expect(computePathLCA(paths)).toBe(path.resolve('/Users/test/project'));
  });

  test('returns null when all paths are empty', () => {
    expect(computePathLCA(['', '  ', ''])).toBeNull();
  });
});

describe('Mode Resolution', () => {
  test('should use default mode when no flags provided', () => {
    const mode = resolveMode(null, 'edit');
    expect(mode).toBe('edit');
  });

  test('should return plan mode by default', () => {
    const mode = resolveMode(null, 'plan');
    expect(mode).toBe('plan');
  });

  test('should reject invalid mode values', () => {
    expect(() => {
      resolveMode('invalid' as any, 'plan');
    }).toThrow('Invalid mode');
  });

  test('should reject invalid default modes', () => {
    expect(() => {
      resolveMode(null, 'fast' as any);
    }).toThrow('Invalid default mode');
  });
});

describe('AgentProcess', () => {
  test('should serialize to dict correctly', () => {
    const agent = new AgentProcess(
      'test-1',
      'my-task',
      'codex',
      'Test prompt',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z')
    );

    const result = agent.toDict();

    expect(result.agent_id).toBe('test-1');
    expect(result.task_name).toBe('my-task');
    expect(result.agent_type).toBe('codex');
    expect(result.status).toBe('running');
    expect(result.event_count).toBe(0);
    expect(result.completed_at).toBeNull();
    expect(result.mode).toBe('plan');
    expect(result.duration).toBeDefined();
  });

  test('should reflect edit mode in serialization', () => {
    const agent = new AgentProcess(
      'test-edit',
      'my-task',
      'codex',
      'Test prompt',
      null,
      'edit',
      null,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z')
    );

    const result = agent.toDict();
    expect(result.mode).toBe('edit');
  });

  test('should calculate duration for completed agent', () => {
    const started = new Date('2024-01-01T00:00:00Z');
    const completed = new Date('2024-01-01T00:00:05Z');

    const agent = new AgentProcess(
      'test-2',
      'my-task',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.COMPLETED,
      started,
      completed
    );

    const duration = agent.duration();
    expect(duration).toBe('5 seconds');
  });

  test('should calculate duration for running agent', () => {
    const started = new Date();

    const agent = new AgentProcess(
      'test-3',
      'my-task',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      started
    );

    const duration = agent.duration();
    expect(duration).not.toBeNull();
    expect(duration).toMatch(/seconds|minutes/);
  });

  test('uses stdout log mtime for completion when events lack timestamps', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_process_${Date.now()}`);
    const agentId = 'agent-mtime';
    const agentDir = path.join(baseDir, agentId);
    const logPath = path.join(agentDir, 'stdout.log');
    const startedAt = new Date('2024-01-01T00:00:00Z');
    const logTime = new Date('2024-01-02T03:04:05Z');

    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(logPath, 'plain text line without json\n');
    await fs.utimes(logPath, logTime, logTime);

    const agent = new AgentProcess(
      agentId,
      'mtime-task',
      'codex',
      'Test prompt',
      null,
      'plan',
      999999,
      AgentStatus.RUNNING,
      startedAt,
      null,
      baseDir
    );

    try {
      await agent.updateStatusFromProcess();
      expect(agent.completedAt).not.toBeNull();
      const delta = Math.abs((agent.completedAt as Date).getTime() - logTime.getTime());
      expect(delta).toBeLessThan(1000);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('persists parent_session_id in metadata', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_meta_${Date.now()}`);
    const agent = new AgentProcess(
      'meta-1',
      'meta-task',
      'codex',
      'Test prompt',
      null,
      'plan',
      123,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      baseDir,
      'session-xyz'
    );

    try {
      await agent.saveMeta();
      const metaPath = await agent.getMetaPath();
      const metaRaw = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw);
      expect(meta.parent_session_id).toBe('session-xyz');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('loads parent_session_id from disk', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_meta_load_${Date.now()}`);
    const agent = new AgentProcess(
      'meta-2',
      'meta-task',
      'codex',
      'Test prompt',
      null,
      'plan',
      123,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      baseDir,
      'session-abc'
    );

    try {
      await agent.saveMeta();
      const loaded = await AgentProcess.loadFromDisk(agent.agentId, baseDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.parentSessionId).toBe('session-abc');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('stores null parent_session_id when missing', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_meta_null_${Date.now()}`);
    const agent = new AgentProcess(
      'meta-3',
      'meta-task',
      'codex',
      'Test prompt',
      null,
      'plan',
      123,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      baseDir,
      null
    );

    try {
      await agent.saveMeta();
      const metaPath = await agent.getMetaPath();
      const metaRaw = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw);
      expect(meta.parent_session_id).toBeNull();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('persists workspace_dir in metadata', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_workspace_${Date.now()}`);
    const agent = new AgentProcess(
      'workspace-1',
      'workspace-task',
      'codex',
      'Test prompt',
      '/Users/test/monorepo/packages/a',
      'plan',
      123,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      baseDir,
      null,
      '/Users/test/monorepo'
    );

    try {
      await agent.saveMeta();
      const metaPath = await agent.getMetaPath();
      const metaRaw = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw);
      expect(meta.workspace_dir).toBe('/Users/test/monorepo');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('loads workspace_dir from disk', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_workspace_load_${Date.now()}`);
    const agent = new AgentProcess(
      'workspace-2',
      'workspace-task',
      'codex',
      'Test prompt',
      '/Users/test/project/src',
      'plan',
      123,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      baseDir,
      null,
      '/Users/test/project'
    );

    try {
      await agent.saveMeta();
      const loaded = await AgentProcess.loadFromDisk(agent.agentId, baseDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.workspaceDir).toBe('/Users/test/project');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('includes workspace_dir in toDict output', () => {
    const agent = new AgentProcess(
      'dict-test',
      'dict-task',
      'codex',
      'Test prompt',
      '/Users/test/project/src',
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date('2024-01-01T00:00:00Z'),
      null,
      null,
      null,
      '/Users/test/project'
    );

    const result = agent.toDict();
    expect(result.workspace_dir).toBe('/Users/test/project');
  });

  test('suppresses gemini node-pty AttachConsole noise on win32', async () => {
    const baseDir = path.join(TESTDATA_DIR, `agent_noise_${Date.now()}`);
    const agentId = 'agent-noise-test';
    const agentDir = path.join(baseDir, agentId);
    const logPath = path.join(agentDir, 'stdout.log');

    await fs.mkdir(agentDir, { recursive: true });

    const noiseLines = [
      'Error: AttachConsole failed with error 6',
      '    at Object.<anonymous> (node_modules/@lydell/node-pty/build/node_pty.js:1)',
      '    at node-pty\\conpty_console_list_agent.js:11:5',
    ];
    const normalLine = 'some normal non-json output from agent';
    const logContent = [...noiseLines, normalLine].join('\n') + '\n';
    await fs.writeFile(logPath, logContent);

    const agent = new AgentProcess(
      agentId,
      'noise-task',
      'gemini',
      'Test prompt',
      null,
      'plan',
      999999,
      AgentStatus.RUNNING,
      new Date(),
      null,
      baseDir
    );

    try {
      await agent.readNewEvents();

      const rawContents = agent.events.filter(e => e.type === 'raw').map((e: any) => e.content);

      // Normal non-JSON lines must always appear regardless of platform
      expect(rawContents).toContain(normalLine);

      if (process.platform === 'win32') {
        // On Windows, AttachConsole noise must be suppressed for gemini agents
        for (const noiseLine of noiseLines) {
          expect(rawContents).not.toContain(noiseLine);
        }
      }
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe('AgentCommands', () => {
  test('should have commands for all agent types', () => {
    expect('codex' in AGENT_COMMANDS).toBe(true);
    expect('cursor' in AGENT_COMMANDS).toBe(true);
    expect('gemini' in AGENT_COMMANDS).toBe(true);
    expect('claude' in AGENT_COMMANDS).toBe(true);
  });

  test('should have prompt placeholder in command templates', () => {
    for (const cmdTemplate of Object.values(AGENT_COMMANDS)) {
      const cmdStr = cmdTemplate.join(' ');
      expect(cmdStr).toContain('{prompt}');
    }
  });

  test('should have correct Codex command structure', () => {
    const cmd = AGENT_COMMANDS.codex;
    expect(cmd[0]).toBe('codex');
    expect(cmd).toContain('exec');
    expect(cmd).toContain('--json');
    // --full-auto is only added in edit mode, not in plan mode base command
    expect(cmd).not.toContain('--full-auto');
  });
});

describe('Reasoning Effort CLI flags', () => {
  let manager: AgentManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `effort_tests_${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new AgentManager(5, 10, testDir);
    await manager['initialize']();
    manager['agents'].clear();
  });

  afterEach(async () => {
    try { await fs.rm(testDir, { recursive: true }); } catch {}
  });

  test('claude with reasoningEffort appends --effort flag', () => {
    const cmd = manager['buildCommand']('claude', 'test prompt', 'plan', 'claude-sonnet-4-6', null, 'high');
    expect(cmd).toContain('--effort');
    expect(cmd[cmd.indexOf('--effort') + 1]).toBe('high');
  });

  test('codex with reasoningEffort appends -c model_reasoning_effort', () => {
    const cmd = manager['buildCommand']('codex', 'test prompt', 'plan', 'gpt-5.3-codex', null, 'medium');
    expect(cmd).toContain('-c');
    const idx = cmd.indexOf('-c');
    expect(cmd[idx + 1]).toBe('model_reasoning_effort="medium"');
  });

  test('gemini with reasoningEffort ignores it silently', () => {
    const cmd = manager['buildCommand']('gemini', 'test prompt', 'plan', 'gemini-3-flash-preview', null, 'high');
    expect(cmd).not.toContain('--effort');
    const hasMre = cmd.some(a => a.includes('model_reasoning_effort'));
    expect(hasMre).toBe(false);
  });

  test('copilot with reasoningEffort ignores it silently', () => {
    const cmd = manager['buildCommand']('copilot', 'test prompt', 'plan', 'claude-sonnet-4.5', null, 'low');
    expect(cmd).not.toContain('--effort');
    const hasMre = cmd.some(a => a.includes('model_reasoning_effort'));
    expect(hasMre).toBe(false);
  });

  test('null reasoningEffort adds no extra flags for claude', () => {
    const cmdWith = manager['buildCommand']('claude', 'test prompt', 'plan', 'claude-sonnet-4-6', null, 'low');
    const cmdWithout = manager['buildCommand']('claude', 'test prompt', 'plan', 'claude-sonnet-4-6', null, null);
    expect(cmdWith.length).toBeGreaterThan(cmdWithout.length);
    expect(cmdWithout).not.toContain('--effort');
  });
});

describe('AgentManager', () => {
  let manager: AgentManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `agent_manager_tests_${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new AgentManager(5, 10, testDir);
    await manager['initialize']();
    manager['agents'].clear();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
    }
  });

  test('should initialize with empty agent list', async () => {
    const all = await manager.listAll();
    expect(all.length).toBe(0);
  });

  test('initialize() is idempotent - loadExistingAgents runs only once', async () => {
    // Create an agent on disk so loadExistingAgents has something to load
    const agentDir = path.join(testDir, 'idem-test');
    await fs.mkdir(agentDir, { recursive: true });
    const agent = new AgentProcess(
      'idem-test', 'task-1', 'claude', 'test prompt',
      null, 'plan', null, AgentStatus.COMPLETED,
      new Date(), new Date(), testDir
    );
    await agent.saveMeta();

    // Create a fresh manager pointing at the same dir and wait for init
    const mgr = new AgentManager(50, 10, testDir);
    await mgr['initialize']();
    const firstLoad = await mgr.listAll();
    expect(firstLoad.length).toBe(1);

    // Modify the in-memory agent's replyAgentIds and save to disk
    const loaded = mgr['agents'].get('idem-test')!;
    loaded.replyAgentIds.push('reply-1');
    await loaded.saveMeta();

    // Tamper with disk: overwrite with empty replyAgentIds to simulate a stale reload
    const staleAgent = new AgentProcess(
      'idem-test', 'task-1', 'claude', 'test prompt',
      null, 'plan', null, AgentStatus.COMPLETED,
      new Date(), new Date(), testDir
    );
    await staleAgent.saveMeta(); // writes reply_agent_ids: [] to disk

    // Second initialize() should NOT reload from disk (idempotent via Promise)
    await mgr['initialize']();
    const afterSecondInit = mgr['agents'].get('idem-test')!;
    // In-memory state preserved despite stale disk data
    expect(afterSecondInit.replyAgentIds).toEqual(['reply-1']);
  });

  test('updateStatusFromProcess does not saveMeta when status unchanged', async () => {
    const agentDir = path.join(testDir, 'no-save-test');
    await fs.mkdir(agentDir, { recursive: true });
    const startedAt = new Date(Date.now() - 60000);
    const completedAt = new Date(Date.now() - 30000);
    const agent = new AgentProcess(
      'no-save-test', 'task-1', 'claude', 'test prompt',
      null, 'plan', null, AgentStatus.COMPLETED,
      startedAt, completedAt, testDir
    );
    agent.replyAgentIds = ['existing-reply'];
    await agent.saveMeta();

    // Reload from disk to get a clean instance
    const reloaded = await AgentProcess.loadFromDisk('no-save-test', testDir);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.replyAgentIds).toEqual(['existing-reply']);

    // Spy on saveMeta - status is already COMPLETED with completedAt set and
    // pid is null, so updateStatusFromProcess should return early without saving
    let saveMetaCalled = false;
    const originalSave = reloaded!.saveMeta.bind(reloaded!);
    reloaded!.saveMeta = async () => {
      saveMetaCalled = true;
      return originalSave();
    };

    await reloaded!.updateStatusFromProcess();
    expect(saveMetaCalled).toBe(false);
  });

  test('should return null for nonexistent agent', async () => {
    const agent = await manager.get('nonexistent');
    expect(agent).toBeNull();
  });

  test('should list running agents correctly', async () => {
    const running1 = new AgentProcess(
      'running-1',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );
    const running2 = new AgentProcess(
      'running-2',
      'task-1',
      'gemini',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );
    const completed = new AgentProcess(
      'completed-1',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.COMPLETED
    );

    manager['agents'].set('running-1', running1);
    manager['agents'].set('running-2', running2);
    manager['agents'].set('completed-1', completed);

    const running = await manager.listRunning();
    expect(running.length).toBe(2);
    expect(running.every(a => a.status === AgentStatus.RUNNING)).toBe(true);
  });

  test('should list completed agents correctly', async () => {
    const running = new AgentProcess(
      'running-1',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );
    const completed1 = new AgentProcess(
      'completed-1',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.COMPLETED
    );
    const completed2 = new AgentProcess(
      'completed-2',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.FAILED
    );

    manager['agents'].set('running-1', running);
    manager['agents'].set('completed-1', completed1);
    manager['agents'].set('completed-2', completed2);

    const completed = await manager.listCompleted();
    expect(completed.length).toBe(2);
    expect(completed.every(a => a.status !== AgentStatus.RUNNING)).toBe(true);
  });

  test('should stop nonexistent agent and return false', async () => {
    const success = await manager.stop('nonexistent');
    expect(success).toBe(false);
  });

  test('should stop already completed agent and return false', async () => {
    const agent = new AgentProcess(
      'completed-1',
      'task-1',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.COMPLETED
    );
    manager['agents'].set('completed-1', agent);

    const success = await manager.stop('completed-1');
    expect(success).toBe(false);
  });

  test('should list agents by task name', async () => {
    const agent1 = new AgentProcess(
      'agent-1',
      'task-a',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );
    const agent2 = new AgentProcess(
      'agent-2',
      'task-a',
      'gemini',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );
    const agent3 = new AgentProcess(
      'agent-3',
      'task-b',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );

    manager['agents'].set('agent-1', agent1);
    manager['agents'].set('agent-2', agent2);
    manager['agents'].set('agent-3', agent3);

    const taskAAgents = await manager.listByTask('task-a');
    expect(taskAAgents.length).toBe(2);
    expect(taskAAgents.every(a => a.taskName === 'task-a')).toBe(true);

    const taskBAgents = await manager.listByTask('task-b');
    expect(taskBAgents.length).toBe(1);
    expect(taskBAgents[0].agentId).toBe('agent-3');

    const taskCAgents = await manager.listByTask('task-c');
    expect(taskCAgents.length).toBe(0);
  });

  test('should list agents by parent session id', async () => {
    const agent1 = new AgentProcess(
      'agent-1',
      'task-a',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      null,
      'session-1'
    );
    const agent2 = new AgentProcess(
      'agent-2',
      'task-b',
      'cursor',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      null,
      'session-1'
    );
    const agent3 = new AgentProcess(
      'agent-3',
      'task-c',
      'gemini',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      null,
      'session-2'
    );

    manager['agents'].set('agent-1', agent1);
    manager['agents'].set('agent-2', agent2);
    manager['agents'].set('agent-3', agent3);

    const session1Agents = await manager.listByParentSession('session-1');
    expect(session1Agents.length).toBe(2);
    expect(session1Agents.every(a => a.parentSessionId === 'session-1')).toBe(true);

    const session2Agents = await manager.listByParentSession('session-2');
    expect(session2Agents.length).toBe(1);
    expect(session2Agents[0].agentId).toBe('agent-3');

    const missingAgents = await manager.listByParentSession('session-3');
    expect(missingAgents.length).toBe(0);
  });

  test('should stop all agents in a task', async () => {
    const agent1 = new AgentProcess(
      'agent-1',
      'task-stop',
      'codex',
      'Test',
      null,
      'plan',
      12345,
      AgentStatus.RUNNING
    );
    const agent2 = new AgentProcess(
      'agent-2',
      'task-stop',
      'gemini',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.COMPLETED
    );
    const agent3 = new AgentProcess(
      'agent-3',
      'other-task',
      'codex',
      'Test',
      null,
      'plan',
      null,
      AgentStatus.RUNNING
    );

    manager['agents'].set('agent-1', agent1);
    manager['agents'].set('agent-2', agent2);
    manager['agents'].set('agent-3', agent3);

    const result = await manager.stopByTask('task-stop');

    // agent-1 would be in stopped list if the process existed
    // agent-2 is already completed so goes to alreadyStopped
    expect(result.alreadyStopped).toContain('agent-2');

    // agent-3 should not be affected
    const otherAgent = manager['agents'].get('agent-3');
    expect(otherAgent?.status).toBe(AgentStatus.RUNNING);
  });
});

// ---------------------------------------------------------------------------
// Config-driven command templates
// ---------------------------------------------------------------------------

describe('splitCommandTemplate', () => {
  test('basic unquoted tokens', () => {
    expect(splitCommandTemplate('codex exec --sandbox workspace-write {prompt} --json')).toEqual(
      ['codex', 'exec', '--sandbox', 'workspace-write', '{prompt}', '--json']
    );
  });

  test('single-quoted argument strips quotes', () => {
    expect(splitCommandTemplate("gh copilot suggest '{prompt}' --output json")).toEqual(
      ['gh', 'copilot', 'suggest', '{prompt}', '--output', 'json']
    );
  });

  test('double-quoted argument strips quotes', () => {
    expect(splitCommandTemplate('my-cli -p "{prompt}" --json')).toEqual(
      ['my-cli', '-p', '{prompt}', '--json']
    );
  });

  test('double-quoted backslash escape sequences', () => {
    expect(splitCommandTemplate('my-cli "hello \\"world\\""')).toEqual(
      ['my-cli', 'hello "world"']
    );
  });

  test('extra whitespace between tokens is collapsed', () => {
    expect(splitCommandTemplate('cmd   --flag   {prompt}')).toEqual(
      ['cmd', '--flag', '{prompt}']
    );
  });

  test('throws on unterminated single quote', () => {
    expect(() => splitCommandTemplate("my-cli '{prompt}")).toThrow('Unterminated quote');
  });

  test('throws on unterminated double quote', () => {
    expect(() => splitCommandTemplate('my-cli "{prompt}')).toThrow('Unterminated quote');
  });
});

describe('Config-driven buildCommand', () => {
  let testDir: string;
  let manager: AgentManager;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `cmd_template_tests_${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new AgentManager(5, 10, testDir);
    await manager['initialize']();
    manager['agents'].clear();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {}
  });

  test('uses custom command from agentConfigs when it differs from default', () => {
    // Override codex command with a completely different CLI
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      codex: {
        ...manager['agentConfigs'].codex,
        command: "gh copilot suggest '{prompt}' --output json",
      },
    };

    const cmd = manager['buildCommand']('codex', 'write tests', 'plan', 'gpt-5.3-codex');

    expect(cmd[0]).toBe('gh');
    expect(cmd[1]).toBe('copilot');
    expect(cmd[2]).toBe('suggest');
    // {prompt} was substituted with the full prompt
    expect(cmd[3]).toContain('write tests');
    expect(cmd[4]).toBe('--output');
    expect(cmd[5]).toBe('json');
    // No codex-specific flags injected
    expect(cmd).not.toContain('exec');
    expect(cmd).not.toContain('--sandbox');
    expect(cmd).not.toContain('--model');
  });

  test('compatible codex custom command still injects model and mode flags', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      codex: {
        ...manager['agentConfigs'].codex,
        command: "codex -a never exec --skip-git-repo-check --sandbox danger-full-access '{prompt}' --json",
      },
    };

    const cmd = manager['buildCommand']('codex', 'write tests', 'edit', 'gpt-5.3-codex');

    expect(cmd[0]).toBe('codex');
    expect(cmd).toContain('--sandbox');
    expect(cmd).toContain('danger-full-access');
    expect(cmd).toContain('--model');
    expect(cmd).toContain('gpt-5.3-codex');
    expect(cmd).toContain('--full-auto');
  });

  test('compatible claude custom command gets required flags and settings', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      claude: {
        ...manager['agentConfigs'].claude,
        command: "claude -p '{prompt}' --output-format stream-json",
      },
    };

    const cmd = manager['buildCommand']('claude', 'write tests', 'edit', 'claude-sonnet-4-6', testDir);

    expect(cmd[0]).toBe('claude');
    expect(cmd).toContain('--verbose');
    expect(cmd).toContain('--permission-mode');
    expect(cmd).toContain('acceptEdits');
    expect(cmd).toContain('--settings');
    expect(cmd).toContain('--add-dir');
    expect(cmd).toContain(testDir);
    expect(cmd).toContain('--model');
    expect(cmd).toContain('claude-sonnet-4-6');
  });

  test('falls back to AGENT_COMMANDS when command matches built-in default', () => {
    // agentConfigs holds the default command string → falls back to AGENT_COMMANDS
    const cmd = manager['buildCommand']('codex', 'write tests', 'plan', 'gpt-5.3-codex');

    expect(cmd[0]).toBe('codex');
    expect(cmd).toContain('exec');
    expect(cmd).toContain('--sandbox');
    expect(cmd).toContain('--json');
    // Model is injected via existing logic
    expect(cmd).toContain('--model');
    expect(cmd).toContain('gpt-5.3-codex');
  });

  test('throws clear error when custom command is missing {prompt}', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      codex: {
        ...manager['agentConfigs'].codex,
        command: 'gh copilot suggest --output json',  // no {prompt}
      },
    };

    expect(() => {
      manager['buildCommand']('codex', 'write tests', 'plan', 'gpt-5.3-codex');
    }).toThrow('{prompt}');
  });

  test('error message for missing {prompt} mentions config path', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: 'my-gemini-wrapper --output json',  // no {prompt}
      },
    };

    let errorMsg = '';
    try {
      manager['buildCommand']('gemini', 'write tests', 'plan', 'gemini-3-flash-preview');
    } catch (e: any) {
      errorMsg = e.message;
    }

    expect(errorMsg).toContain('config.json');
    expect(errorMsg).toContain('{prompt}');
    expect(errorMsg).toContain('gemini');
  });

  test('initialize() else-branch correctly assigns agentConfigs when provided via constructor', async () => {
    const customConfigs = manager['agentConfigs'];
    const customManager = new AgentManager(5, 10, testDir, null, null, 7, customConfigs);
    await customManager['initialize']();

    // agentConfigs must be set (was the bug: else-branch skipped assignment)
    expect(customManager['agentConfigs']).toBeDefined();
    expect(customManager['agentConfigs']).toEqual(customConfigs);
  });

  test('custom gemini command is used verbatim (no --yolo appended in edit mode)', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: "my-gemini '{prompt}' --format stream",
      },
    };

    const cmd = manager['buildCommand']('gemini', 'write tests', 'edit', 'gemini-3-flash-preview');

    expect(cmd[0]).toBe('my-gemini');
    expect(cmd).not.toContain('--yolo');
    expect(cmd).not.toContain('--model');
  });

  test('compatible gemini command without -p gets -p injected before prompt (headless mode fix)', () => {
    // Simulates a legacy/custom config that omits -p, which causes AttachConsole
    // errors on Windows when gemini tries to start in interactive (TTY) mode.
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: "gemini '{prompt}' --output-format stream-json",
      },
    };

    const cmd = manager['buildCommand']('gemini', 'write tests', 'plan', 'gemini-3-flash-preview');

    expect(cmd[0]).toBe('gemini');
    expect(cmd).toContain('-p');
    // -p must appear before the prompt argument
    const pIdx = cmd.indexOf('-p');
    const promptIdx = cmd.findIndex(part => part.includes('write tests'));
    expect(pIdx).toBeLessThan(promptIdx);
  });

  test('compatible gemini command that already has -p is not modified', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: "gemini -p '{prompt}' --output-format stream-json",
      },
    };

    const cmd = manager['buildCommand']('gemini', 'write tests', 'plan', 'gemini-3-flash-preview');

    expect(cmd[0]).toBe('gemini');
    // Only one -p occurrence
    expect(cmd.filter(a => a === '-p').length).toBe(1);
  });

  test('legacy gemini command (no -p) in plan mode includes --approval-mode plan', () => {
    // Simulates a legacy config that omits -p; plan mode must add --approval-mode plan
    // so gemini does not execute shell tool calls that trigger AttachConsole errors.
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: "gemini '{prompt}' --output-format stream-json",
      },
    };

    const cmd = manager['buildCommand']('gemini', 'hi', 'plan', 'gemini-3-flash-preview');

    expect(cmd[0]).toBe('gemini');
    expect(cmd).toContain('--approval-mode');
    const idx = cmd.indexOf('--approval-mode');
    expect(cmd[idx + 1]).toBe('plan');
  });

  test('gemini plan mode does not duplicate --approval-mode when already present in config', () => {
    manager['agentConfigs'] = {
      ...manager['agentConfigs'],
      gemini: {
        ...manager['agentConfigs'].gemini,
        command: "gemini -p '{prompt}' --output-format stream-json --approval-mode plan",
      },
    };

    const cmd = manager['buildCommand']('gemini', 'hi', 'plan', 'gemini-3-flash-preview');

    expect(cmd.filter(a => a === '--approval-mode').length).toBe(1);
  });
});

describe('buildReplyCommand', () => {
  let testDir: string;
  let manager: AgentManager;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `reply_cmd_tests_${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    manager = new AgentManager(5, 10, testDir);
    await manager['initialize']();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {}
  });

  test('builds correct claude reply command in plan mode', () => {
    const cmd = manager.buildReplyCommand(
      'claude', 'follow up message', 'session-123', 'plan', 'claude-sonnet-4-6'
    );

    expect(cmd[0]).toBe('claude');
    expect(cmd).toContain('-r');
    expect(cmd).toContain('session-123');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('follow up message');
    expect(cmd).toContain('--output-format');
    expect(cmd).toContain('stream-json');
    expect(cmd).toContain('--verbose');
    expect(cmd).toContain('--permission-mode');
    expect(cmd).toContain('plan');
    expect(cmd).toContain('--model');
    expect(cmd).toContain('claude-sonnet-4-6');
    expect(cmd).toContain('--settings');
  });

  test('builds correct claude reply command in edit mode', () => {
    const cmd = manager.buildReplyCommand(
      'claude', 'fix it', 'session-456', 'edit', 'claude-opus-4-6'
    );

    expect(cmd).toContain('--permission-mode');
    const pmIdx = cmd.indexOf('--permission-mode');
    expect(cmd[pmIdx + 1]).toBe('acceptEdits');
  });

  test('builds correct claude reply command with cwd', () => {
    const cmd = manager.buildReplyCommand(
      'claude', 'check files', 'session-789', 'plan', 'claude-sonnet-4-6', '/my/project'
    );

    expect(cmd).toContain('--add-dir');
    expect(cmd).toContain('/my/project');
  });

  test('claude reply requires session_id', () => {
    expect(() => {
      manager.buildReplyCommand('claude', 'msg', null, 'plan', 'claude-sonnet-4-6');
    }).toThrow('session_id');
  });

  test('builds correct gemini reply command', () => {
    const cmd = manager.buildReplyCommand(
      'gemini', 'continue work', null, 'plan', 'gemini-3-flash-preview'
    );

    expect(cmd[0]).toBe('gemini');
    expect(cmd).toContain('--resume');
    expect(cmd).toContain('latest');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('continue work');
    expect(cmd).toContain('--output-format');
    expect(cmd).toContain('stream-json');
    expect(cmd).toContain('--model');
    expect(cmd).toContain('gemini-3-flash-preview');
    expect(cmd).toContain('--approval-mode');
    expect(cmd).toContain('plan');
  });

  test('builds correct gemini reply command in edit mode', () => {
    const cmd = manager.buildReplyCommand(
      'gemini', 'do it', null, 'edit', 'gemini-3-pro-preview'
    );

    expect(cmd).toContain('--yolo');
    expect(cmd).not.toContain('--approval-mode');
  });

  test('builds correct copilot reply command', () => {
    const cmd = manager.buildReplyCommand(
      'copilot', 'what next', null, 'plan', 'claude-sonnet-4'
    );

    expect(cmd[0]).toBe('copilot');
    expect(cmd).toContain('--continue');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('what next');
    expect(cmd).toContain('-s');
    expect(cmd).toContain('--model');
    expect(cmd).toContain('claude-sonnet-4');
    // Plan mode should not have edit flags
    expect(cmd).not.toContain('--allow-all-tools');
  });

  test('builds correct copilot reply command in edit mode', () => {
    const cmd = manager.buildReplyCommand(
      'copilot', 'apply fix', null, 'edit', 'gpt-5'
    );

    expect(cmd).toContain('--allow-all-tools');
    expect(cmd).toContain('--allow-all-paths');
    expect(cmd).toContain('--no-ask-user');
  });

  test('throws for unsupported agent type', () => {
    expect(() => {
      manager.buildReplyCommand('codex', 'msg', null, 'plan', 'gpt-5.3-codex');
    }).toThrow('not supported');
  });
});

describe('Session ID extraction and reply chain', () => {
  test('extracts session_id from claude init event', async () => {
    const baseDir = path.join(tmpdir(), `session_extract_${Date.now()}`);
    const agentId = 'session-extract-test';
    const agentDir = path.join(baseDir, agentId);
    const logPath = path.join(agentDir, 'stdout.log');

    await fs.mkdir(agentDir, { recursive: true });

    const initEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-6',
      session_id: 'extracted-session-id',
    });
    await fs.writeFile(logPath, initEvent + '\n');

    const agent = new AgentProcess(
      agentId, 'test-task', 'claude', 'test prompt',
      null, 'plan', 999999, AgentStatus.RUNNING,
      new Date(), null, baseDir
    );

    try {
      await agent.readNewEvents();
      expect(agent.sessionId).toBe('extracted-session-id');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('extracts session_id from gemini init event', async () => {
    const baseDir = path.join(tmpdir(), `gemini_session_${Date.now()}`);
    const agentId = 'gemini-session-test';
    const agentDir = path.join(baseDir, agentId);
    const logPath = path.join(agentDir, 'stdout.log');

    await fs.mkdir(agentDir, { recursive: true });

    const initEvent = JSON.stringify({
      type: 'init',
      model: 'gemini-3-flash-preview',
      session_id: 'gemini-session-abc',
    });
    await fs.writeFile(logPath, initEvent + '\n');

    const agent = new AgentProcess(
      agentId, 'test-task', 'gemini', 'test prompt',
      null, 'plan', 999999, AgentStatus.RUNNING,
      new Date(), null, baseDir
    );

    try {
      await agent.readNewEvents();
      expect(agent.sessionId).toBe('gemini-session-abc');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('does not overwrite session_id once set', async () => {
    const baseDir = path.join(tmpdir(), `session_no_overwrite_${Date.now()}`);
    const agentId = 'no-overwrite-test';
    const agentDir = path.join(baseDir, agentId);
    const logPath = path.join(agentDir, 'stdout.log');

    await fs.mkdir(agentDir, { recursive: true });

    // Two init events with different session_ids
    const events = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'first-session' }),
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'second-session' }),
    ].join('\n') + '\n';
    await fs.writeFile(logPath, events);

    const agent = new AgentProcess(
      agentId, 'test-task', 'claude', 'test prompt',
      null, 'plan', 999999, AgentStatus.RUNNING,
      new Date(), null, baseDir
    );

    try {
      await agent.readNewEvents();
      expect(agent.sessionId).toBe('first-session');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('reply chain tracking: originalAgentId and replyAgentIds persisted', async () => {
    const baseDir = path.join(tmpdir(), `reply_chain_${Date.now()}`);

    const agent = new AgentProcess(
      'chain-original', 'chain-task', 'claude', 'original prompt',
      null, 'plan', null, AgentStatus.COMPLETED,
      new Date(), new Date(), baseDir,
      null, null, 'session-xyz', 0, null, []
    );

    try {
      await agent.saveMeta();

      // Simulate adding a reply
      agent.replyAgentIds.push('reply-1');
      await agent.saveMeta();

      const loaded = await AgentProcess.loadFromDisk('chain-original', baseDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe('session-xyz');
      expect(loaded!.conversationTurn).toBe(0);
      expect(loaded!.originalAgentId).toBeNull();
      expect(loaded!.replyAgentIds).toEqual(['reply-1']);

      // Create reply agent
      const reply = new AgentProcess(
        'reply-1', 'chain-task', 'claude', 'follow up',
        null, 'plan', null, AgentStatus.COMPLETED,
        new Date(), new Date(), baseDir,
        null, null, 'session-xyz', 1, 'chain-original', []
      );

      await reply.saveMeta();
      const loadedReply = await AgentProcess.loadFromDisk('reply-1', baseDir);
      expect(loadedReply).not.toBeNull();
      expect(loadedReply!.conversationTurn).toBe(1);
      expect(loadedReply!.originalAgentId).toBe('chain-original');
      expect(loadedReply!.sessionId).toBe('session-xyz');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  test('toDict includes conversation metadata', () => {
    const agent = new AgentProcess(
      'dict-conv', 'dict-task', 'claude', 'prompt',
      null, 'plan', null, AgentStatus.COMPLETED,
      new Date(), new Date(), null,
      null, null, 'session-abc', 3, 'original-xyz', ['r1', 'r2']
    );

    const dict = agent.toDict();
    expect(dict.session_id).toBe('session-abc');
    expect(dict.conversation_turn).toBe(3);
    expect(dict.original_agent_id).toBe('original-xyz');
    expect(dict.reply_agent_ids).toEqual(['r1', 'r2']);
  });
});
