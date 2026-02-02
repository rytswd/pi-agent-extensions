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
├── direnv.ts           # Direnv integration extension
├── questionnaire.ts    # Multi-question tool for LLM-driven user input
├── slow-mode.ts        # Review gate for write/edit tool calls
├── AGENTS.md           # Agent context for AI assistants
├── README.org          # Project README
├── air-config.toml     # Air configuration
└── air/                # Air documentation
    ├── context/        # Project context files (this directory)
    ├── support-direnv.org
    ├── slow-mode.org
    └── SKILL.md
```

## Extensions

### direnv.ts
Loads [direnv](https://direnv.net/) environment variables into pi sessions. Runs on session start and after every bash command to pick up `.envrc` changes. Displays status in the pi status bar.

- **Origin**: Based on [Mic92's implementation](https://github.com/Mic92/dotfiles/blob/main/home/.pi/agent/extensions/direnv.ts)
- **Events**: `session_start`, `tool_result` (bash only)
- **Status bar**: `direnv …` (running) · `direnv ✓` (loaded) · `direnv ✗` (error)

### questionnaire.ts
Registers a `questionnaire` tool that the LLM can call to ask the user single or multiple-choice questions. Supports tab navigation for multi-question flows, free-text "type something" option, and a submit review screen.

- **Mechanism**: `pi.registerTool()` — LLM decides when to call it
- **UI**: `ctx.ui.custom()` interactive component with keyboard navigation

### slow-mode.ts
Intercepts `write` and `edit` tool calls to let the user review proposed changes before they are applied. New files are staged in a tmp directory; edits stage old/new files and display a unified diff. Toggle with `/slow-mode`. Use Ctrl+O to open in an external diff viewer.

- **Events**: `tool_call` (write, edit)
- **Command**: `/slow-mode` to toggle on/off
- **Status bar**: `slow ■` (active) · cleared (inactive)
- **External viewer**: Ctrl+O opens delta/vim/diff
- **Air doc**: `air/slow-mode.org`

## Current Focus

The direnv and questionnaire extensions are complete. Slow mode is being implemented — see `air/slow-mode.org` for the specification.

Use `airctl status` to see planning documents and their states.
