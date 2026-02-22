import * as os from "os";
import * as path from "path";
export function getRalphConfig() {
    const ralphFile = process.env.AGENTS_MCP_RALPH_FILE || "RALPH.md";
    const disabledStr = process.env.AGENTS_MCP_DISABLE_RALPH || "false";
    const disabled = disabledStr === "true" || disabledStr === "1";
    return {
        ralphFile,
        disabled
    };
}
export function isDangerousPath(cwd) {
    const dangerousPaths = [
        // Home itself is dangerous, but project subdirectories under home are common and should be allowed.
        { p: os.homedir(), includeChildren: false },
        // System roots should be blocked recursively.
        { p: "/", includeChildren: true },
        { p: "/System", includeChildren: true },
        { p: "/usr", includeChildren: true },
        { p: "/bin", includeChildren: true },
        { p: "/sbin", includeChildren: true },
        { p: "/etc", includeChildren: true }
    ];
    const normalizedCwd = path.resolve(cwd);
    for (const { p, includeChildren } of dangerousPaths) {
        const normalizedDangerous = path.resolve(p);
        if (normalizedCwd === normalizedDangerous)
            return true;
        if (includeChildren && normalizedCwd.startsWith(normalizedDangerous + path.sep))
            return true;
    }
    return false;
}
export function buildRalphPrompt(userPrompt, ralphFilePath) {
    return `${userPrompt}

RALPH MODE INSTRUCTIONS:

You are running in autonomous Ralph mode. Your mission:

1. READ THE TASK FILE: Open ${ralphFilePath} and read all tasks
2. UNDERSTAND THE SYSTEM: Read AGENTS.md, README.md, or grep for relevant context to understand the codebase
3. PICK TASKS LOGICALLY: Work through unchecked tasks (## [ ]) in an order that makes sense (not necessarily top-to-bottom)
4. COMPLETE EACH TASK:
   - Do the work required
   - Mark the task complete by changing ## [ ] to ## [x] in ${ralphFilePath}
   - Add a brief 1-line update under the ### Updates section for that task
5. CONTINUE: Keep going until all tasks are checked or you determine you're done

TASK FORMAT:
- Unchecked: ## [ ] Task Title
- Checked: ## [x] Task Title
- Updates go under ### Updates section (one line per update)

Example update:
### Updates
- Added JWT token generation and validation
- Completed: All auth endpoints working with tests passing

Work autonomously. Don't stop until all tasks are complete.`;
}
//# sourceMappingURL=ralph.js.map