/**
 * Slow Mode Extension
 *
 * Intercepts write and edit tool calls, letting the user review proposed
 * changes before they are applied.
 *
 * - Write: stages the new file in /tmp, shows content for review.
 * - Edit: stages old/new files in /tmp, shows inline diff for review.
 * - Ctrl+O opens the staged files in an external diff viewer.
 * - Toggle with /slow-mode command.
 * - Status bar shows "slow ■" when active.
 *
 * In non-interactive mode (no UI), slow mode is a no-op.
 */

import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

export default function slowMode(pi: ExtensionAPI) {
  // State: whether slow mode is currently enabled
  let enabled = false;

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
      return await reviewWrite(event.input, ctx);
    }

    // Intercept edit tool calls
    if (event.toolName === "edit") {
      return await reviewEdit(event.input, ctx);
    }

    // All other tools pass through unchanged
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
   */
  async function reviewWrite(
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
    });
    pi.events.emit("slow-mode:resolved");

    // Clean up staged file after decision
    cleanup(stagePath);

    // Block the tool if user rejected
    if (!approved) {
      return { block: true, reason: "User rejected the write in slow mode review." };
    }

    // Approved: return undefined → tool proceeds normally
  }

  /**
   * Review handler for edit tool calls (modifications to existing files)
   *
   * Flow:
   * 1. Stage both old and new text as separate files
   * 2. Try to open in external diff viewer (delta/vim/diff) by default
   * 3. If external viewer not available, show inline TUI diff
   * 4. User reviews changes, then approves/rejects
   * 5. User approves → return undefined (tool proceeds)
   * 6. User rejects → return { block: true } (tool aborted)
   * 7. Cleanup both staged files
   */
  async function reviewEdit(
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const oldText = input.oldText as string;
    const newText = input.newText as string;

    // Skip if input is malformed
    if (!filePath || oldText == null || newText == null) return;

    const relPath = resolvePath(ctx, filePath);

    // Stage old and new files for external diff viewer
    // Timestamped to avoid conflicts if multiple edits happen
    const base = basename(relPath);
    const ts = Date.now();
    const oldPath = join(tmpDir, `${base}-${ts}.old`);
    const newPath = join(tmpDir, `${base}-${ts}.new`);
    ensureDir(tmpDir);
    writeFileSync(oldPath, oldText, "utf-8");
    writeFileSync(newPath, newText, "utf-8");

    let approved: boolean;

    // Emit event so other extensions can track when user approval is pending
    pi.events.emit("slow-mode:waiting");

    // Try to open in external diff viewer first (preferred)
    const diffTool = findDiffTool();
    if (diffTool) {
      try {
        // Open external diff viewer — blocks until user closes it
        openExternalDiff(oldPath, newPath, relPath);
        
        // After viewer closes, ask user for approval decision
        const choice = await ctx.ui.confirm(
          `Apply changes to ${relPath}?`,
          ["Yes", "No"],
        );
        approved = choice === "Yes";
      } catch {
        // External viewer failed — fall back to inline diff
        const diff = generateUnifiedDiff(relPath, oldText, newText);
        approved = await showReview(ctx, {
          operation: "EDIT",
          filePath: relPath,
          stagePath: newPath,
          body: diff,
          oldPath,
          newPath,
        });
      }
    } else {
      // No external diff tool available — show inline TUI diff
      const diff = generateUnifiedDiff(relPath, oldText, newText);
      approved = await showReview(ctx, {
        operation: "EDIT",
        filePath: relPath,
        stagePath: newPath,
        body: diff,
        oldPath,
        newPath,
      });
    }

    pi.events.emit("slow-mode:resolved");

    // Clean up staged files after decision
    cleanup(oldPath);
    cleanup(newPath);

    // Block the tool if user rejected
    if (!approved) {
      return { block: true, reason: "User rejected the edit in slow mode review." };
    }

    // Approved: return undefined → tool proceeds normally
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
  }

  /**
   * Show interactive review UI
   *
   * Displays the proposed change with scrollable preview and key bindings:
   * - Enter: approve change
   * - Esc: reject change
   * - Ctrl+O: open in external viewer (delta/vim/diff)
   * - k/↑: scroll up one line
   * - j/↓: scroll down one line
   * - u/PgUp: scroll up half page (15 lines)
   * - d/PgDn: scroll down half page (15 lines)
   * - gg: go to top
   * - G: go to bottom
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

      // Content split into lines for scrolling
      const bodyLines = opts.body.split("\n");
      const maxVisible = 30;  // Show up to 30 lines at once

      // Max scroll position (clamp to avoid scrolling past content)
      const maxScroll = Math.max(0, bodyLines.length - 5);

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
       * Open staged files in external viewer
       * For edits: opens delta/vim diff
       * For writes: opens file in $VISUAL/$EDITOR
       */
      function openExternal() {
        try {
          if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } else {
            openExternalFile(opts.stagePath);
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
        for (const line of visible) {
          if (opts.operation === "EDIT") {
            // Syntax highlighting for unified diff format
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
        add(
          theme.fg("dim", " Enter approve • Esc reject • Ctrl+O external • j/k u/d gg/G scroll"),
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
      // delta: render to pager with side-by-side layout
      args.push("--paging", "always", "--side-by-side", oldPath, newPath);
    } else if (cmd === "nvim" || cmd === "vim") {
      // vim/nvim: open in diff mode
      args.push("-d", oldPath, newPath);
    } else {
      // Generic diff tool: assume it takes two file arguments
      args.push(oldPath, newPath);
    }

    // Execute synchronously — blocks until user closes the viewer
    // stdio: "inherit" attaches to the terminal
    execFileSync(cmd, args, { stdio: "inherit" });
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
    out.push(`--- ${filePath}`);
    out.push(`+++ ${filePath}`);

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
