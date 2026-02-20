export interface CacheData {
    version?: {
        latest: string;
        checkedAt: number;
    };
}
interface VersionStatus {
    current: string;
    latest: string | null;
    isOutOfDate: boolean;
    status: 'current' | 'outdated' | 'unknown';
}
type ClientType = 'claude' | 'codex' | 'gemini' | 'unknown';
export declare const CACHE_DIR: string;
export declare const CACHE_FILE: string;
export declare const CACHE_TTL_MS: number;
export declare function getCurrentVersion(): string;
export declare function loadCache(): CacheData;
export declare function saveCache(data: CacheData): void;
export declare function isNewerVersion(current: string, latest: string): boolean;
export declare function initVersionCheck(): Promise<VersionStatus>;
export declare function setDetectedClient(client: ClientType): void;
export declare function detectClientFromName(name: string | undefined): ClientType;
export declare function buildVersionNotice(): string;
export declare function getVersionStatus(): VersionStatus | null;
export {};
//# sourceMappingURL=version.d.ts.map