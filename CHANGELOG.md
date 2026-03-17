# Changelog

## 0.2.16 (2026-03-17)

- fix: codex ralph mode no longer emits `--dangerously-bypass-approvals-and-sandbox` alongside `--full-auto`; the two flags are mutually exclusive and caused a launch conflict for Codex sub-agents
- fix: added regression tests covering codex edit-mode and ralph-mode flag combinations to catch this class of conflict in future

## 0.2.13 (2026-02-23)

- fix: stream stdout to log file on Windows for real-time monitoring
- fix: prevent wait command from prematurely marking running agents as completed

## 2026-01-07

- Added a changelog file.
- Rewrote README to focus on MCP ecosystem needs and agent orchestration value.
