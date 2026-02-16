/**
 * Slow Mode Extension
 *
 * Intercepts write and edit tool calls, letting the user review proposed
 * changes before they are applied.
 *
 * - Write: stages the new file in /tmp, shows content for review.
 * - Edit: stages old/new files in /tmp, shows inline diff for review.
 * - Diffs are rendered with delta (if available) for enhanced syntax highlighting.
 * - Ctrl+E opens the new file in $VISUAL/$EDITOR for editing (edit operations).
 * - Ctrl+O opens the diff in an external viewer (delta/vim/diff).
 * - After editing, the diff is regenerated and shown again for approval.
 * - Toggle with /slow-mode command.
 * - Status bar shows "slow ■" when active.
 *
 * When content is edited:
 * - The actual write/edit operation uses the edited content
 * - A note is appended to the tool result indicating content was modified
 * - The collapsed snippet shows the original LLM proposal (not the edited version)
 *   This is intentional - it shows what the LLM wanted vs. what was actually applied
 *
 * In non-interactive mode (no UI), slow mode is a no-op.
 */

import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync, readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve, relative, extname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

export default function slowMode(pi: ExtensionAPI) {
  // State: whether slow mode is currently enabled
  let enabled = false;

  // Track tool calls where content was edited
  // Maps toolCallId -> { originalContent, editedContent }
  const editedCalls = new Map<string, { original: string; edited: string }>();

  // Track the current tool call being processed for rendering
  // This allows renderCall to access edited content during the same call
  let currentToolCallId: string | null = null;

  // Staging directory: stores proposed file changes for review
  // Uses mkdtempSync for secure, unpredictable temp directory creation
  // to prevent symlink attacks and tmpdir races
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-slow-mode-"));

  // Clean up staging directory on session shutdown
  pi.on("session_shutdown", async () => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  });

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  // Register /slow-mode command — toggle the interception gate on/off
  pi.registerCommand("slow-mode", {
    description: "Toggle slow mode — review write/edit changes before applying",
    handler: async (_args, ctx) => {
      // No-op in headless mode (no TUI available)
      if (!ctx.hasUI) {
        return;
      }

      // Flip the enabled flag
      enabled = !enabled;
      if (enabled) {
        // Show status bar indicator when active
        ctx.ui.setStatus("slow-mode", ctx.ui.theme.fg("warning", "slow ■"));
        ctx.ui.notify("Slow mode enabled — write/edit changes require approval", "info");
      } else {
        // Clear status bar indicator when disabled
        ctx.ui.setStatus("slow-mode", undefined);
        ctx.ui.notify("Slow mode disabled", "info");
      }
    },
  });

  ////----------------------------------------
  ///     Tool call interception
  //------------------------------------------

  // Hook into tool_call event — fires BEFORE tool execution
  // Returning { block: true, reason } prevents the tool from running
  pi.on("tool_call", async (event, ctx) => {
    // Pass through if slow mode is disabled or no UI available
    if (!enabled || !ctx.hasUI) return;

    // Intercept write tool calls
    if (event.toolName === "write") {
      return await reviewWrite(event.toolCallId, event.input, ctx);
    }

    // Intercept edit tool calls
    if (event.toolName === "edit") {
      return await reviewEdit(event.toolCallId, event.input, ctx);
    }

    // All other tools pass through unchanged
  });

  // Hook into tool_result event — fires AFTER tool execution
  // Add a note when content was edited in slow mode
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    const edited = editedCalls.get(event.toolCallId);
    if (!edited) return;

    // Clean up the tracking entry
    editedCalls.delete(event.toolCallId);

    // Calculate diff stats
    const originalLines = edited.original.split('\n').length;
    const editedLines = edited.edited.split('\n').length;
    const lineDiff = editedLines - originalLines;
    const lineDiffText = lineDiff > 0 
      ? `+${lineDiff} lines` 
      : lineDiff < 0 
      ? `${lineDiff} lines` 
      : 'same line count';

    // Add a note to the result indicating content was edited
    const note = {
      type: "text" as const,
      text: `\n\n**Note:** Content was modified in slow mode review before writing (${lineDiffText}).`,
    };

    return {
      content: [...(event.content || []), note],
    };
  });

  ////----------------------------------------
  ///     Write & edit review
  //------------------------------------------

  /**
   * Resolves file path to be relative to cwd
   * This normalizes absolute/relative paths for consistent staging
   */
  function resolvePath(ctx: ExtensionContext, filePath: string) {
    return relative(ctx.cwd, resolve(ctx.cwd, filePath));
  }

  /**
   * Review handler for write tool calls (new files / overwrites)
   *
   * Flow:
   * 1. Stage the proposed content in tmpDir
   * 2. Show review UI with the full content
   * 3. User approves → return undefined (tool proceeds)
   * 4. User rejects → return { block: true } (tool aborted)
   * 5. Cleanup staged file
   * 
   * If user edits content in external editor, the modified content is used.
   */
  async function reviewWrite(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const content = input.content as string;

    // Skip if input is malformed
    if (!filePath || content == null) return;

    // Resolve to relative path for staging
    const relPath = resolvePath(ctx, filePath);
    const stagePath = join(tmpDir, relPath);

    // Write proposed content to staging directory
    ensureDir(dirname(stagePath));
    writeFileSync(stagePath, content, "utf-8");

    // Show review UI — user decides to approve/reject
    // Emit event so other extensions can track when user approval is pending
    pi.events.emit("slow-mode:waiting");
    const approved = await showReview(ctx, {
      operation: "WRITE",
      filePath: relPath,
      stagePath,
      body: content,
      allowEdit: true,
    });
    pi.events.emit("slow-mode:resolved");

    if (approved) {
      // Read back the staged file in case user edited it
      try {
        const { readFileSync } = await import("node:fs");
        const editedContent = readFileSync(stagePath, "utf-8");
        
        // If content changed, update the input parameter and track the edit
        if (editedContent !== content) {
          input.content = editedContent;
          editedCalls.set(toolCallId, { original: content, edited: editedContent });
          ctx.ui.notify("Using edited content", "info");
        }
      } catch (err) {
        // If we can't read the file, use original content
        // (file might have been deleted, which is fine)
      }
    }

    // Clean up staged file after decision
    cleanup(stagePath);

    // Block the tool if user rejected
    if (!approved) {
      return { block: true, reason: "User rejected the write in slow mode review." };
    }

    // Approved: return undefined → tool proceeds with potentially modified content
  }

  /**
   * Review handler for edit tool calls (modifications to existing files)
   *
   * Flow:
   * 1. Stage both old and new text as separate files
   * 2. Show inline diff review UI
   * 3. User can: approve (Enter), reject (Esc), edit new file (Ctrl+E),
   *    or view diff externally (Ctrl+O)
   * 4. After editing, the diff is regenerated and shown again
   * 5. Loop continues until user approves or rejects
   * 6. Cleanup staged files
   * 
   * If user edits the new file, the modified content is used.
   */
  async function reviewEdit(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    // Skip if input is malformed
    if (!filePath || oldText == null || newText == null) return;

    const relPath = resolvePath(ctx, filePath);

    // Stage old and new files for diff viewing and editing
    // Timestamped to avoid conflicts if multiple edits happen
    // Preserve original file extension so editors can detect file type
    const base = basename(relPath);
    const ext = extname(base);
    const nameWithoutExt = base.slice(0, -ext.length || undefined);
    const ts = Date.now();
    const oldPath = join(tmpDir, `${nameWithoutExt}-${ts}.old${ext}`);
    const newPath = join(tmpDir, `${nameWithoutExt}-${ts}.new${ext}`);
    ensureDir(tmpDir);
    writeFileSync(oldPath, oldText, "utf-8");
    writeFileSync(newPath, newText, "utf-8");

    // Emit event so other extensions can track when user approval is pending
    pi.events.emit("slow-mode:waiting");

    // Review loop: show diff → user can approve, reject, or edit → repeat
    let approved = false;
    const { readFileSync } = await import("node:fs");

    reviewLoop:
    while (true) {
      // Read current content (may have been edited in a previous iteration)
      const currentOldText = readFileSync(oldPath, "utf-8");
      const currentNewText = readFileSync(newPath, "utf-8");
      const diff = generateUnifiedDiff(relPath, currentOldText, currentNewText);
      
      // Render diff through delta if available
      const renderedDiff = renderWithDelta(diff);

      const decision = await showEditReview(ctx, {
        filePath: relPath,
        body: renderedDiff,
        oldPath,
        newPath,
      });

      switch (decision) {
        case "approve":
          approved = true;
          break reviewLoop;
        case "reject":
          approved = false;
          break reviewLoop;
        case "edit":
          // Open just the new file in the user's editor, then loop back
          openExternalFile(newPath);
          continue;
      }
    }

    if (approved) {
      // Read back the new file in case user edited it
      try {
        const editedNewText = readFileSync(newPath, "utf-8");
        
        // If content changed, update the input parameter and track the edit
        if (editedNewText !== newText) {
          input.newText = editedNewText;
          editedCalls.set(toolCallId, { original: newText, edited: editedNewText });
          ctx.ui.notify("Using edited content", "info");
        }
      } catch (err) {
        // If we can't read the file, use original content
      }
    }

    pi.events.emit("slow-mode:resolved");

    // Clean up staged files after decision
    cleanup(oldPath);
    cleanup(newPath);

    // Block the tool if user rejected
    if (!approved) {
      return { block: true, reason: "User rejected the edit in slow mode review." };
    }

    // Approved: return undefined → tool proceeds with potentially modified content
  }

  ////----------------------------------------
  ///     Review UI
  //------------------------------------------

  /**
   * Options for the review UI component
   */
  interface ReviewOptions {
    operation: "WRITE" | "EDIT";   // Type of change being reviewed
    filePath: string;               // Relative path to the file
    stagePath: string;              // Path to staged file (for writes and as fallback)
    body: string;                   // Content to display (file content or diff)
    oldPath?: string;               // Staged old file (edits only)
    newPath?: string;               // Staged new file (edits only)
    allowEdit?: boolean;            // Allow editing in external editor (default: false)
  }

  /**
   * Show interactive review UI
   *
   * Displays the proposed change with scrollable preview and key bindings:
   * - Enter: approve change
   * - Esc: reject change
   * - Ctrl+O: open in external viewer/editor (delta/vim/diff for edits, $EDITOR for writes)
   * - k/↑: scroll up one line
   * - j/↓: scroll down one line
   * - u/PgUp: scroll up half page (15 lines)
   * - d/PgDn: scroll down half page (15 lines)
   * - gg: go to top
   * - G: go to bottom
   *
   * If allowEdit is true and user edits in external editor, the display is updated
   * to show the modified content/diff.
   *
   * @returns Promise<boolean> - true if approved, false if rejected
   */
  async function showReview(
    ctx: ExtensionContext,
    opts: ReviewOptions,
  ): Promise<boolean> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      // Scroll state
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;

      // Current body content (may be updated after external edit)
      let currentBody = opts.body;

      // Content split into lines for scrolling
      let bodyLines = currentBody.split("\n");
      const maxVisible = 30;  // Show up to 30 lines at once

      // Max scroll position (clamp to avoid scrolling past content)
      let maxScroll = Math.max(0, bodyLines.length - 5);

      // Track last 'g' press for gg binding
      let lastGPress = 0;

      /**
       * Clamp scroll offset to valid range
       */
      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      /**
       * Invalidate render cache and request re-render
       */
      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      /**
       * Open staged files in external viewer/editor
       * For edits: opens delta/vim diff
       * For writes: opens file in $VISUAL/$EDITOR
       * 
       * If allowEdit is true, reloads content after editing.
       */
      function openExternal() {
        try {
          if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } else {
            openExternalFile(opts.stagePath);
          }
          
          // If editing is allowed, reload and display the updated content
          if (opts.allowEdit) {
            try {
              const { readFileSync } = require("node:fs");
              
              if (opts.operation === "WRITE") {
                // Reload the edited file content
                const editedContent = readFileSync(opts.stagePath, "utf-8");
                currentBody = editedContent;
              } else if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
                // Reload the edited new file and regenerate diff
                const editedOldText = readFileSync(opts.oldPath, "utf-8");
                const editedNewText = readFileSync(opts.newPath, "utf-8");
                currentBody = generateUnifiedDiff(opts.filePath, editedOldText, editedNewText);
              }
              
              // Update bodyLines and scroll bounds
              bodyLines = currentBody.split("\n");
              maxScroll = Math.max(0, bodyLines.length - 5);
              scrollOffset = Math.min(scrollOffset, maxScroll);
            } catch (err) {
              // If reload fails, keep showing original content
            }
          }
        } catch {
          // External viewer failed — stay in inline review
          // (e.g., viewer not found, user closed viewer)
        }
        refresh();
      }

      /**
       * Handle keyboard input
       */
      function handleInput(data: string) {
        // Approve change
        if (matchesKey(data, Key.enter)) {
          done(true);
          return;
        }

        // Reject change
        if (matchesKey(data, Key.escape)) {
          done(false);
          return;
        }

        // Open in external viewer
        if (matchesKey(data, Key.ctrl("o"))) {
          openExternal();
          return;
        }

        // Vim-style navigation: k or ↑ - scroll up one line
        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }

        // Vim-style navigation: j or ↓ - scroll down one line
        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }

        // Vim-style navigation: u or PgUp - scroll up half page (15 lines)
        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 15);
          refresh();
          return;
        }

        // Vim-style navigation: d or PgDn - scroll down half page (15 lines)
        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 15);
          refresh();
          return;
        }

        // Vim-style navigation: gg - go to top
        if (data === "g") {
          const now = Date.now();
          // Check if this is a double 'g' within 500ms
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0; // Reset
          } else {
            lastGPress = now;
          }
          return;
        }

        // Vim-style navigation: G - go to bottom
        if (data === "G") {
          scrollOffset = maxScroll;
          refresh();
          return;
        }
      }

      /**
       * Render the review UI
       */
      function render(width: number): string[] {
        // Return cached lines if available (performance optimization)
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        // Top separator
        add(theme.fg("accent", "─".repeat(width)));

        // Operation label (NEW FILE or EDIT)
        const opLabel =
          opts.operation === "WRITE"
            ? theme.fg("warning", " NEW FILE")
            : theme.fg("accent", " EDIT (diff)");
        add(opLabel);

        // File path
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Scrollable content/diff window
        const visible = bodyLines.slice(
          scrollOffset,
          scrollOffset + maxVisible,
        );
        
        // Check if the diff contains ANSI escape codes (from delta)
        const hasAnsiCodes = opts.operation === "EDIT" && /\x1b\[[0-9;]*m/.test(opts.body);
        
        for (const line of visible) {
          if (opts.operation === "EDIT" && hasAnsiCodes) {
            // Delta has already colorized the diff, preserve ANSI codes
            add(` ${line}`);
          } else if (opts.operation === "EDIT") {
            // Fallback: Manual syntax highlighting for unified diff format
            if (line.startsWith("---") || line.startsWith("+++")) {
              // File headers — dim
              add(` ${theme.fg("dim", line)}`);
            } else if (line.startsWith("@@")) {
              // Hunk headers — accent
              add(` ${theme.fg("accent", line)}`);
            } else if (line.startsWith("+")) {
              // Added lines — green
              add(` ${theme.fg("success", line)}`);
            } else if (line.startsWith("-")) {
              // Removed lines — red
              add(` ${theme.fg("error", line)}`);
            } else {
              // Context lines — normal text
              add(` ${theme.fg("text", line)}`);
            }
          } else {
            // Write operation: no syntax highlighting, just plain text
            add(` ${theme.fg("text", line)}`);
          }
        }

        // Scroll indicator (show if content doesn't fit in window)
        if (bodyLines.length > maxVisible) {
          const total = bodyLines.length;
          const end = Math.min(scrollOffset + maxVisible, total);
          add(
            theme.fg(
              "dim",
              ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`,
            ),
          );
        }

        lines.push("");

        // Key binding hints
        const ctrlOHint = opts.allowEdit ? "Ctrl+O edit externally" : "Ctrl+O view externally";
        add(
          theme.fg("dim", ` Enter approve • Esc reject • ${ctrlOHint} • j/k u/d gg/G scroll`),
        );

        // Bottom separator
        add(theme.fg("accent", "─".repeat(width)));

        // Cache the rendered lines
        cachedLines = lines;
        return lines;
      }

      // Return TUI component interface
      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    });
  }

  /**
   * Options for the edit review UI (diff-specific)
   */
  interface EditReviewOptions {
    filePath: string;               // Relative path to the file
    body: string;                   // Unified diff content to display
    oldPath: string;                // Staged old file
    newPath: string;                // Staged new file
  }

  /**
   * Show interactive review UI for edit operations.
   *
   * Like showReview, but returns a three-way decision:
   * - "approve": apply the change
   * - "reject": block the change
   * - "edit": open the new file in an editor (caller should loop)
   *
   * Key bindings:
   * - Enter: approve
   * - Esc: reject
   * - Ctrl+E: edit the new file in $VISUAL/$EDITOR
   * - Ctrl+O: view diff in external viewer (delta/vim/diff)
   * - j/k/u/d/gg/G: scroll
   */
  async function showEditReview(
    ctx: ExtensionContext,
    opts: EditReviewOptions,
  ): Promise<"approve" | "reject" | "edit"> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<"approve" | "reject" | "edit">((tui, theme, _kb, done) => {
      // Scroll state
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;

      // Content split into lines for scrolling
      const bodyLines = opts.body.split("\n");
      const maxVisible = 30;
      let maxScroll = Math.max(0, bodyLines.length - 5);

      // Track last 'g' press for gg binding
      let lastGPress = 0;

      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        // Approve
        if (matchesKey(data, Key.enter)) {
          done("approve");
          return;
        }

        // Reject
        if (matchesKey(data, Key.escape)) {
          done("reject");
          return;
        }

        // Edit: open just the new file in the user's editor
        if (matchesKey(data, Key.ctrl("e"))) {
          done("edit");
          return;
        }

        // View diff externally (read-only)
        if (matchesKey(data, Key.ctrl("o"))) {
          try {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } catch {
            // External viewer failed — stay in inline review
          }
          refresh();
          return;
        }

        // Vim-style navigation
        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }
        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }
        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 15);
          refresh();
          return;
        }
        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 15);
          refresh();
          return;
        }
        if (data === "g") {
          const now = Date.now();
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0;
          } else {
            lastGPress = now;
          }
          return;
        }
        if (data === "G") {
          scrollOffset = maxScroll;
          refresh();
          return;
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", " EDIT (diff)"));
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Scrollable diff window with syntax highlighting
        const visible = bodyLines.slice(scrollOffset, scrollOffset + maxVisible);
        
        // Check if the diff contains ANSI escape codes (from delta)
        const hasAnsiCodes = /\x1b\[[0-9;]*m/.test(opts.body);
        
        for (const line of visible) {
          if (hasAnsiCodes) {
            // Delta has already colorized the diff, preserve ANSI codes
            add(` ${line}`);
          } else {
            // Fallback: Manual syntax highlighting for unified diff format
            if (line.startsWith("---") || line.startsWith("+++")) {
              add(` ${theme.fg("dim", line)}`);
            } else if (line.startsWith("@@")) {
              add(` ${theme.fg("accent", line)}`);
            } else if (line.startsWith("+")) {
              add(` ${theme.fg("success", line)}`);
            } else if (line.startsWith("-")) {
              add(` ${theme.fg("error", line)}`);
            } else {
              add(` ${theme.fg("text", line)}`);
            }
          }
        }

        if (bodyLines.length > maxVisible) {
          const total = bodyLines.length;
          const end = Math.min(scrollOffset + maxVisible, total);
          add(
            theme.fg("dim", ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`),
          );
        }

        lines.push("");
        add(
          theme.fg("dim", ` Enter approve • Esc reject • Ctrl+E edit • Ctrl+O view diff • j/k u/d gg/G scroll`),
        );
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => { cachedLines = undefined; },
        handleInput,
      };
    });
  }

  ////----------------------------------------
  ///     External viewers
  //------------------------------------------

  /**
   * Open old/new files in an external diff viewer
   *
   * Discovery order:
   * 1. delta (best terminal diff experience)
   * 2. nvim -d (if nvim available)
   * 3. vim -d (if vim available)
   * 4. diff (fallback to plain diff)
   *
   * If no diff tool found, falls back to opening just the new file.
   *
   * @param oldPath - Path to staged old version
   * @param newPath - Path to staged new version
   * @param label - File label (unused currently, for future use)
   */
  function openExternalDiff(oldPath: string, newPath: string, label: string) {
    const diffTool = findDiffTool();

    // No diff tool found — fall back to opening just the new file
    if (!diffTool) {
      openExternalFile(newPath);
      return;
    }

    const { cmd, args } = diffTool;

    // Configure tool-specific arguments
    if (cmd === "delta") {
      // delta: use diff and pipe to delta for proper syntax highlighting
      // Generate diff with original filename so delta can detect file type
      try {
        const diff = execFileSync("diff", ["-u", oldPath, newPath], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        // diff returns empty if files are identical (shouldn't happen, but handle it)
        execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
          input: diff,
          stdio: ["pipe", "inherit", "inherit"],
        });
      } catch (e: any) {
        // diff exits with 1 when files differ, which is expected
        if (e.stdout) {
          // Replace temp paths with original filename in diff headers for syntax detection
          let diff = e.stdout as string;
          diff = diff.replace(/^--- .*$/m, `--- a/${label}`);
          diff = diff.replace(/^\+\+\+ .*$/m, `+++ b/${label}`);
          
          execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
            input: diff,
            stdio: ["pipe", "inherit", "inherit"],
          });
        } else {
          // Fallback to direct file comparison
          args.push("--paging", "always", "--side-by-side", oldPath, newPath);
          execFileSync(cmd, args, { stdio: "inherit" });
        }
      }
    } else if (cmd === "nvim" || cmd === "vim") {
      // vim/nvim: open in diff mode
      args.push("-d", oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    } else {
      // Generic diff tool: assume it takes two file arguments
      args.push(oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    }
  }

  /**
   * Open a single file in the user's preferred editor
   *
   * Uses $VISUAL, $EDITOR, or falls back to 'less' for viewing.
   */
  function openExternalFile(filePath: string) {
    const editor = process.env.VISUAL || process.env.EDITOR || "less";
    execFileSync(editor, [filePath], { stdio: "inherit" });
  }

  /**
   * Find an available diff tool on the system
   *
   * @returns { cmd, args } if found, null otherwise
   */
  function findDiffTool(): { cmd: string; args: string[] } | null {
    // Prefer delta for nice terminal diff, then vimdiff, then plain diff
    const candidates = ["delta", "nvim", "vim", "diff"];

    for (const cmd of candidates) {
      try {
        // Check if command exists in PATH
        execFileSync("which", [cmd], { stdio: "ignore" });
        return { cmd, args: [] };
      } catch {
        // Command not found, try next candidate
        continue;
      }
    }

    // No diff tool found
    return null;
  }

  ////----------------------------------------
  ///     Delta diff rendering
  //------------------------------------------
  // Cache delta availability check
  let deltaAvailable: boolean | null = null;

  /**
   * Check if delta is available on the system.
   * Result is cached to avoid repeated process spawns.
   */
  function hasDelta(): boolean {
    if (deltaAvailable !== null) {
      return deltaAvailable;
    }
    try {
      execSync("delta --version", { stdio: "pipe" });
      deltaAvailable = true;
      return true;
    } catch {
      deltaAvailable = false;
      return false;
    }
  }

  /**
   * Render a unified diff with delta syntax highlighting.
   * 
   * Pipes the diff through `delta --color-only` to produce ANSI-colored output.
   * Falls back to the original diff if delta is unavailable or fails.
   *
   * @param unifiedDiff - Standard unified diff string
   * @returns ANSI-colored diff if delta is available, otherwise the original diff
   */
  function renderWithDelta(unifiedDiff: string): string {
    if (!hasDelta()) {
      return unifiedDiff;
    }

    const tmp = mkdtempSync(join(tmpdir(), "pi-slowmode-delta-"));
    const tmpFile = join(tmp, "diff.patch");
    try {
      writeFileSync(tmpFile, unifiedDiff, "utf-8");
      const result = execSync(`delta --no-gitconfig --color-only < "${tmpFile}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      return result;
    } catch {
      // Delta failed, return original diff
      return unifiedDiff;
    } finally {
      try {
        unlinkSync(tmpFile);
        rmSync(tmp, { recursive: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }


  ////----------------------------------------
  ///     Diff generation (Myers algorithm)
  //------------------------------------------

  /**
   * Generate a unified diff using the Myers diff algorithm.
   *
   * Replaces the external 'diff' npm package with a zero-dependency
   * implementation. Produces output equivalent to `diff -u` / `git diff`.
   *
   * @param filePath - Relative file path (used in --- / +++ headers)
   * @param oldText - Original text
   * @param newText - Modified text
   * @param contextLines - Number of context lines around changes (default: 3)
   * @returns Unified diff string
   */
  function generateUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
  ): string {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const edits = myersDiff(oldLines, newLines);
    const hunks = buildHunks(edits, contextLines);

    const out: string[] = [];
    out.push(`--- a/${filePath}`);
    out.push(`+++ b/${filePath}`);

    for (const hunk of hunks) {
      out.push(
        `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      );
      for (const line of hunk.lines) {
        out.push(line);
      }
    }

    return out.join("\n");
  }

  /**
   * Edit operation in a diff: keep, insert, or delete a line.
   */
  type Edit =
    | { type: "keep"; line: string }
    | { type: "insert"; line: string }
    | { type: "delete"; line: string };

  /**
   * Myers diff algorithm (linear-space variant).
   *
   * Computes the shortest edit script (SES) between two arrays of lines.
   * Time: O((N+M)D) where D is the edit distance.
   * Space: O((N+M)D) for the trace (acceptable for code diffs).
   *
   * Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its
   * Variations", Algorithmica 1(2), 1986.
   */
  function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
    const n = oldLines.length;
    const m = newLines.length;
    const max = n + m;

    // V[k] = furthest x-position reached on diagonal k
    // Diagonals range from -max..+max, offset by max for array indexing
    const size = 2 * max + 1;
    const v = new Int32Array(size);
    v[max + 1] = 0;

    // Store each V snapshot to reconstruct the path
    const trace: Int32Array[] = [];

    outer:
    for (let d = 0; d <= max; d++) {
      // Save current state before modification
      trace.push(v.slice());

      for (let k = -d; k <= d; k += 2) {
        const kIdx = k + max;

        // Decide whether to move down (insert) or right (delete)
        let x: number;
        if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
          x = v[kIdx + 1]; // move down: take x from diagonal k+1
        } else {
          x = v[kIdx - 1] + 1; // move right: take x from diagonal k-1 and advance
        }
        let y = x - k;

        // Follow the diagonal (matching lines)
        while (x < n && y < m && oldLines[x] === newLines[y]) {
          x++;
          y++;
        }

        v[kIdx] = x;

        // Reached the end of both sequences
        if (x >= n && y >= m) {
          break outer;
        }
      }
    }

    // Backtrack through the trace to reconstruct the edit script
    const edits: Edit[] = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d >= 0; d--) {
      const prev = trace[d];
      const k = x - y;
      const kIdx = k + max;

      // Determine which diagonal we came from
      let prevK: number;
      if (k === -d || (k !== d && prev[kIdx - 1] < prev[kIdx + 1])) {
        prevK = k + 1; // came from above (insert)
      } else {
        prevK = k - 1; // came from left (delete)
      }

      const prevX = prev[prevK + max];
      const prevY = prevX - prevK;

      // Diagonal moves (matching lines) — emit keeps in reverse
      while (x > prevX && y > prevY) {
        x--;
        y--;
        edits.push({ type: "keep", line: oldLines[x] });
      }

      if (d > 0) {
        if (x === prevX) {
          // Vertical move: insert from new
          y--;
          edits.push({ type: "insert", line: newLines[y] });
        } else {
          // Horizontal move: delete from old
          x--;
          edits.push({ type: "delete", line: oldLines[x] });
        }
      }
    }

    edits.reverse();
    return edits;
  }

  /**
   * A hunk in a unified diff.
   */
  interface Hunk {
    oldStart: number;  // 1-based start line in old file
    oldCount: number;  // number of old-file lines in hunk
    newStart: number;  // 1-based start line in new file
    newCount: number;  // number of new-file lines in hunk
    lines: string[];   // prefixed lines (" ", "+", "-")
  }

  /**
   * Group edit operations into unified diff hunks with context lines.
   *
   * Adjacent changes within (2 * contextLines) of each other are merged
   * into a single hunk, matching standard unified diff behavior.
   */
  function buildHunks(edits: Edit[], contextLines: number): Hunk[] {
    if (edits.length === 0) return [];

    // Find indices of all change operations (insert or delete)
    const changeIndices: number[] = [];
    for (let i = 0; i < edits.length; i++) {
      if (edits[i].type !== "keep") {
        changeIndices.push(i);
      }
    }

    if (changeIndices.length === 0) return [];

    // Group changes that are close enough to share context
    const groups: { start: number; end: number }[] = [];
    let groupStart = changeIndices[0];
    let groupEnd = changeIndices[0];

    for (let i = 1; i < changeIndices.length; i++) {
      // If gap between changes is <= 2*contextLines, merge into same group
      if (changeIndices[i] - groupEnd <= 2 * contextLines) {
        groupEnd = changeIndices[i];
      } else {
        groups.push({ start: groupStart, end: groupEnd });
        groupStart = changeIndices[i];
        groupEnd = changeIndices[i];
      }
    }
    groups.push({ start: groupStart, end: groupEnd });

    // Convert groups into hunks
    const hunks: Hunk[] = [];

    for (const group of groups) {
      // Expand to include context lines
      const hunkStart = Math.max(0, group.start - contextLines);
      const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);

      const lines: string[] = [];
      let oldCount = 0;
      let newCount = 0;

      // Compute 1-based starting line numbers
      let oldLine = 1;
      let newLine = 1;
      for (let i = 0; i < hunkStart; i++) {
        if (edits[i].type === "keep" || edits[i].type === "delete") oldLine++;
        if (edits[i].type === "keep" || edits[i].type === "insert") newLine++;
      }

      for (let i = hunkStart; i <= hunkEnd; i++) {
        const edit = edits[i];
        switch (edit.type) {
          case "keep":
            lines.push(` ${edit.line}`);
            oldCount++;
            newCount++;
            break;
          case "delete":
            lines.push(`-${edit.line}`);
            oldCount++;
            break;
          case "insert":
            lines.push(`+${edit.line}`);
            newCount++;
            break;
        }
      }

      hunks.push({
        oldStart: oldLine,
        oldCount,
        newStart: newLine,
        newCount,
        lines,
      });
    }

    return hunks;
  }

  ////----------------------------------------
  ///     Helpers
  //------------------------------------------

  /**
   * Ensure a directory exists, creating parent directories as needed
   */
  function ensureDir(dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Delete a file, ignoring errors
   * (Used for cleaning up staged files after review)
   */
  function cleanup(path: string) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore — tmp cleanup is best-effort
      // File may not exist or may be in use
    }
  }
}
