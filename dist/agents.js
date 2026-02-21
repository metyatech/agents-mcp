import { spawn } from 'child_process';
import { accessSync, constants as fsConstants, existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { resolveAgentsDir } from './persistence.js';
import { normalizeEvents } from './parsers.js';
/**
 * Compute the Lowest Common Ancestor (LCA) of multiple file paths.
 * Returns the deepest common directory shared by all paths.
 * Returns null if paths is empty or paths have no common ancestor (different roots).
 */
export function computePathLCA(paths) {
    const validPaths = paths.filter(p => p && p.trim());
    if (validPaths.length === 0)
        return null;
    if (validPaths.length === 1)
        return path.resolve(validPaths[0]);
    const resolved = validPaths.map(p => path.resolve(p));
    const parsed = resolved.map(p => {
        const root = path.parse(p).root;
        const rest = p.slice(root.length);
        const parts = rest.split(path.sep).filter(Boolean);
        return { root, parts };
    });
    const normalizeRoot = (r) => (process.platform === 'win32' ? r.toLowerCase() : r);
    const root0 = parsed[0].root;
    const sameRoot = parsed.every(p => normalizeRoot(p.root) === normalizeRoot(root0));
    if (!sameRoot)
        return null;
    const minLen = Math.min(...parsed.map(p => p.parts.length));
    const commonParts = [];
    for (let i = 0; i < minLen; i++) {
        const segment = parsed[0].parts[i];
        const allMatch = parsed.every(p => p.parts[i] === segment);
        if (!allMatch)
            break;
        commonParts.push(segment);
    }
    // If the only shared ancestor is the filesystem root, treat it as "no common ancestor".
    if (commonParts.length === 0)
        return null;
    return path.join(root0, ...commonParts);
}
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["RUNNING"] = "running";
    AgentStatus["COMPLETED"] = "completed";
    AgentStatus["FAILED"] = "failed";
    AgentStatus["STOPPED"] = "stopped";
})(AgentStatus || (AgentStatus = {}));
export function buildWindowsSpawnPs1(cmd, stdoutPath, workingDirectory) {
    // In PowerShell single-quoted strings, only ' needs escaping (doubled: '').
    // Backslashes are literal, so Windows paths need no extra escaping.
    const psEsc = (s) => s.replace(/'/g, "''");
    const toB64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    // IMPORTANT: do not embed raw argument text directly in '...' because PowerShell
    // treats smart quotes (e.g. U+2019 RIGHT SINGLE QUOTATION MARK) as quote tokens,
    // which can break parsing and cause the wrapper script to fail immediately.
    // Base64 encode each argument and decode it inside PowerShell.
    const argListLines = cmd.slice(1).map(a => {
        const b64 = toB64(a);
        return `$psi.ArgumentList.Add($enc.GetString([System.Convert]::FromBase64String('${b64}')))`;
    });
    const psLines = [
        `$env:CLAUDECODE = $null`,
        `$enc = [System.Text.UTF8Encoding]::new($false)`,
        // Resolve the command to its full path so we can handle .ps1/.cmd/.bat wrappers.
        // npm installs many CLIs as .ps1 scripts (e.g. codex.ps1, gemini.ps1).
        // ProcessStartInfo with UseShellExecute=false cannot launch .ps1 files directly.
        `$resolved = Get-Command '${psEsc(cmd[0])}' -ErrorAction SilentlyContinue`,
        `if ($null -eq $resolved) { [System.IO.File]::WriteAllText('${psEsc(stdoutPath)}', "ERROR: '${psEsc(cmd[0])}' not found in PATH", $enc); exit 1 }`,
        `$exe = $resolved.Source`,
        `$psi = [System.Diagnostics.ProcessStartInfo]::new()`,
        // Wrap .ps1 scripts via pwsh; .cmd/.bat via cmd /c; executables run directly.
        `switch -Wildcard ($exe) {`,
        `  '*.ps1' { $psi.FileName = 'pwsh.exe'; $psi.ArgumentList.Add('-NoProfile'); $psi.ArgumentList.Add('-NonInteractive'); $psi.ArgumentList.Add('-File'); $psi.ArgumentList.Add($exe) }`,
        `  '*.cmd' { $psi.FileName = 'cmd.exe'; $psi.ArgumentList.Add('/c'); $psi.ArgumentList.Add($exe) }`,
        `  '*.bat' { $psi.FileName = 'cmd.exe'; $psi.ArgumentList.Add('/c'); $psi.ArgumentList.Add($exe) }`,
        `  default  { $psi.FileName = $exe }`,
        `}`,
        ...argListLines,
        `$psi.WorkingDirectory = '${psEsc(workingDirectory)}'`,
        `$psi.RedirectStandardInput = $true`,
        `$psi.RedirectStandardOutput = $true`,
        `$psi.RedirectStandardError = $true`,
        `$psi.UseShellExecute = $false`,
        `$psi.StandardOutputEncoding = $enc`,
        `$psi.StandardErrorEncoding = $enc`,
        `$p = [System.Diagnostics.Process]::Start($psi)`,
        // Close stdin immediately so child processes that check for pipeline input
        // (e.g. npm .ps1 wrappers that use $MyInvocation.ExpectingInput) don't hang.
        `$p.StandardInput.Close()`,
        // Read both streams concurrently to avoid deadlock when stderr buffer fills.
        `$outTask = $p.StandardOutput.ReadToEndAsync()`,
        `$errTask = $p.StandardError.ReadToEndAsync()`,
        `$p.WaitForExit()`,
        `[void][System.Threading.Tasks.Task]::WhenAll($outTask, $errTask)`,
        // Append a JSON sentinel line with the real exit code so readNewEvents() can
        // determine the correct COMPLETED/FAILED status without guessing.
        `$exitJson = '{"__exit_code__":' + $p.ExitCode.ToString() + '}'`,
        `[System.IO.File]::WriteAllText('${psEsc(stdoutPath)}', $outTask.Result + $errTask.Result + [Environment]::NewLine + $exitJson + [Environment]::NewLine, $enc)`,
    ];
    return psLines.join('\n');
}
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
export function splitCommandTemplate(cmdStr) {
    const result = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (let i = 0; i < cmdStr.length; i++) {
        const ch = cmdStr[i];
        if (inSingleQuote) {
            if (ch === "'") {
                inSingleQuote = false;
            }
            else {
                current += ch;
            }
        }
        else if (inDoubleQuote) {
            if (ch === '"') {
                inDoubleQuote = false;
            }
            else if (ch === '\\') {
                const next = cmdStr[i + 1];
                if (next === '"' || next === '\\') {
                    current += next;
                    i++;
                }
                else {
                    current += ch;
                }
            }
            else {
                current += ch;
            }
        }
        else {
            if (ch === "'") {
                inSingleQuote = true;
            }
            else if (ch === '"') {
                inDoubleQuote = true;
            }
            else if (ch === ' ' || ch === '\t') {
                if (current.length > 0) {
                    result.push(current);
                    current = '';
                }
            }
            else {
                current += ch;
            }
        }
    }
    if (current.length > 0) {
        result.push(current);
    }
    if (inSingleQuote || inDoubleQuote) {
        throw new Error(`Unterminated quote in command template: ${cmdStr}`);
    }
    return result;
}
function isCompatibleAgentCli(agentType, firstArg) {
    if (!firstArg)
        return false;
    const exe = path.basename(firstArg).toLowerCase();
    switch (agentType) {
        case 'codex':
            return exe === 'codex' || exe === 'codex.exe';
        case 'claude':
            return exe === 'claude' || exe === 'claude.exe';
        case 'gemini':
            return exe === 'gemini' || exe === 'gemini.exe';
        case 'cursor':
            return exe === 'cursor-agent' || exe === 'cursor-agent.exe';
        case 'opencode':
            return exe === 'opencode' || exe === 'opencode.exe';
        case 'copilot':
            return exe === 'copilot' || exe === 'copilot.exe';
        default:
            return false;
    }
}
function ensureClaudeFlag(cmd, flag, value) {
    const out = [...cmd];
    const flagIndex = out.indexOf(flag);
    if (flagIndex !== -1)
        return out;
    if (value === undefined) {
        out.push(flag);
    }
    else {
        out.push(flag, value);
    }
    return out;
}
function ensureGeminiHeadlessFlag(cmd, promptText) {
    if (cmd.includes('-p') || cmd.includes('--prompt'))
        return [...cmd];
    const out = [...cmd];
    const promptIdx = out.indexOf(promptText);
    if (promptIdx !== -1) {
        out.splice(promptIdx, 0, '-p');
    }
    else {
        out.push('-p');
    }
    return out;
}
// Base commands for plan mode (read-only, may prompt for confirmation)
export const AGENT_COMMANDS = {
    codex: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '{prompt}', '--json'],
    cursor: ['cursor-agent', '-p', '--output-format', 'stream-json', '{prompt}'],
    gemini: ['gemini', '-p', '{prompt}', '--output-format', 'stream-json'],
    claude: ['claude', '-p', '--verbose', '{prompt}', '--output-format', 'stream-json', '--permission-mode', 'plan'],
    opencode: ['opencode', 'run', '--format', 'json', '{prompt}'],
    copilot: ['copilot', '-p', '{prompt}', '-s'],
};
// Build effort model map from agent configs
export function resolveEffortModelMap(baseOrAgentConfigs, overrides) {
    // Check if first arg is base EffortModelMap (old API) or agent configs (new API)
    const hasBaseOverrides = arguments.length > 1;
    if (hasBaseOverrides && overrides) {
        // Old API: resolveEffortModelMap(base, overrides)
        const base = baseOrAgentConfigs;
        const resolved = {
            fast: { ...base.fast },
            default: { ...base.default },
            detailed: { ...base.detailed }
        };
        for (const [agentType, effortOverrides] of Object.entries(overrides)) {
            if (!effortOverrides)
                continue;
            const typedAgent = agentType;
            for (const level of ['fast', 'default', 'detailed']) {
                const model = effortOverrides[level];
                if (typeof model === 'string') {
                    const trimmed = model.trim();
                    if (trimmed) {
                        resolved[level][typedAgent] = trimmed;
                    }
                }
            }
        }
        return resolved;
    }
    else {
        // New API: resolveEffortModelMap(agentConfigs)
        const agentConfigs = baseOrAgentConfigs;
        const resolved = {
            fast: {},
            default: {},
            detailed: {}
        };
        for (const [agentType, agentConfig] of Object.entries(agentConfigs)) {
            resolved.fast[agentType] = agentConfig.models.fast;
            resolved.default[agentType] = agentConfig.models.default;
            resolved.detailed[agentType] = agentConfig.models.detailed;
        }
        return resolved;
    }
}
// Load default agent configs from persistence
function loadDefaultAgentConfigs() {
    // Use hardcoded defaults for backward compatibility with synchronous initialization
    return {
        claude: {
            command: 'claude -p \'{prompt}\' --output-format stream-json',
            enabled: true,
            models: {
                fast: 'claude-haiku-4-5-20251001',
                default: 'claude-sonnet-4-6',
                detailed: 'claude-opus-4-6'
            },
            provider: 'anthropic'
        },
        codex: {
            // Note: gpt-5.3 (general GPT) and gpt-5.3-codex (coding-optimized) are distinct models.
            // Use gpt-5.3-codex for code/execution tasks; gpt-5.3 via explicit model param for general reasoning.
            command: 'codex exec --sandbox danger-full-access \'{prompt}\' --json',
            enabled: true,
            models: {
                fast: 'gpt-5.1-codex-mini',
                default: 'gpt-5.3-codex',
                detailed: 'gpt-5.3-codex'
            },
            provider: 'openai'
        },
        gemini: {
            command: 'gemini -p \'{prompt}\' --output-format stream-json',
            enabled: true,
            models: {
                fast: 'gemini-3-flash-preview',
                default: 'gemini-3-flash-preview',
                detailed: 'gemini-3-pro-preview'
            },
            provider: 'google'
        },
        cursor: {
            command: 'cursor-agent -p --output-format stream-json \'{prompt}\'',
            enabled: true,
            models: {
                fast: 'composer-1',
                default: 'composer-1',
                detailed: 'composer-1'
            },
            provider: 'custom'
        },
        opencode: {
            command: 'opencode run --format json \'{prompt}\'',
            enabled: true,
            models: {
                fast: 'zai-coding-plan/glm-4.7-flash',
                default: 'zai-coding-plan/glm-4.7',
                detailed: 'zai-coding-plan/glm-4.7'
            },
            provider: 'custom'
        },
        copilot: {
            command: 'copilot -p \'{prompt}\' -s',
            enabled: true,
            models: {
                fast: 'claude-sonnet-4',
                default: 'claude-sonnet-4.5',
                detailed: 'gpt-5'
            },
            provider: 'github'
        }
    };
}
// Default effort model map (for backward compatibility with tests)
export const EFFORT_MODEL_MAP = resolveEffortModelMap(loadDefaultAgentConfigs());
// Suffix appended to all prompts to ensure agents provide a summary
const PROMPT_SUFFIX = `

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why
3. Any important classes, functions, or components you added/changed`;
// Prefix for Claude agents in plan mode - explains the headless plan mode restrictions
const CLAUDE_PLAN_MODE_PREFIX = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

