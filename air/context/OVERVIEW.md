# Project Overview

## Description

**pi-agent-extensions** is a collection of [pi](https://github.com/mariozechner/pi) coding agent extensions that enhance the development experience. Extensions are standalone TypeScript files that plug into pi's event-driven extension system, providing additional capabilities like environment management, tool integration, and workflow automation.

## Core Principles

- **Drop-in simplicity** — Each extension is a single `.ts` file (or a directory with `index.ts`) that pi auto-discovers
- **Non-intrusive** — Extensions observe and enhance pi's behaviour without disrupting core functionality
- **Composable** — Extensions are independent; add or remove any without affecting others
- **Community-driven** — Built on ideas and contributions from the pi community

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js (via pi's [jiti](https://github.com/unjs/jiti) loader — no compilation needed)
- **Extension API**: `@mariozechner/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`)
- **Planning**: [Air](https://github.com/rytswd/air) for documentation-driven development

## Project Structure

```
~/.pi/agent/extensions/
├── statusline/         # Condensed status bar extension
├── direnv.ts           # Direnv integration extension
├── fetch.ts            # HTTP request tool extension
├── questionnaire.ts    # Multi-question tool for LLM-driven user input
├── slow-mode.ts        # Review gate for write/edit tool calls
├── AGENTS.md           # Agent context for AI assistants
├── README.org          # Project README
├── air-config.toml     # Air configuration
└── air/                # Air documentation
    ├── context/        # Project context files (this directory)
    ├── support-direnv.org
    ├── slow-mode.org
    ├── statusline.org
    └── SKILL.md
```

## Extensions

### statusline/
Provides a condensed status bar below the editor showing model info, subscription usage, context window, VCS status, and cost. Designed with zero npm dependencies and Nix-store compatibility by storing all configuration and cache in `~/.config/pi-statusline/`.

- **Architecture**: Multi-file extension with shared file-based cache and XDG config
- **Events**: `session_start`, `turn_end`, `tool_result` (write, edit, bash), `model_change`
- **Commands**: `/statusline`, `/statusline usage`, `/statusline bar`
- **Air doc**: `air/statusline.org`

### stash/
Save and restore editor text with Alt+S. Supports up to 9 stash slots with a picker (Enter=restore, x/d=delete). Status shows 📋 N in the statusline.

- **Shortcut**: Alt+S
- **Events**: `agent_end` (auto-restore), `session_start` (reset)

### notify/
Desktop notification when the agent finishes via terminal OSC escape sequences. Supports Ghostty, iTerm2, WezTerm, Kitty, and Windows Terminal.

- **Command**: `/notify` toggle
- **Events**: `agent_start`, `turn_start`, `tool_result`, `agent_end`
- **Env**: `PI_NO_NOTIFY=1` to disable at startup
- **Inspired by**: [aldoborrero/pi-agent-kit/notify](https://github.com/aldoborrero/pi-agent-kit/tree/main/extensions/notify)

### direnv/
Loads [direnv](https://direnv.net/) environment variables into pi sessions by prepending `direnv export bash` to every bash tool call. This ensures `.envrc` changes are always picked up.

- **Origin**: Based on [Mic92's implementation](https://github.com/Mic92/dotfiles/blob/main/home/.pi/agent/extensions/direnv.ts)
- **Events**: `tool_call` (bash only — prepends direnv export)

### questionnaire.ts
Registers a `questionnaire` tool that the LLM can call to ask the user single or multiple-choice questions. Supports tab navigation for multi-question flows, free-text "type something" option, and a submit review screen.

- **Mechanism**: `pi.registerTool()` — LLM decides when to call it
- **UI**: `ctx.ui.custom()` interactive component with keyboard navigation

### fetch.ts
Provides an HTTP request tool that the LLM can use to fetch URLs, download files, and make API calls. Displays curl equivalent commands and handles various content types including readability extraction for web pages.

- **Mechanism**: `pi.registerTool()` with support for GET/POST/PUT/PATCH/DELETE methods
- **Features**: File downloads, text-only extraction, readability mode, timeout handling
- **UI**: Shows curl equivalent and handles binary downloads

### slow-mode.ts
Intercepts `write` and `edit` tool calls to let the user review proposed changes before they are applied. New files are staged in a tmp directory; edits stage old/new files and display a unified diff. Toggle with `/slow-mode`. Use Ctrl+O to open in an external diff viewer.

- **Events**: `tool_call` (write, edit)
- **Command**: `/slow-mode` to toggle on/off
- **Status bar**: `slow ■` (active) · cleared (inactive)
- **External viewer**: Ctrl+O opens delta/vim/diff
- **Air doc**: `air/slow-mode.org`

## Current Focus

The core extensions (statusline, direnv, fetch, questionnaire, slow-mode) are complete and ready for use. The project now has zero npm dependencies, using only peerDependencies on pi's built-in packages for maximum compatibility.

Use `airctl status` to see planning documents and their states.
