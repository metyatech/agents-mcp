export interface RalphConfig {
    ralphFile: string;
    disabled: boolean;
}
export declare function getRalphConfig(): RalphConfig;
export declare function isDangerousPath(cwd: string): boolean;
export declare function buildRalphPrompt(userPrompt: string, ralphFilePath: string): string;
//# sourceMappingURL=ralph.d.ts.map