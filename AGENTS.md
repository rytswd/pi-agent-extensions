# Project Context for Claude

This is **pi-agent-extensions** — a collection of [pi](https://github.com/mariozechner/pi) coding agent extensions.

## Quick Reference

- **What**: TypeScript extensions for the pi coding agent
- **Where**: `~/.pi/agent/extensions/` (global auto-discovery)
- **How**: Each `.ts` file exports a default function receiving `ExtensionAPI`

## Current Extensions

| File | Description |
|------|-------------|
| `direnv.ts` | Loads direnv environment variables on session start and after bash commands |
| `fetch.ts` | HTTP request tool — fetches URLs, downloads files, shows curl equivalent |
| `questionnaire.ts` | Multi-question tool for LLM-driven user input |
| `slow-mode.ts` | Review gate for write/edit tool calls — toggle with `/slowmode` |

## Essential Context

Review these files for project understanding:
- `./air/context/OVERVIEW.md` — Project overview and structure
- `./air/context/architecture.md` — How extensions work, key APIs
- `./air/context/implementation-guide.md` — How to write new extensions
- `./air/context/interface-design.md` — UI patterns and conventions
- `./air/context/air-conventions.md` — Documentation conventions
- `./air/context/air-workflow.md` — Development workflow

## Before Implementation

1. Check current status: `airctl status`
2. Read the relevant Air document in `./air/`
3. Follow patterns established in existing extensions (see `direnv.ts`)
4. Update `README.org` when adding new extensions

## Key Patterns

- Always check `ctx.hasUI` before UI calls
- Use status bar for ongoing state, notifications for one-time events
- Serialise concurrent access to shared resources
- Implement timeouts for external processes
- Handle errors gracefully — never throw from event handlers
