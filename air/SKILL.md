---
name: air-workflow
description: Documentation-driven development using Air - a filesystem-based planning tool. Use when working with Air documents, managing project specifications, tracking implementation progress, or when the user mentions Air, airctl commands, or documentation-driven development workflows.
compatibility: Requires airctl CLI tool and air-config.toml configuration
metadata:
  version: "0.1"
  author: Re
---

# Air Documentation-Driven Development

Air is a filesystem-based planning solution that treats directories and files as the primary interface for project management and documentation-driven development.

## Core Principles

1. **Filesystem as Database** - All planning in files and directories accessible to any tool
2. **Documentation-Driven** - Plan first, implement from complete specifications
3. **State-Based Tracking** - Document states provide clear visibility into project progress
4. **Git-Aware** - Leverages version control without requiring it

## Document Lifecycle States

Documents progress through these states:

```
draft → ready → work-in-progress → complete → archive/
   ↓
dropped
```

**State Definitions:**
- `draft` - Planning phase, requirements gathering
- `ready` - Specification complete, approved for implementation
- `work-in-progress` - Currently being implemented
- `complete` - Implementation finished and tested
- `dropped` - No longer needed or deprioritized
- `unknown` - Missing or malformed metadata

## Quick Start Workflow

### 1. Check Current Status
Always start by checking what work exists and its state:

```bash
# See all work in progress
airctl status --state work-in-progress

# Check what's ready for implementation
airctl status --state ready

# View work by feature area
airctl status --by-tag
```

### 2. Creating New Features

For new features without Air documents:

1. **Check for existing specifications first**
   ```bash
   airctl status --state draft,ready
   ```

2. **Create Air document in appropriate version directory** (v0.1/, v0.2/)
   - Use templates: `airctl template list` to see available templates
   - Start with `state: draft` (Org-mode: `#+state: draft`, Markdown: `state:` in frontmatter)
   - Add title and tags (Org-mode: `#+title:` and `#+FILETAGS:`, Markdown: `title:` and `tags:` in frontmatter)

3. **Complete required sections:**
   - Summary - Brief overview
   - Motivation - Why this work is needed
   - Proposal - Detailed specification
   - Implementation History - Track all work

4. **Move to 'ready' only when:**
   - All sections complete
   - Technical approach confirmed
   - Dependencies identified
   - Stakeholder approval received

### 3. Implementing Features

**Before starting implementation:**

```bash
# Update state to work-in-progress
airctl update v0.1/feature-name.org --state work-in-progress
```

**During implementation:**
- Document design changes in the Air document
- Update Implementation History with major milestones
- Write tests based on Air document specifications
- Run tests after any code changes

**Before marking complete:**
1. Run all tests - must pass without exceptions
2. Run integration tests
3. Fix any failing tests immediately
4. Update Implementation History with completion date
5. Update state to complete:
   ```bash
   airctl update v0.1/feature-name.org --state complete
   ```

### 4. Managing Work

**Update document metadata:**
```bash
# Change state
airctl update path/to/doc.org --state work-in-progress

# Add tags
airctl update path/to/doc.org --add-tag reviewed

# Update multiple properties
airctl update path/to/doc.org --state complete --title "New Title"
```

**Track progress:**
```bash
# View specific directory
airctl status --directory v0.1/

# Include archived documents
airctl status --include-archive

# Verbose output with dates and tags
airctl status --verbose
```

## Directory Structure

Standard Air project layout:

```
./air/
├── v0.1/              # Current milestone specifications
├── v0.2/              # Next milestone planning
├── archive/           # Completed work (excluded from status by default)
├── templates/         # Document templates
└── context/           # Generated context files for AI tools
```

**Organization guidelines:**
- Use semantic versioning: v0.1, v0.2, v0.10 (sorts correctly)
- Move completed work to archive/ when no longer actively referenced
- Place OVERVIEW.md in directories to explain contents

## Context Generation for AI Tools

Generate comprehensive project context for AI assistants:

```bash
# Generate all context files
airctl context generate

# Generate with Claude-specific formatting
airctl context generate --claude
```

