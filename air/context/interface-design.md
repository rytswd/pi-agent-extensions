# Interface Design

## Overview

Pi extensions interact with users through pi's built-in UI primitives. There is no custom CLI or web interface — all user-facing output goes through the `ExtensionContext` UI API.

## UI Primitives

### Status Bar (`ctx.ui.setStatus`)
Persistent indicators in pi's footer. Ideal for ongoing state.

```typescript
ctx.ui.setStatus("key", ctx.ui.theme.fg("warning", "working …"));
ctx.ui.setStatus("key", ctx.ui.theme.fg("success", "done ✓"));
ctx.ui.setStatus("key", ctx.ui.theme.fg("error", "failed ✗"));
```

**Conventions:**
- Use the extension name as the status key (e.g., `"direnv"`)
- Keep status text short — it shares space with other indicators
- Use consistent symbols: `…` (in progress), `✓` (success), `✗` (error)
- Apply theme colours: `"warning"` for in-progress, `"success"` for done, `"error"` for failures

### Notifications (`ctx.ui.notify`)
One-time messages. Use for events the user should notice but don't need persistent display.

```typescript
ctx.ui.notify("Environment loaded", "success");
ctx.ui.notify("Something went wrong", "error");
ctx.ui.notify("FYI: using fallback", "info");
```

### Interactive Prompts
For extensions that need user input:

```typescript
const ok = await ctx.ui.confirm("Title", "Are you sure?");
const choice = await ctx.ui.select("Pick one", ["a", "b", "c"]);
const value = await ctx.ui.input("Enter value");
```

### Widgets (`ctx.ui.setWidget`)
Multi-line display above the editor. Use sparingly.

```typescript
ctx.ui.setWidget("key", ["Line 1", "Line 2"]);
```

## Design Guidelines

### Check for UI Availability
Always guard UI calls — extensions may run in headless mode:

```typescript
if (ctx.hasUI) {
  ctx.ui.setStatus("myext", "loading…");
}
```

### Be Quiet by Default
- Don't notify on routine success — use status bar instead
- Only notify for unexpected events or errors
- Avoid spamming the user with frequent updates

### Use Consistent Theming
- Use `ctx.ui.theme.fg(semantic, text)` for coloured output
- Semantic colours: `"success"`, `"error"`, `"warning"`, `"info"`
- Don't hardcode ANSI codes

### Keep It Non-Blocking
- Don't use `ctx.ui.confirm()` on hot paths (like `tool_result`)
- Reserve interactive prompts for `tool_call` interception or explicit commands
- Status bar and notifications are fire-and-forget