`;
const VALID_MODES = ['plan', 'edit', 'ralph'];
function normalizeModeValue(modeValue) {
    if (!modeValue)
        return null;
    const normalized = modeValue.trim().toLowerCase();
    if (VALID_MODES.includes(normalized)) {
        return normalized;
    }
    return null;
}
function defaultModeFromEnv() {
    for (const envVar of ['AGENTS_MCP_MODE', 'AGENTS_MCP_DEFAULT_MODE']) {
        const rawValue = process.env[envVar];
        const parsed = normalizeModeValue(rawValue);
        if (parsed) {
            return parsed;
        }
        if (rawValue) {
            console.warn(`Invalid ${envVar}='${rawValue}'. Use 'plan' or 'edit'. Falling back to plan mode.`);
        }
    }
    return 'plan';
}
function coerceDate(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed)
            return null;
        const numeric = Number(trimmed);
        if (!Number.isNaN(numeric)) {
            const ms = numeric < 1e12 ? numeric * 1000 : numeric;
            const date = new Date(ms);
            if (!Number.isNaN(date.getTime()))
                return date;
        }
        const date = new Date(trimmed);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}
function extractTimestamp(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const candidates = [
        raw.timestamp,
        raw.time,
        raw.created_at,
        raw.createdAt,
        raw.ts,
        raw.started_at,
        raw.startedAt,
    ];
    for (const candidate of candidates) {
        const date = coerceDate(candidate);
        if (date)
            return date;
    }
    return null;
}
export function resolveMode(requestedMode, defaultMode = 'plan') {
    const normalizedDefault = normalizeModeValue(defaultMode);
    if (!normalizedDefault) {
        throw new Error(`Invalid default mode '${defaultMode}'. Use 'plan' or 'edit'.`);
    }
    if (requestedMode !== null && requestedMode !== undefined) {
        const normalizedMode = normalizeModeValue(requestedMode);
        if (!normalizedMode) {
            throw new Error(`Invalid mode '${requestedMode}'. Valid modes: 'plan' (read-only) or 'edit' (can write).`);
        }
        return normalizedMode;
    }
    return normalizedDefault;
}
function findExecutableOnPath(executable) {
    const hasSeparator = executable.includes(path.sep) || (process.platform === 'win32' && executable.includes('/'));
    const pathCandidate = hasSeparator || path.isAbsolute(executable) ? executable : null;
    const isFileUsable = (candidatePath) => {
        if (!existsSync(candidatePath))
            return false;
        if (process.platform === 'win32')
            return true;
        try {
            accessSync(candidatePath, fsConstants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    };
    const tryWithExtensions = (basePath, extensions) => {
        if (path.extname(basePath)) {
            if (isFileUsable(basePath))
                return basePath;
            return null;
        }
        if (isFileUsable(basePath))
            return basePath;
        for (const ext of extensions) {
            const candidate = basePath + ext;
            if (isFileUsable(candidate))
                return candidate;
        }
        return null;
    };
    if (pathCandidate) {
        const extensions = process.platform === 'win32'
            ? ['.exe', '.cmd', '.bat', '.ps1']
            : [''];
        return tryWithExtensions(path.resolve(pathCandidate), extensions);
    }
    const envPath = process.env.PATH || '';
    const pathParts = envPath.split(path.delimiter).filter(Boolean);
    if (process.platform === 'win32') {
        const pathextRaw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
        const pathext = pathextRaw
            .split(';')
            .map(e => e.trim())
            .filter(Boolean)
            .map(e => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
        const extra = ['.exe', '.cmd', '.bat', '.ps1'];
        const extensions = Array.from(new Set([...pathext, ...extra]));
        for (const dir of pathParts) {
            const base = path.join(dir, executable);
            const found = tryWithExtensions(base, extensions);
            if (found)
                return found;
        }
        return null;
    }
    for (const dir of pathParts) {
        const candidate = path.join(dir, executable);
        if (isFileUsable(candidate))
            return candidate;
    }
    return null;
}
export function checkCliAvailable(agentType) {
    const cmdTemplate = AGENT_COMMANDS[agentType];
    if (!cmdTemplate) {
        return [false, `Unknown agent type: ${agentType}`];
    }
    const executable = cmdTemplate[0];
    const resolvedPath = findExecutableOnPath(executable);
    if (resolvedPath)
        return [true, resolvedPath];
    return [false, `CLI tool '${executable}' not found in PATH. Install it first.`];
}
export function checkAllClis() {
    const results = {};
    for (const agentType of Object.keys(AGENT_COMMANDS)) {
        const [available, pathOrError] = checkCliAvailable(agentType);
        if (available) {
            results[agentType] = { installed: true, path: pathOrError, error: null };
        }
        else {
            results[agentType] = { installed: false, path: null, error: pathOrError };
        }
    }
    return results;
}
let AGENTS_DIR = null;
export async function getAgentsDir() {
    if (!AGENTS_DIR) {
        AGENTS_DIR = await resolveAgentsDir();
    }
    return AGENTS_DIR;
}
export class AgentProcess {
    agentId;
    taskName;
    agentType;
    prompt;
    cwd;
    workspaceDir;
    mode = 'plan';
    pid = null;
    status = AgentStatus.RUNNING;
    startedAt = new Date();
    completedAt = null;
    parentSessionId = null;
    eventsCache = [];
    lastReadPos = 0;
    baseDir = null;
    constructor(agentId, taskName, agentType, prompt, cwd = null, mode = 'plan', pid = null, status = AgentStatus.RUNNING, startedAt = new Date(), completedAt = null, baseDir = null, parentSessionId = null, workspaceDir = null) {
        this.agentId = agentId;
        this.taskName = taskName;
        this.agentType = agentType;
        this.prompt = prompt;
        this.cwd = cwd;
        this.workspaceDir = workspaceDir;
        this.mode = mode;
        this.pid = pid;
        this.status = status;
        this.startedAt = startedAt;
        this.completedAt = completedAt;
        this.baseDir = baseDir;
        this.parentSessionId = parentSessionId;
    }
    get isEditMode() {
        return this.mode === 'edit';
    }
    async getAgentDir() {
        const base = this.baseDir || await getAgentsDir();
        return path.join(base, this.agentId);
    }
    async getStdoutPath() {
        return path.join(await this.getAgentDir(), 'stdout.log');
    }
    async getMetaPath() {
        return path.join(await this.getAgentDir(), 'meta.json');
    }
    toDict() {
        return {
            agent_id: this.agentId,
            task_name: this.taskName,
            agent_type: this.agentType,
            status: this.status,
            started_at: this.startedAt.toISOString(),
            completed_at: this.completedAt?.toISOString() || null,
            event_count: this.events.length,
            duration: this.duration(),
            mode: this.mode,
            parent_session_id: this.parentSessionId,
            workspace_dir: this.workspaceDir,
        };
    }
    duration() {
        let seconds;
        if (this.completedAt) {
            seconds = (this.completedAt.getTime() - this.startedAt.getTime()) / 1000;
        }
        else if (this.status === AgentStatus.RUNNING) {
            seconds = (Date.now() - this.startedAt.getTime()) / 1000;
        }
        else {
            return null;
        }
        if (seconds < 60) {
            return `${Math.floor(seconds)} seconds`;
        }
        else {
            const minutes = seconds / 60;
            return `${minutes.toFixed(1)} minutes`;
        }
    }
    get events() {
        return this.eventsCache;
    }
    /**
     * Return the latest timestamp we have seen in the agent's events.
     * Falls back to null when none are available.
     */
    getLatestEventTime() {
        let latest = null;
        for (const event of this.eventsCache) {
            const ts = event?.timestamp;
            if (!ts)
                continue;
            const parsed = new Date(ts);
            if (!Number.isNaN(parsed.getTime())) {
                if (!latest || parsed > latest) {
                    latest = parsed;
                }
            }
        }
        return latest;
    }
    async readNewEvents() {
        const stdoutPath = await this.getStdoutPath();
        try {
            const stats = await fs.stat(stdoutPath).catch(() => null);
            if (!stats)
                return;
            const fallbackTimestamp = (stats.mtime || new Date()).toISOString();
            const fd = await fs.open(stdoutPath, 'r');
            const buffer = Buffer.alloc(1024 * 1024);
            const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.lastReadPos);
            await fd.close();
            if (bytesRead === 0)
                return;
            const newContent = buffer.toString('utf-8', 0, bytesRead);
            this.lastReadPos += bytesRead;
            const lines = newContent.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                try {
                    const rawEvent = JSON.parse(line);
                    // Exit code sentinel written by buildWindowsSpawnPs1() — use the real
                    // process exit code to set COMPLETED/FAILED instead of guessing.
                    if (rawEvent && typeof rawEvent === 'object' && '__exit_code__' in rawEvent) {
                        const exitCode = rawEvent.__exit_code__;
                        if (exitCode === 0) {
                            this.status = AgentStatus.COMPLETED;
                        }
                        else {
                            this.status = AgentStatus.FAILED;
                        }
                        this.completedAt = new Date(fallbackTimestamp);
                        continue;
                    }
                    const events = normalizeEvents(this.agentType, rawEvent);
                    const resolvedTimestamp = extractTimestamp(rawEvent)?.toISOString() || fallbackTimestamp;
                    for (const event of events) {
                        event.timestamp = resolvedTimestamp;
                        this.eventsCache.push(event);
                        if (event.type === 'result' || event.type === 'turn.completed' || event.type === 'thread.completed') {
                            if (event.status === 'success' || event.type === 'turn.completed') {
                                this.status = AgentStatus.COMPLETED;
                                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
                            }
                            else if (event.status === 'error') {
                                this.status = AgentStatus.FAILED;
                                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
                            }
                        }
                    }
                }
                catch {
                    // Suppress noisy node-pty AttachConsole stack traces emitted by gemini
                    // helper processes on Windows; they are not actionable errors.
                    const isGeminiWin32Noise = this.agentType === 'gemini' &&
                        process.platform === 'win32' &&
                        (line.includes('AttachConsole failed') ||
                            line.includes('conpty_console_list_agent') ||
                            (line.includes('@lydell') && line.includes('node-pty')));
                    if (!isGeminiWin32Noise) {
                        // Copilot CLI outputs plain text (no JSON mode).
                        // Emit as 'message' events so the summarizer can surface them in status.
                        if (this.agentType === 'copilot') {
                            this.eventsCache.push({
                                type: 'message',
                                agent: 'copilot',
                                content: line,
                                complete: true,
                                timestamp: fallbackTimestamp,
                            });
                        }
                        else {
                            this.eventsCache.push({
                                type: 'raw',
                                content: line,
                                timestamp: fallbackTimestamp,
                            });
                        }
                    }
                }
            }
        }
        catch (err) {
            console.error(`Error reading events for agent ${this.agentId}:`, err);
        }
    }
    async saveMeta() {
        const agentDir = await this.getAgentDir();
        await fs.mkdir(agentDir, { recursive: true });
        const meta = {
            agent_id: this.agentId,
            task_name: this.taskName,
            agent_type: this.agentType,
            prompt: this.prompt,
            cwd: this.cwd,
            workspace_dir: this.workspaceDir,
            mode: this.mode,
            pid: this.pid,
            status: this.status,
            started_at: this.startedAt.toISOString(),
            completed_at: this.completedAt?.toISOString() || null,
            parent_session_id: this.parentSessionId,
        };
        const metaPath = await this.getMetaPath();
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    }
    static async loadFromDisk(agentId, baseDir = null) {
        const base = baseDir || await getAgentsDir();
        const agentDir = path.join(base, agentId);
        const metaPath = path.join(agentDir, 'meta.json');
        try {
            await fs.access(metaPath);
        }
        catch {
            return null;
        }
        try {
            const metaContent = await fs.readFile(metaPath, 'utf-8');
            const meta = JSON.parse(metaContent);
            const agent = new AgentProcess(meta.agent_id, meta.task_name || 'default', meta.agent_type, meta.prompt, meta.cwd || null, meta.mode === 'edit' ? 'edit' : 'plan', meta.pid || null, AgentStatus[meta.status] || AgentStatus.RUNNING, new Date(meta.started_at), meta.completed_at ? new Date(meta.completed_at) : null, baseDir, meta.parent_session_id || null, meta.workspace_dir || null);
            return agent;
        }
        catch {
            return null;
        }
    }
    isProcessAlive() {
        if (!this.pid)
            return false;
        try {
            process.kill(this.pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    async updateStatusFromProcess() {
        if (!this.pid)
            return;
        if (this.isProcessAlive()) {
            await this.readNewEvents();
            return;
        }
        if (this.status === AgentStatus.RUNNING) {
            const exitCode = await this.reapProcess();
            await this.readNewEvents();
            if (this.status === AgentStatus.RUNNING) {
                const fallbackCompletion = this.getLatestEventTime() || this.startedAt || new Date();
                if (exitCode !== null && exitCode !== 0) {
                    this.status = AgentStatus.FAILED;
                }
                else {
                    this.status = AgentStatus.COMPLETED;
                }
                this.completedAt = fallbackCompletion;
            }
        }
        else if (!this.completedAt) {
            await this.readNewEvents();
            const fallbackCompletion = this.getLatestEventTime() || this.startedAt || new Date();
            this.completedAt = fallbackCompletion;
        }
        await this.saveMeta();
    }
    async reapProcess() {
        if (!this.pid)
            return null;
        try {
            process.kill(this.pid, 0);
            return null;
        }
        catch {
            return 1;
        }
    }
}
export class AgentManager {
    agents = new Map();
    maxAgents;
    maxConcurrent;
    agentsDir = '';
    filterByCwd;
    cleanupAgeDays;
    defaultMode;
    effortModelMap;
    agentConfigs;
    constructorAgentConfigs = null;
    constructorAgentsDir = null;
    constructor(maxAgents = 50, maxConcurrent = 10, agentsDir = null, defaultMode = null, filterByCwd = null, cleanupAgeDays = 7, agentConfigs = null) {
        this.maxAgents = maxAgents;
        this.maxConcurrent = maxConcurrent;
        this.constructorAgentsDir = agentsDir;
        this.filterByCwd = filterByCwd;
        this.cleanupAgeDays = cleanupAgeDays;
        const resolvedDefaultMode = defaultMode ? normalizeModeValue(defaultMode) : defaultModeFromEnv();
        if (!resolvedDefaultMode) {
            throw new Error(`Invalid default_mode '${defaultMode}'. Use 'plan' or 'edit'.`);
        }
        this.defaultMode = resolvedDefaultMode;
        this.constructorAgentConfigs = agentConfigs;
        this.initialize();
    }
    getAgentsDirPath() {
        return this.agentsDir;
    }
    async initialize() {
        this.agentsDir = this.constructorAgentsDir || await getAgentsDir();
        await fs.mkdir(this.agentsDir, { recursive: true });
        // Set defaults if no config provided
        if (!this.constructorAgentConfigs) {
            this.agentConfigs = loadDefaultAgentConfigs();
            this.effortModelMap = resolveEffortModelMap(this.agentConfigs);
        }
        else {
            this.agentConfigs = this.constructorAgentConfigs;
            this.effortModelMap = resolveEffortModelMap(this.constructorAgentConfigs);
        }
        await this.loadExistingAgents();
    }
    getDefaultMode() {
        return this.defaultMode;
    }
    setModelOverrides(agentConfigs) {
        this.agentConfigs = agentConfigs;
        this.effortModelMap = resolveEffortModelMap(agentConfigs);
    }
    async loadExistingAgents() {
        try {
            await fs.access(this.agentsDir);
        }
        catch {
            return;
        }
        const cutoffDate = new Date(Date.now() - this.cleanupAgeDays * 24 * 60 * 60 * 1000);
        let loadedCount = 0;
        let skippedCwd = 0;
        let cleanedOld = 0;
        const entries = await fs.readdir(this.agentsDir);
        for (const entry of entries) {
            const agentDir = path.join(this.agentsDir, entry);
            const stat = await fs.stat(agentDir).catch(() => null);
            if (!stat || !stat.isDirectory())
                continue;
            const agentId = entry;
            const agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
            if (!agent)
                continue;
            if (agent.completedAt && agent.completedAt < cutoffDate) {
                try {
                    await fs.rm(agentDir, { recursive: true });
                    cleanedOld++;
                }
                catch (err) {
                    console.warn(`Failed to cleanup old agent ${agentId}:`, err);
                }
                continue;
            }
            if (this.filterByCwd !== null) {
                const agentCwd = agent.cwd;
                if (agentCwd !== this.filterByCwd) {
                    skippedCwd++;
                    continue;
                }
            }
            await agent.updateStatusFromProcess();
            this.agents.set(agentId, agent);
            loadedCount++;
        }
        if (cleanedOld > 0) {
            console.error(`Cleaned up ${cleanedOld} old agents (older than ${this.cleanupAgeDays} days)`);
        }
        if (skippedCwd > 0) {
            console.error(`Skipped ${skippedCwd} agents (different CWD)`);
        }
        console.error(`Loaded ${loadedCount} agents from disk`);
    }
    async spawn(taskName, agentType, prompt, cwd = null, mode = null, effort = 'default', parentSessionId = null, workspaceDir = null, model = null) {
        await this.initialize();
        const resolvedMode = resolveMode(mode, this.defaultMode);
        // Use explicit model when provided; otherwise resolve from effort level
        const resolvedModel = model?.trim() || this.effortModelMap[effort][agentType];
        const running = await this.listRunning();
        if (running.length >= this.maxConcurrent) {
            throw new Error(`Maximum concurrent agents (${this.maxConcurrent}) reached. Wait for an agent to complete or stop one first.`);
        }
        const [available, pathOrError] = checkCliAvailable(agentType);
        if (!available) {
            throw new Error(pathOrError || 'CLI tool not available');
        }
        // Resolve and validate cwd
        let resolvedCwd = null;
        if (cwd !== null) {
            resolvedCwd = path.resolve(cwd);
            const stat = await fs.stat(resolvedCwd).catch(() => null);
            if (!stat) {
                throw new Error(`Working directory does not exist: ${cwd}`);
            }
            if (!stat.isDirectory()) {
                throw new Error(`Working directory is not a directory: ${cwd}`);
            }
        }
        const agentId = randomUUID().substring(0, 8);
        const cmd = this.buildCommand(agentType, prompt, resolvedMode, resolvedModel, resolvedCwd);
        const agent = new AgentProcess(agentId, taskName, agentType, prompt, resolvedCwd, resolvedMode, null, AgentStatus.RUNNING, new Date(), null, this.agentsDir, parentSessionId, workspaceDir);
        const agentDir = await agent.getAgentDir();
        try {
            await fs.mkdir(agentDir, { recursive: true });
        }
        catch (err) {
            this.agents.delete(agent.agentId);
            throw new Error(`Failed to create agent directory: ${err.message}`);
        }
        console.error(`Spawning ${agentType} agent ${agentId} [${resolvedMode}]: ${cmd.slice(0, 3).join(' ')}...`);
        try {
            const stdoutPath = await agent.getStdoutPath();
            let spawnCmd;
            let spawnArgs;
            if (process.platform === 'win32') {
                // On Windows:
                // 1. File descriptor inheritance is unreliable for detached processes.
                // 2. Spawning CLI tools installed in npm global PATH requires a shell.
                // 3. PowerShell's *> uses UTF-16; we need UTF-8 JSON output.
                // 4. Prompt text contains spaces; a single Arguments string causes incorrect splitting.
                //
                // Solution: write a temporary PS1 script that uses ProcessStartInfo with
                // ArgumentList (available in pwsh / .NET Core) to pass each argument
                // verbatim, capture output as UTF-8, and write it to the log file.
                //
                const ps1 = buildWindowsSpawnPs1(cmd, stdoutPath, resolvedCwd || process.cwd());
                const tempScript = path.join(os.tmpdir(), `swarm-agent-${agentId}.ps1`);
                await fs.writeFile(tempScript, ps1, 'utf-8');
                // Ensure the output directory exists; the PS1 script creates the file.
                await fs.mkdir(path.dirname(stdoutPath), { recursive: true });
                spawnCmd = 'pwsh.exe';
                spawnArgs = ['-NoProfile', '-NonInteractive', '-File', tempScript];
            }
            else {
                const stdoutFile = await fs.open(stdoutPath, 'w');
                spawnCmd = cmd[0];
                spawnArgs = cmd.slice(1);
                const stdoutFd = stdoutFile.fd;
                stdoutFile.close().catch(() => { });
                // Unset CLAUDECODE so agent CLIs can start inside an existing Claude Code session.
                const childEnv = { ...process.env };
                delete childEnv['CLAUDECODE'];
                const childProcess = spawn(spawnCmd, spawnArgs, {
                    stdio: ['ignore', stdoutFd, stdoutFd],
                    cwd: resolvedCwd || undefined,
                    detached: true,
                    shell: false,
                    env: childEnv,
                });
                childProcess.unref();
                agent.pid = childProcess.pid || null;
                await agent.saveMeta();
                this.agents.set(agentId, agent);
                await this.cleanupOldAgents();
                console.error(`Spawned agent ${agentId} with PID ${agent.pid}`);
                return agent;
            }
            // Unset CLAUDECODE so agent CLIs (especially claude) can start inside an
            // existing Claude Code session without triggering the nested-session guard.
            const childEnv = { ...process.env };
            delete childEnv['CLAUDECODE'];
            // On Windows, pwsh.exe with detached:true + shell:false exits immediately
            // without executing the script (Windows CREATE_NEW_PROCESS_GROUP + pwsh
            // interaction bug). Use detached:false so the script runs correctly.
            // child.unref() still prevents the Node event loop from waiting for it.
            const isWindowsPs1 = process.platform === 'win32';
            const childProcess = spawn(spawnCmd, spawnArgs, {
                stdio: ['ignore', 'ignore', 'ignore'],
                cwd: resolvedCwd || undefined,
                detached: !isWindowsPs1,
                shell: false,
                env: childEnv,
            });
            childProcess.unref();
            agent.pid = childProcess.pid || null;
            await agent.saveMeta();
        }
        catch (err) {
            await this.cleanupPartialAgent(agent);
            console.error(`Failed to spawn agent ${agentId}:`, err);
            throw new Error(`Failed to spawn agent: ${err.message}`);
        }
        this.agents.set(agentId, agent);
        await this.cleanupOldAgents();
        console.error(`Spawned agent ${agentId} with PID ${agent.pid}`);
        return agent;
    }
    buildCommand(agentType, prompt, mode, model, cwd = null) {
        const isEditMode = mode === 'edit';
        // Build the full prompt with prefix (for plan mode) and suffix
        let fullPrompt = prompt + PROMPT_SUFFIX;
        // For Claude in plan mode, add prefix explaining headless plan mode restrictions
        if (agentType === 'claude' && !isEditMode) {
            fullPrompt = CLAUDE_PLAN_MODE_PREFIX + fullPrompt;
        }
        const configAgentCommand = this.agentConfigs?.[agentType]?.command?.trim() ?? '';
        // Prefer config command when present. This is a *template* override; when the command still
        // targets the known agent CLI (codex/claude/gemini/...), we keep applying the normal
        // post-processing (model injection, mode flags, etc.). If the user points to a different
        // executable, we treat it as fully custom and return it verbatim after {prompt} substitution.
        const baseTemplate = configAgentCommand
            ? splitCommandTemplate(configAgentCommand)
            : AGENT_COMMANDS[agentType];
        if (!baseTemplate)
            throw new Error(`Unknown agent type: ${agentType}`);
        const hasPromptPlaceholder = baseTemplate.some(part => part.includes('{prompt}'));
        if (!hasPromptPlaceholder) {
            throw new Error(`Agent config for '${agentType}' is missing the required {prompt} placeholder in its command. ` +
                `Config path: ~/.agents/swarm/config.json. ` +
                `Example fix: "my-cli run '{prompt}' --json"`);
        }
        let cmd = baseTemplate.map(part => part.replaceAll('{prompt}', fullPrompt));
        const isCompatibleCli = isCompatibleAgentCli(agentType, cmd[0]);
        if (!isCompatibleCli) {
            return cmd;
        }
        // For Claude agents, load user's settings.json to inherit permissions
        // and grant access to the working directory
        if (agentType === 'claude') {
            // Ensure required flags for stream-json print mode (older config files may omit these).
            cmd = ensureClaudeFlag(cmd, '--verbose');
            cmd = ensureClaudeFlag(cmd, '--permission-mode', 'plan');
            const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
            if (!cmd.includes('--settings'))
                cmd.push('--settings', settingsPath);
            if (cwd) {
                if (!cmd.includes('--add-dir'))
                    cmd.push('--add-dir', cwd);
            }
        }
        // For Gemini agents, ensure -p is present so the CLI runs headlessly
        // (without -p the gemini CLI tries to attach to an interactive console).
        if (agentType === 'gemini') {
            cmd = ensureGeminiHeadlessFlag(cmd, fullPrompt);
        }
        // For Gemini agents in plan mode, add --approval-mode plan to suppress tool
        // execution (e.g. shell calls like `echo OK`), which would otherwise trigger
        // node-pty/ConPTY AttachConsole errors on Windows.
        // Skip if --yolo or --approval-mode is already present in the command.
        if (agentType === 'gemini' && mode === 'plan') {
            if (!cmd.includes('--approval-mode') && !cmd.includes('--yolo')) {
                cmd.push('--approval-mode', 'plan');
            }
        }
        // Add model flag for each agent type
        if (cmd.includes('--model')) {
            // no-op
        }
        else if (agentType === 'codex') {
            const execIndex = cmd.indexOf('exec');
            const sandboxIndex = cmd.indexOf('--sandbox');
            const insertIndex = sandboxIndex !== -1 ? sandboxIndex : execIndex + 1;
            cmd.splice(insertIndex, 0, '--model', model);
        }
        else if (agentType === 'cursor') {
            cmd.push('--model', model);
        }
        else if (agentType === 'gemini' || agentType === 'claude') {
            cmd.push('--model', model);
        }
        else if (agentType === 'opencode') {
            const opencodeAgent = mode === 'edit' || mode === 'ralph' ? 'build' : 'plan';
            // Insert --agent flag after the prompt
            const promptIndex = cmd.indexOf(fullPrompt);
            if (promptIndex !== -1) {
                cmd.splice(promptIndex + 1, 0, '--agent', opencodeAgent);
            }
            cmd.push('--model', model);
        }
        else if (agentType === 'copilot') {
            cmd.push('--model', model);
        }
        if (mode === 'ralph') {
            cmd = this.applyRalphMode(agentType, cmd);
        }
        else if (isEditMode) {
            cmd = this.applyEditMode(agentType, cmd);
        }
        return cmd;
    }
    applyEditMode(agentType, cmd) {
        const editCmd = [...cmd];
        switch (agentType) {
            case 'codex':
                editCmd.push('--full-auto');
                break;
            case 'cursor':
                editCmd.push('-f');
                break;
            case 'gemini':
                // Gemini CLI uses --yolo flag for auto-approve
                editCmd.push('--yolo');
                break;
            case 'claude':
                const permModeIndex = editCmd.indexOf('--permission-mode');
                if (permModeIndex !== -1 && permModeIndex + 1 < editCmd.length) {
                    editCmd[permModeIndex + 1] = 'acceptEdits';
                }
                break;
            case 'copilot':
                editCmd.push('--allow-all-tools', '--allow-all-paths', '--no-ask-user');
                break;
        }
        return editCmd;
    }
    applyRalphMode(agentType, cmd) {
        const ralphCmd = [...cmd];
        switch (agentType) {
            case 'codex':
                ralphCmd.push('--full-auto');
                break;
            case 'cursor':
                ralphCmd.push('-f');
                break;
            case 'gemini':
                ralphCmd.push('--yolo');
                break;
            case 'claude':
                // Replace --permission-mode plan with --dangerously-skip-permissions
                const permModeIndex = ralphCmd.indexOf('--permission-mode');
                if (permModeIndex !== -1) {
                    ralphCmd.splice(permModeIndex, 2); // Remove --permission-mode and its value
                }
                ralphCmd.push('--dangerously-skip-permissions');
                break;
            case 'copilot':
                ralphCmd.push('--yolo');
                break;
        }
        return ralphCmd;
    }
    async get(agentId) {
        await this.initialize();
        let agent = this.agents.get(agentId) || null;
        if (agent) {
            await agent.readNewEvents();
            await agent.updateStatusFromProcess();
            return agent;
        }
        agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
        if (agent) {
            await agent.readNewEvents();
            await agent.updateStatusFromProcess();
            this.agents.set(agentId, agent);
            return agent;
        }
        return null;
    }
    async listAll() {
        const agents = Array.from(this.agents.values());
        for (const agent of agents) {
            await agent.readNewEvents();
            await agent.updateStatusFromProcess();
        }
        return agents;
    }
    async listRunning() {
        const all = await this.listAll();
        return all.filter(a => a.status === AgentStatus.RUNNING);
    }
    async listCompleted() {
        const all = await this.listAll();
        return all.filter(a => a.status !== AgentStatus.RUNNING);
    }
    async listByTask(taskName) {
        const all = await this.listAll();
        return all.filter(a => a.taskName === taskName);
    }
    async listByParentSession(parentSessionId) {
        const all = await this.listAll();
        return all.filter(a => a.parentSessionId === parentSessionId);
    }
    async stopByTask(taskName) {
        const agents = await this.listByTask(taskName);
        const stopped = [];
        const alreadyStopped = [];
        for (const agent of agents) {
            if (agent.status === AgentStatus.RUNNING) {
                const success = await this.stop(agent.agentId);
                if (success) {
                    stopped.push(agent.agentId);
                }
            }
            else {
                alreadyStopped.push(agent.agentId);
            }
        }
        return { stopped, alreadyStopped };
    }
    async stop(agentId) {
        await this.initialize();
        const agent = this.agents.get(agentId);
        if (!agent) {
            return false;
        }
        if (agent.pid && agent.status === AgentStatus.RUNNING) {
            try {
                process.kill(-agent.pid, 'SIGTERM');
                console.error(`Sent SIGTERM to agent ${agentId} (PID ${agent.pid})`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (agent.isProcessAlive()) {
                    process.kill(-agent.pid, 'SIGKILL');
                    console.error(`Sent SIGKILL to agent ${agentId}`);
                }
            }
            catch {
            }
            agent.status = AgentStatus.STOPPED;
            agent.completedAt = new Date();
            await agent.saveMeta();
            console.error(`Stopped agent ${agentId}`);
            return true;
        }
        return false;
    }
    async cleanupPartialAgent(agent) {
        this.agents.delete(agent.agentId);
        try {
            const agentDir = await agent.getAgentDir();
            await fs.rm(agentDir, { recursive: true });
        }
        catch (err) {
            console.warn(`Failed to clean up agent directory:`, err);
        }
    }
    async cleanupOldAgents() {
        const completed = await this.listCompleted();
        if (completed.length > this.maxAgents) {
            completed.sort((a, b) => {
                const aTime = a.completedAt?.getTime() || 0;
                const bTime = b.completedAt?.getTime() || 0;
                return aTime - bTime;
            });
            for (const agent of completed.slice(0, completed.length - this.maxAgents)) {
                this.agents.delete(agent.agentId);
                try {
                    const agentDir = await agent.getAgentDir();
                    await fs.rm(agentDir, { recursive: true });
                }
                catch (err) {
                    console.warn(`Failed to cleanup old agent ${agent.agentId}:`, err);
                }
            }
        }
    }
}
//# sourceMappingURL=agents.js.map