# Architecture

## Overview

This project is a flat collection of pi extensions — there is no complex architecture, build system, or shared runtime. Each extension is a self-contained TypeScript module that pi loads independently.

## Design Principles

### Single-File Extensions
- Each extension is one `.ts` file (or a directory with `index.ts` for multi-file cases)
- No shared state between extensions
- No build step required — pi uses jiti for on-the-fly TypeScript loading

### Event-Driven
- Extensions hook into pi's lifecycle via `pi.on("event_name", handler)`
- Key events: `session_start`, `tool_call`, `tool_result`, `turn_start`, `turn_end`
- Handlers receive an `ExtensionContext` with access to UI, cwd, and session state

### Non-Blocking
- Long-running operations (like direnv) use timeouts and background completion
- Serialisation where needed (e.g., one direnv process at a time) to avoid race conditions

## Extension Anatomy

Every extension exports a default function:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register event handlers
  pi.on("session_start", async (event, ctx) => { ... });
  pi.on("tool_result", async (event, ctx) => { ... });

  // Optionally register tools, commands, shortcuts
  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
}
```

### Key APIs

| API | Purpose |
|-----|---------|
| `pi.on(event, handler)` | Subscribe to lifecycle events |
| `pi.registerTool(def)` | Register a tool the LLM can call |
| `pi.registerCommand(name, def)` | Register a `/command` |
| `ctx.ui.setStatus(key, text)` | Show status in the footer bar |
| `ctx.ui.notify(msg, level)` | Show a notification |
| `ctx.cwd` | Current working directory |
| `ctx.hasUI` | Whether UI is available (false in headless mode) |

## Current Extensions

### direnv.ts

```
session_start ──► loadDirenv(cwd) ──► spawn direnv export json
                                          │
tool_result (bash) ──► loadDirenv(cwd)    ├─► parse JSON env vars
                                          ├─► apply to process.env
                                          └─► update status bar
```

Key design decisions:
- **Serialisation**: Uses a `pending` promise to ensure only one direnv process at a time
- **Timeout**: 10s inline wait; if direnv takes longer, it finishes in the background
- **Idempotent**: Empty output (no changes) is treated as success

## Adding a New Extension

1. Create `extension-name.ts` in the project root
2. Export a default function receiving `ExtensionAPI`
3. Register event handlers and/or tools
4. pi auto-discovers it on next session (or use `/reload`)

For extensions with npm dependencies, create a subdirectory with `package.json` and `index.ts`.
