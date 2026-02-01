# Implementation Guide

## Development Environment

- **Language**: TypeScript (loaded by pi via jiti — no compilation needed)
- **Runtime**: Node.js (provided by pi)
- **Extension API**: `@mariozechner/pi-coding-agent`
- **Schema Library**: `@sinclair/typebox` (for tool parameter definitions)

No build step, no bundler, no tsconfig required. Just write `.ts` files.

## Extension Location

Extensions live in `~/.pi/agent/extensions/` for global auto-discovery.

```
~/.pi/agent/extensions/
├── extension-name.ts           # Single-file extension
└── complex-extension/          # Multi-file extension
    ├── index.ts                # Entry point
    ├── helpers.ts
    └── package.json            # If npm deps are needed
```

## Coding Standards

### TypeScript Style
- Use `import type` for type-only imports
- Prefer `async/await` over raw promises
- Use Node.js built-ins (`node:child_process`, `node:fs`, etc.) with the `node:` prefix
- Keep extensions focused — one concern per file

### Error Handling
- Never throw from event handlers — catch and handle gracefully
- Use `ctx.ui.notify(msg, "error")` or `ctx.ui.setStatus()` to surface errors to the user
- Degrade gracefully when external tools are missing (e.g., direnv not installed)

### UI Interaction
- Always check `ctx.hasUI` before accessing `ctx.ui`
- Use status bar (`ctx.ui.setStatus`) for ongoing state indicators
- Use notifications (`ctx.ui.notify`) for one-time messages
- Use theming (`ctx.ui.theme.fg("success", ...)`) for consistent colours

### Process Management
- Use `spawn` from `node:child_process` for external processes
- Implement timeouts for processes that might hang
- Serialise concurrent access to the same resource (see direnv's `pending` pattern)
- Clean up resources on process exit

## Writing a New Extension

### Minimal Template

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("Extension loaded!", "info");
    }
  });
}
```

### With a Custom Tool

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful",
    parameters: Type.Object({
      input: Type.String({ description: "Input value" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return {
        content: [{ type: "text", text: `Result: ${params.input}` }],
        details: {},
      };
    },
  });
}
```

### With a Custom Command

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("mycommand", {
    description: "Does something when you type /mycommand",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Called with: ${args || "(no args)"}`, "info");
    },
  });
}
```

## Testing Extensions

Pi doesn't have a built-in test framework for extensions. To test:

1. **Manual testing**: Load the extension with `pi -e ./extension.ts` and exercise the functionality
2. **Hot reload**: Extensions in `~/.pi/agent/extensions/` can be reloaded with `/reload` in pi
3. **Logging**: Use `console.log` / `console.error` for debugging (output goes to pi's log)

## Common Patterns

### Filtering by Tool Name
```typescript
pi.on("tool_result", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  // Only runs after bash commands
});
```

### Serialised Execution
```typescript
let pending: Promise<void> | null = null;

async function doWork() {
  if (pending) await pending;
  pending = actualWork();
  await pending;
  pending = null;
}
```

### Timeout Racing
```typescript
const done = doExpensiveThing();
const timeout = new Promise<void>(resolve => setTimeout(resolve, 10_000));
await Promise.race([done, timeout]);
```
