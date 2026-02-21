import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir, tmpdir } from 'os';
import { constants as fsConstants } from 'fs';
// All supported swarm agent types
const ALL_AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
// Swarm data lives under ~/.agents/swarm/
const SWARM_DIR = path.join(homedir(), '.agents', 'swarm');
// Legacy paths (for migration)
const LEGACY_CONFIG_DIR = path.join(homedir(), '.agents');
const LEGACY_BASE_DIR = path.join(homedir(), '.swarmify');
const TMP_FALLBACK_DIR = path.join(tmpdir(), 'agents');
async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureWritableDir(p) {
    try {
        await fs.mkdir(p, { recursive: true });
        await fs.access(p, fsConstants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function resolveBaseDir() {
    if (await ensureWritableDir(SWARM_DIR)) {
        return SWARM_DIR;
    }
    if (await ensureWritableDir(TMP_FALLBACK_DIR)) {
        console.warn(`[agents-mcp] Falling back to temp data dir at ${TMP_FALLBACK_DIR}`);
        return TMP_FALLBACK_DIR;
    }
    throw new Error('Unable to determine writable data directory for swarm');
}
async function resolveAgentsPath() {
    const base = await resolveBaseDir();
    return path.join(base, 'agents');
}
async function resolveConfigPath() {
    await fs.mkdir(SWARM_DIR, { recursive: true });
    return path.join(SWARM_DIR, 'config.json');
}
async function resolveLegacyConfigPath() {
    return path.join(LEGACY_CONFIG_DIR, 'config.json');
}
async function resolveLegacySwarmifyConfigPath() {
    return path.join(LEGACY_BASE_DIR, 'agents', 'config.json');
}
let AGENTS_DIR = null;
let CONFIG_PATH = null;
export async function resolveAgentsDir() {
    if (!AGENTS_DIR) {
        AGENTS_DIR = await resolveAgentsPath();
    }
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    return AGENTS_DIR;
}
async function ensureConfigPath() {
    if (!CONFIG_PATH) {
        CONFIG_PATH = await resolveConfigPath();
    }
    const dir = path.dirname(CONFIG_PATH);
    await fs.mkdir(dir, { recursive: true });
    return CONFIG_PATH;
}
// Get default agent configuration
function getDefaultAgentConfig(agentType) {
    const defaults = {
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
        }
    };
    return defaults[agentType];
}
// Get default provider configuration
function getDefaultProviderConfig() {
    return {
        anthropic: {
            apiEndpoint: 'https://api.anthropic.com'
        },
        openai: {
            apiEndpoint: 'https://api.openai.com/v1'
        },
        google: {
            apiEndpoint: 'https://generativelanguage.googleapis.com/v1'
        },
        custom: {
            apiEndpoint: null
        }
    };
}
// Get default full configuration
function getDefaultSwarmConfig() {
    const agents = {};
    for (const agentType of ALL_AGENTS) {
        agents[agentType] = getDefaultAgentConfig(agentType);
    }
    return {
        agents,
        providers: getDefaultProviderConfig()
    };
}
// Try to read a config file as either SwarmConfig or legacy format
async function tryReadLegacyConfig(configPath) {
    try {
        const data = await fs.readFile(configPath, 'utf-8');
        const parsed = JSON.parse(data);
        // New format: has agents object with nested configs
        if (parsed.agents && typeof parsed.agents === 'object') {
            const firstValue = Object.values(parsed.agents)[0];
            if (firstValue && typeof firstValue === 'object' && 'models' in firstValue) {
                return parsed;
            }
        }
        // Old format: { enabledAgents: string[] }
        if (parsed.enabledAgents && Array.isArray(parsed.enabledAgents)) {
            const defaultConfig = getDefaultSwarmConfig();
            for (const agentType of parsed.enabledAgents) {
                if (ALL_AGENTS.includes(agentType)) {
                    defaultConfig.agents[agentType].enabled = true;
                }
            }
            return defaultConfig;
        }
        return null;
    }
    catch {
        return null;
    }
}
// Migrate from legacy config locations
async function migrateLegacyConfig() {
    // Try ~/.agents/config.json first (most recent legacy location)
    const legacyConfigPath = await resolveLegacyConfigPath();
    let config = await tryReadLegacyConfig(legacyConfigPath);
    // Try ~/.swarmify/agents/config.json
    if (!config) {
        const swarmifyConfigPath = await resolveLegacySwarmifyConfigPath();
        config = await tryReadLegacyConfig(swarmifyConfigPath);
    }
    if (!config)
        return null;
    // Write migrated config to new location
    const newConfigPath = await ensureConfigPath();
    await fs.writeFile(newConfigPath, JSON.stringify(config, null, 2));
    console.warn(`[agents-mcp] Migrated config to ${newConfigPath}`);
    return config;
}
// Read swarm config, returns default config if file doesn't exist
export async function readConfig() {
    const configPath = await ensureConfigPath();
    // Try to read new config first
    try {
        const data = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(data);
        const enabledAgents = [];
        const agentConfigs = {};
        const providerConfigs = {};
        // Parse agent configs
        if (config.agents && typeof config.agents === 'object') {
            for (const [agentKey, agentValue] of Object.entries(config.agents)) {
                if (!ALL_AGENTS.includes(agentKey))
                    continue;
                const agentType = agentKey;
                // Merge with defaults for missing fields
                const defaultAgentConfig = getDefaultAgentConfig(agentType);
                const mergedAgentConfig = {
                    ...defaultAgentConfig,
                    ...agentValue
                };
                if (mergedAgentConfig.enabled) {
                    enabledAgents.push(agentType);
                }
                agentConfigs[agentType] = mergedAgentConfig;
            }
        }
        // Fill in missing agents with defaults
        for (const agentType of ALL_AGENTS) {
            if (!agentConfigs[agentType]) {
                agentConfigs[agentType] = getDefaultAgentConfig(agentType);
            }
        }
        // Parse provider configs
        if (config.providers && typeof config.providers === 'object') {
            for (const [providerKey, providerValue] of Object.entries(config.providers)) {
                const providerConfig = providerValue;
                providerConfigs[providerKey] = providerConfig;
            }
        }
        // Fill in missing providers with defaults
        const defaultProviders = getDefaultProviderConfig();
        for (const [providerKey, providerValue] of Object.entries(defaultProviders)) {
            if (!providerConfigs[providerKey]) {
                providerConfigs[providerKey] = providerValue;
            }
        }
        return { enabledAgents, agentConfigs, providerConfigs, hasConfig: true };
    }
    catch {
        // Config doesn't exist or is invalid, try migration
        const migratedConfig = await migrateLegacyConfig();
        if (migratedConfig) {
            const enabledAgents = [];
            const agentConfigs = {};
            const providerConfigs = migratedConfig.providers;
            for (const [agentKey, agentValue] of Object.entries(migratedConfig.agents)) {
                const agentType = agentKey;
                agentConfigs[agentType] = agentValue;
                if (agentValue.enabled) {
                    enabledAgents.push(agentType);
                }
            }
            return { enabledAgents, agentConfigs, providerConfigs, hasConfig: true };
        }
        // No config and no legacy config, return defaults
        const defaultConfig = getDefaultSwarmConfig();
        const enabledAgents = [];
        const agentConfigs = defaultConfig.agents;
        const providerConfigs = defaultConfig.providers;
        for (const [agentKey, agentValue] of Object.entries(defaultConfig.agents)) {
            if (agentValue.enabled) {
                enabledAgents.push(agentKey);
            }
        }
        // Write default config to file
        await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
        return { enabledAgents, agentConfigs, providerConfigs, hasConfig: false };
    }
}
// Write swarm config
export async function writeConfig(config) {
    const configPath = await ensureConfigPath();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}
// Get model for agent type and effort level
export function getModelForAgent(agentConfigs, agentType, effort) {
    const agentConfig = agentConfigs[agentType];
    if (!agentConfig) {
        throw new Error(`Agent config not found for: ${agentType}`);
    }
    return agentConfig.models[effort];
}
// Update agent enabled status
export async function setAgentEnabled(agentType, enabled) {
    const { agentConfigs } = await readConfig();
    agentConfigs[agentType].enabled = enabled;
    const configPath = await ensureConfigPath();
    const config = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(config);
    if (!parsed.agents[agentType]) {
        parsed.agents[agentType] = getDefaultAgentConfig(agentType);
    }
    parsed.agents[agentType].enabled = enabled;
    await fs.writeFile(configPath, JSON.stringify(parsed, null, 2));
}
//# sourceMappingURL=persistence.js.map