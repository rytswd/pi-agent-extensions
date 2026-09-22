/**
 * inbox — per-session unix socket for async events into the conversation.
 *
 * Tool subprocesses get $PI_INBOX (socket path) and $PI_SESSION_ID. Each
 * connection to the socket becomes one message (JSON `{source?, text}` or
 * plain text), delivered immediately if idle, otherwise as a follow-up.
 * The sender's PID is taken from the socket peer credentials so the agent
 * can correlate an event with the process it started.
 * Used by `queue` for detached tasks and `notify()` in the python kernel.
 *
 *   echo '{"source":"ci","text":"build green"}' | nc -U "$PI_INBOX"
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, join } from "node:path";
import { text } from "node:stream/consumers";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const MAX_BYTES = 16 * 1024;
const TAIL_LINES = 12;

type Event = { source?: string; pid?: number; text: string };

// Node has no SO_PEERCRED/LOCAL_PEERPID binding, but it can pass the
// connection as a child's stdin; python then queries fd 0.
const PEER_PID = `
import socket, struct, sys
s = socket.socket(fileno=0)
if sys.platform == "darwin":
    pid = struct.unpack("i", s.getsockopt(0, 2, 4))[0]  # SOL_LOCAL, LOCAL_PEERPID
else:
    pid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
print(pid)
`;

function peerPid(conn: Socket): Promise<number | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("python3", ["-c", PEER_PID], { stdio: [conn, "pipe", "ignore"] });
    child.stdout!.on("data", (d) => (out += d));
    child.on("error", () => resolve(undefined));
    child.on("close", () => resolve(Number.parseInt(out, 10) || undefined));
  });
}

function parse(raw: string): Event {
  try {
    const j = JSON.parse(raw);
    if (typeof j?.text === "string") return { source: j.source, pid: j.pid, text: j.text };
  } catch {}
  return { text: raw.trim() };
}

export default function (pi: ExtensionAPI) {
  const path = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "pi-inbox", `${process.pid}.sock`);

  pi.registerMessageRenderer("inbox", (message, _options, theme) => {
    const ev = message.details as Event;
    let lines = ev.text.split("\n");
    if (lines.length > TAIL_LINES) {
      lines = [`… ${lines.length - TAIL_LINES} lines`, ...lines.slice(-TAIL_LINES)];
    }
    const tag = [ev.source, ev.pid && `pid ${ev.pid}`].filter(Boolean).join(" ");
    const title = theme.fg("accent", theme.bold(`▌inbox ${tag}`.trimEnd()));
    return new Text(`${title}\n${theme.fg("muted", lines.join("\n"))}`, 0, 0);
  });

  // At load, not session_start, so other extensions see $PI_INBOX early.
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer(async (conn) => {
      const [pid, raw] = await Promise.all([peerPid(conn), text(conn).catch(() => "")]);
      const ev = parse(raw.slice(0, MAX_BYTES));
      if (!ev.text) return;
      ev.pid ??= pid;
      const tag = [ev.source, ev.pid && `pid ${ev.pid}`].filter(Boolean).join(" ");
      const header = tag ? `[inbox: ${tag}]` : "[inbox]";
      pi.sendMessage(
        { customType: "inbox", content: `${header}\n${ev.text}`, display: true, details: ev },
        { deliverAs: "followUp", triggerTurn: true },
      );
  }).listen(path);
  process.env.PI_INBOX = path;

  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    process.env.PI_SESSION_ID = file ? basename(file, ".jsonl") : `pid-${process.pid}`;
  });

  pi.on("session_shutdown", async () => {
    server.close();
    rmSync(path, { force: true });
    delete process.env.PI_INBOX;
  });
}