Generated context includes:
- Project overview and architecture
- Current work status from Air documents
- Coding conventions and standards
- Implementation guidelines

## Document Format

Air supports both Org-mode and Markdown formats. Choose based on your preference.

### Org-mode Format

```org
#+title: Feature Name
#+state: draft
#+FILETAGS: :tag1:tag2:

* Summary
Brief overview of what this addresses.

* Motivation
Why this work is needed and what problems it solves.

** Goals
What we want to achieve.

** Non-Goals
What is explicitly out of scope.

* Proposal
Detailed specification of the solution.

* Design Details
Technical implementation details.

* Implementation History
- YYYY-MM-DD: Description of work completed
```

### Markdown Format

```markdown
---
title: Feature Name
state: draft
tags: [tag1, tag2]
---

# Summary
Brief overview of what this addresses.

# Motivation
Why this work is needed and what problems it solves.

## Goals
What we want to achieve.

## Non-Goals
What is explicitly out of scope.

# Proposal
Detailed specification of the solution.

# Design Details
Technical implementation details.

# Implementation History
- YYYY-MM-DD: Description of work completed
```

## Best Practices

### Planning Phase
- Create Air documents before implementing complex features
- Complete specifications before moving to 'ready' state
- Identify dependencies between documents
- Get stakeholder approval before implementation

### Implementation Phase
- Only implement from 'ready' documents
- Update state immediately when starting work
- Keep Implementation History current
- Document any design deviations
- Never mark complete with failing tests

### Maintenance
- Review document states regularly with `airctl status`
- Archive completed work that's no longer referenced
- Update specifications when requirements change
- Regenerate context files after document changes

## Common Commands Reference

```bash
# Initialize Air structure
airctl init

# Configuration management
airctl config create        # Interactive wizard
airctl config show          # View current config

# Directory setup
airctl directory init       # Create Air directories

# Template management
airctl template list        # Show available templates
airctl template init        # Install default templates

# Status tracking
airctl status              # Show all documents
airctl status --state ready,work-in-progress
airctl status --by-state   # Group by state
airctl status --by-directory  # Group by directory
airctl status --by-tag     # Group by tags

# Document updates
airctl update <path> --state <state>
airctl update <path> --add-tag <tag>
airctl update <path> --remove-tag <tag>
airctl update <path> --title "New Title"

# Context generation
airctl context generate
airctl context generate --claude
```

## Troubleshooting

**Unknown states appearing:**
- Check document has state property (Org-mode: `#+state:`, Markdown: `state:` in frontmatter)
- Verify state value is one of: draft, ready, work-in-progress, complete, dropped
- Ensure file extension matches configured file-types (.org or .md by default)

**Documents not appearing in status:**
- Verify files are in main-directory configured in air-config.toml
- Check file extensions match configured file-types
- Ensure documents aren't in archive/ (use --include-archive to see them)

**Configuration issues:**
- Run `airctl config show` to see current configuration
- Check air-config.toml exists in project root or user config directory
- Verify directory paths in configuration are correct

## Collaboration Workflow

**For team members:**
1. Check `airctl status` to see current work
2. Review 'ready' documents before implementing
3. Use `airctl update` to claim work (move to work-in-progress)
4. Keep Implementation History updated
5. Update state when finished

**For project leads:**
1. Review draft documents for completeness
2. Approve documents by moving to 'ready' state
3. Monitor progress with `airctl status --state work-in-progress`
4. Plan releases based on completed milestones
5. Manage archive to keep active work visible

## Integration with Git

- Air documents live alongside code in version control
- Commit document updates with related code changes
- Use document states to plan pull request scope
- Tag releases based on completed Air milestones
- Git history can provide document timestamps (falls back to filesystem)

---

For more details, see context files in ./air/context/:
- OVERVIEW.md - Project overview
- air-conventions.md - Document structure and tag taxonomy
- architecture.md - System architecture
- implementation-guide.md - Coding standards
- interface-design.md - CLI design patterns
