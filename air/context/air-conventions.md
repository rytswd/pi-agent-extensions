# Documentation Conventions

## Document States

Air uses six predefined states for document lifecycle management:

- **draft**: Initial planning phase
- **ready**: Specification complete, ready for implementation
- **work-in-progress**: Currently being implemented
- **complete**: Implementation finished
- **dropped**: No longer needed
- **unknown**: State cannot be determined

## Document Structure

### Org-mode Format (Primary)

```org
#+title: Document Title
#+state: draft
#+FILETAGS: :tag1:tag2:

* Summary
Brief overview.

* Motivation
Why this work is needed.

* Proposal
Detailed specification.

* Implementation History
- YYYY-MM-DD: Progress notes
```

## Tag Taxonomy

### Extension Tags
- `:direnv:` — Direnv integration
- `:extension:` — General extension work
- `:infra:` — Project infrastructure (CI, tooling, docs)

### Work Types
- `:feature:` — New functionality
- `:bugfix:` — Bug corrections
- `:docs:` — Documentation updates

## File Naming

- Extensions: lowercase, descriptive name (e.g., `direnv.ts`)
- Air documents: lowercase with hyphens, prefixed with scope (e.g., `support-direnv.org`)
- Context files: match Air conventions (`OVERVIEW.md`, `architecture.md`, etc.)

## Directory Structure

```
./air/
├── support-direnv.org    # Feature documents at root level
├── context/              # Generated context files
├── templates/            # Document templates
└── archive/              # Completed documents
```

## Metadata Conventions

- Always update `#+state:` when work status changes
- Add dated entries to Implementation History
- Use ISO date format (YYYY-MM-DD)
