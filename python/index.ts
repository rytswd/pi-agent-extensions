/**
 * `python` tool: a persistent interpreter (driver.py) per session, so the
 * model can keep parsed data, imports and figures between calls instead of
 * re-running scripts through bash.
 *
 * Optional ~/.config/pi-agent-extensions/python/config.json:
 *   { "python": "/path/to/python3",     // default: python3 on $PATH
 *     "prompt": "Has polars, pexpect …" } // appended to the tool description
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  highlightCode,
  keyHint,
  truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { Kernel } from "./kernel.ts";

interface Config {
  python?: string;
  prompt?: string;
}

function loadConfig(): Config {
  const path = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "pi-agent-extensions", "python", "config.json",
  );
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.error(`python extension: ${path}: ${e.message}`);
    return {};
  }
}

function havePython(cmd: string): boolean {
  try {
    execFileSync(cmd, ["-c", ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const python = config.python ?? "python3";
  if (!havePython(python)) return;
  let kernel: Kernel | undefined;

  pi.on("session_shutdown", async () => {
    kernel?.stop();
    kernel = undefined;
  });

  pi.registerCommand("python-restart", {
    description: "Restart the persistent Python interpreter (drops all state)",
    handler: async (_args, ctx) => {
      kernel?.stop();
      kernel = undefined;
      ctx.ui.notify("Python interpreter reset.", "info");
    },
  });

  // Deferred to session_start so $PI_INBOX (inbox.ts, set at its load) is
  // visible regardless of extension load order.
  let registered = false;
  pi.on("session_start", async () => {
    if (registered) return;
    registered = true;
    registerTool();
  });

  const registerTool = () => pi.registerTool({
    name: "python",
    label: "python",
    description:
      "Execute Python code in a persistent interpreter: variables, imports and open files survive between calls for the whole session. " +
      "The value of a trailing expression is echoed like in a REPL; use print() for anything else. " +
      "matplotlib figures, if available, are returned as images. " +
      `Output is truncated to the last ${DEFAULT_MAX_LINES} lines / ${
        formatSize(DEFAULT_MAX_BYTES)
      }. ` + (config.prompt ?? ""),
    promptSnippet: "Run Python in a persistent interpreter (state kept across calls)",
    promptGuidelines: [
      "Use python instead of bash for multi-step data work (JSON/CSV/logs), calculations, and anything where re-parsing input on every call would be wasteful; state persists, so load once and iterate.",
      ...(process.env.PI_INBOX
        ? [
          "Don't block on long waits in python: run them in a `threading.Thread` that calls the predefined `notify(text, source=\"python\")` when done. It arrives later as an `[inbox: <source>]` message.",
        ]
        : []),
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Python source to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (interrupts the cell, keeps state)",
        }),
      ),
    }),

    // Without this pi's fallback renders only the tool name, hiding the code.
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ??
        new Text("", 0, 0);
      let out = theme.fg("toolTitle", theme.bold("python"));
      if (args.timeout) out += theme.fg("muted", ` (timeout ${args.timeout}s)`);
      const code = (args.code ?? "").trimEnd();
      if (code) out += "\n" + highlightCode(code, "python").join("\n");
      text.setText(out);
      return text;
    },

    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ??
        new Text("", 0, 0);
      const output = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n")
        .trimEnd();
      const images = result.content.filter((c) => c.type === "image").length;
      const lines = output ? output.split("\n") : [];
      // Tail, not head: tracebacks and REPL results come last.
      const shown = options.expanded ? lines : lines.slice(-10);
      const color = context.isError ? "error" : "toolOutput";
      let out = theme.fg("muted", "─── output ───");
      if (lines.length > shown.length) {
        out += theme.fg(
          "muted",
          `\n... (${lines.length - shown.length} earlier lines, `,
        ) + keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")");
      }
      if (shown.length) {
        out += "\n" + shown.map((l) => theme.fg(color, l)).join("\n");
      }
      if (images) out += theme.fg("muted", `\n[${images} image(s)]`);
      text.setText(out);
      return text;
    },

    async execute(_id, params, signal, _onUpdate, ctx) {
      kernel ??= new Kernel(python, ctx.cwd);
      const ac = new AbortController();
      signal?.addEventListener("abort", () => ac.abort(), { once: true });
      let timedOut = false;
      const timer = params.timeout
        ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, params.timeout * 1000)
        : undefined;
      const r = await kernel.exec(params.code, ac.signal).finally(() =>
        clearTimeout(timer)
      );
      // Throw like bash so pi ends the run as "aborted" and sends queued prompts.
      if (signal?.aborted) throw new Error("Command aborted");
      if (timedOut && r.error?.startsWith("KeyboardInterrupt")) {
        r.error =
          `Timed out after ${params.timeout}s (cell interrupted, interpreter state kept)`;
      }

      let text = r.stdout;
      if (r.stderr) {
        text += (text && !text.endsWith("\n") ? "\n" : "") + r.stderr;
      }
      if (r.result !== null) {
        text += (text && !text.endsWith("\n") ? "\n" : "") + r.result;
      }
      if (r.error) text += (text && !text.endsWith("\n") ? "\n" : "") + r.error;
      const t = truncateTail(text || (r.images.length ? "" : "(no output)"));
      if (t.truncated) {
        t.content =
          `[output truncated: showing last ${t.outputLines} of ${t.totalLines} lines]\n${t.content}`;
      }

      const content: ({ type: "text"; text: string } | {
        type: "image";
        data: string;
        mimeType: string;
      })[] = [];
      if (t.content) content.push({ type: "text", text: t.content });
      for (const data of r.images) {
        content.push({ type: "image", data, mimeType: "image/png" });
      }
      return { content, details: undefined, isError: r.error !== null };
    },
  });
}
