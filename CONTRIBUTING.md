# Contributing

Thank you for your interest in contributing to `@metyatech/agents-mcp`.

## Development setup

```bash
git clone https://github.com/metyatech/agents-mcp.git
cd agents-mcp
npm install
npm run verify   # lint + format check + typecheck + test + build
```

## Submitting changes

1. Fork the repository and create a feature branch.
2. Add or update tests for any changed behavior.
3. Run `npm run verify` and ensure all checks pass.
4. Open a pull request with a clear description of the change.

## Code style

- TypeScript strict mode is required.
- Format with Prettier (`npm run format`).
- Lint with ESLint (`npm run lint`).

## Scope

This package is an MCP server for multi-agent orchestration. It enables spawning and managing
Claude, Codex, Gemini, and Cursor agents from a single server. Keep PRs scoped to agent
orchestration concerns.
