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

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, basename, join, resolve, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

export default function slowMode(pi: ExtensionAPI) {
  let enabled = false;
  const tmpDir = `/tmp/pi-slow-mode-${process.pid}`;

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  pi.registerCommand("slow-mode", {
    description: "Toggle slow mode — review write/edit changes before applying",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      enabled = !enabled;
      if (enabled) {
        ctx.ui.setStatus("slow-mode", ctx.ui.theme.fg("warning", "slow ■"));
        ctx.ui.notify("Slow mode enabled — write/edit changes require approval", "info");
      } else {
        ctx.ui.setStatus("slow-mode", undefined);
        ctx.ui.notify("Slow mode disabled", "info");
      }
    },
  });

  ////----------------------------------------
  ///     Tool call interception
  //------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    if (event.toolName === "write") {
      return await reviewWrite(event.input, ctx);
    }
    if (event.toolName === "edit") {
      return await reviewEdit(event.input, ctx);
    }
  });

  ////----------------------------------------
  ///     Write & edit review
  //------------------------------------------

  function resolvePath(ctx: ExtensionContext, filePath: string) {
    return relative(ctx.cwd, resolve(ctx.cwd, filePath));
  }

  async function reviewWrite(
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const content = input.content as string;
    if (!filePath || content == null) return;

    const relPath = resolvePath(ctx, filePath);
    const stagePath = join(tmpDir, relPath);
    ensureDir(dirname(stagePath));
    writeFileSync(stagePath, content, "utf-8");

    const approved = await showReview(ctx, {
      operation: "WRITE",
      filePath: relPath,
      stagePath,
      body: content,
    });

    cleanup(stagePath);

    if (!approved) {
      return { block: true, reason: "User rejected the write in slow mode review." };
    }
  }

  async function reviewEdit(
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const oldText = input.oldText as string;
    const newText = input.newText as string;
    if (!filePath || oldText == null || newText == null) return;

    const relPath = resolvePath(ctx, filePath);
    const diff = generateUnifiedDiff(relPath, oldText, newText);

    // Stage old and new files for external diff
    const base = basename(relPath);
    const ts = Date.now();
    const oldPath = join(tmpDir, `${base}-${ts}.old`);
    const newPath = join(tmpDir, `${base}-${ts}.new`);
    ensureDir(tmpDir);
    writeFileSync(oldPath, oldText, "utf-8");
    writeFileSync(newPath, newText, "utf-8");

    const approved = await showReview(ctx, {
      operation: "EDIT",
      filePath: relPath,
      stagePath: newPath,
      body: diff,
      oldPath,
      newPath,
    });

    cleanup(oldPath);
    cleanup(newPath);

    if (!approved) {
      return { block: true, reason: "User rejected the edit in slow mode review." };
    }
  }

  ////----------------------------------------
  ///     Review UI
  //------------------------------------------

  interface ReviewOptions {
    operation: "WRITE" | "EDIT";
    filePath: string;
    stagePath: string;
    body: string;
    oldPath?: string;
    newPath?: string;
  }

  async function showReview(
    ctx: ExtensionContext,
    opts: ReviewOptions,
  ): Promise<boolean> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;
      const bodyLines = opts.body.split("\n");
      const maxVisible = 30;
      const maxScroll = Math.max(0, bodyLines.length - 5);

      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function openExternal() {
        try {
          if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } else {
            openExternalFile(opts.stagePath);
          }
        } catch {
          // External viewer failed — stay in inline review
        }
        refresh();
      }

      function handleInput(data: string) {
        if (matchesKey(data, Key.enter)) {
          done(true);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(false);
          return;
        }
        // Ctrl+O — open in external viewer
        if (matchesKey(data, Key.ctrl("o"))) {
          openExternal();
          return;
        }
        if (matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 20);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 20);
          refresh();
          return;
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));

        // Header
        const opLabel =
          opts.operation === "WRITE"
            ? theme.fg("warning", " NEW FILE")
            : theme.fg("accent", " EDIT (diff)");
        add(opLabel);
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Body with scroll
        const visible = bodyLines.slice(
          scrollOffset,
          scrollOffset + maxVisible,
        );
        for (const line of visible) {
          if (opts.operation === "EDIT") {
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
          } else {
            add(` ${theme.fg("text", line)}`);
          }
        }

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
        add(
          theme.fg("dim", " Enter approve • Esc reject • Ctrl+O open external"),
        );
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

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

  function openExternalDiff(oldPath: string, newPath: string, label: string) {
    const diffTool = findDiffTool();
    if (!diffTool) {
      // Fall back to opening just the new file
      openExternalFile(newPath);
      return;
    }

    const { cmd, args } = diffTool;
    if (cmd === "delta") {
      args.push("--paging", "always", "--side-by-side", oldPath, newPath);
    } else if (cmd === "nvim" || cmd === "vim") {
      args.push("-d", oldPath, newPath);
    } else {
      // Generic: assume it takes two files
      args.push(oldPath, newPath);
    }

    execFileSync(cmd, args, { stdio: "inherit" });
  }

  function openExternalFile(filePath: string) {
    const editor = process.env.VISUAL || process.env.EDITOR || "less";
    execFileSync(editor, [filePath], { stdio: "inherit" });
  }

  function findDiffTool(): { cmd: string; args: string[] } | null {
    // Prefer delta for nice terminal diff, then vimdiff, then plain diff
    const candidates = ["delta", "nvim", "vim", "diff"];
    for (const cmd of candidates) {
      try {
        execFileSync("which", [cmd], { stdio: "ignore" });
        return { cmd, args: [] };
      } catch {
        continue;
      }
    }
    return null;
  }

  ////----------------------------------------
  ///     Diff generation
  //------------------------------------------

  function generateUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
  ): string {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    const lines: string[] = [];
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);
    lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    for (const line of oldLines) {
      lines.push(`-${line}`);
    }
    for (const line of newLines) {
      lines.push(`+${line}`);
    }

    return lines.join("\n");
  }

  ////----------------------------------------
  ///     Helpers
  //------------------------------------------

  function ensureDir(dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  function cleanup(path: string) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore — tmp cleanup is best-effort
    }
  }
}
