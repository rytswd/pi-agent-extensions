/**
 * Fetch Tool Extension
 *
 * Provides a native `fetch` tool that the LLM can use to make HTTP requests
 * without relying on bash/curl. Supports GET, POST, PUT, PATCH, DELETE, and
 * HEAD methods with optional headers and body.
 *
 * Features:
 *   - JSON / plain text / HTML response handling
 *   - Configurable timeout (default 30s)
 *   - Response truncation for large payloads (configurable, default 100KB)
 *   - Follows redirects automatically
 *   - Returns status code, headers, and body
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 100 * 1024; // 100KB

interface FetchDetails {
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyLength: number;
  truncated: boolean;
  curlCommand: string;
}

/** Escape a string for safe use inside single quotes in shell. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert fetch parameters to an equivalent curl command.
 * Uses multi-line format with backslash continuations when there are options.
 */
function toCurl(params: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): string {
  const parts: string[] = ["curl"];

  if (params.method === "HEAD") {
    parts.push("-I");
  } else if (params.method !== "GET") {
    parts.push("-X", params.method);
  }

  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      parts.push("-H", shellQuote(`${key}: ${value}`));
    }
  }

  if (params.body) {
    parts.push("-d", shellQuote(params.body));
  }

  parts.push(shellQuote(params.url));

  if (parts.length <= 2) return parts.join(" ");
  return parts[0] + " " + parts.slice(1).join(" \\\n  ");
}

export default function fetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch",
    label: "Fetch",
    description:
      "Make an HTTP request to a URL. Use this for fetching web pages, calling APIs, downloading text content, etc. " +
      "Do NOT use bash/curl — use this tool instead for all HTTP requests.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal("GET"),
            Type.Literal("POST"),
            Type.Literal("PUT"),
            Type.Literal("PATCH"),
            Type.Literal("DELETE"),
            Type.Literal("HEAD"),
          ],
          { description: "HTTP method (default: GET)" },
        ),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Request headers as key-value pairs",
        }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "Request body (for POST/PUT/PATCH). Sent as-is. Set Content-Type header accordingly.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
        }),
      ),
      maxBodyBytes: Type.Optional(
        Type.Number({
          description: `Maximum response body size in bytes before truncation (default: ${DEFAULT_MAX_BODY_BYTES})`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const method = params.method ?? "GET";
      const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBody = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

      const curlCommand = toCurl({
        url: params.url,
        method,
        headers: params.headers,
        body: params.body,
      });

      // Build abort controller that respects both our timeout and the caller's signal
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }

      try {
        const response = await fetch(params.url, {
          method,
          headers: params.headers,
          body: params.body,
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timer);

        // Read response body as text, with size limit
        const buffer = await response.arrayBuffer();
        const totalBytes = buffer.byteLength;
        const truncated = totalBytes > maxBody;
        const sliced = truncated ? buffer.slice(0, maxBody) : buffer;
        const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(
          sliced,
        );

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const details: FetchDetails = {
          url: params.url,
          method,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          bodyLength: totalBytes,
          truncated,
          curlCommand,
        };

        // Format output
        const lines: string[] = [
          `HTTP ${response.status} ${response.statusText}`,
          "",
        ];

        // Include selected response headers
        for (const [key, value] of Object.entries(responseHeaders)) {
          lines.push(`${key}: ${value}`);
        }
        lines.push("");

        if (truncated) {
          lines.push(
            `[Body truncated: showing ${maxBody} of ${totalBytes} bytes]`,
          );
        }
        lines.push(bodyText);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details,
        };
      } catch (err: unknown) {
        clearTimeout(timer);

        const message =
          err instanceof Error ? err.message : "Unknown fetch error";
        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";

        return {
          content: [
            {
              type: "text",
              text: isTimeout
                ? `Fetch timed out after ${timeout}ms: ${params.url}`
                : `Fetch error: ${message}`,
            },
          ],
          details: {
            url: params.url,
            method,
            status: 0,
            statusText: isTimeout ? "Timeout" : "Error",
            headers: {},
            bodyLength: 0,
            truncated: false,
            curlCommand,
          } as FetchDetails,
        };
      }
    },

    renderCall(args, theme) {
      const method = (args.method as string) ?? "GET";
      const url = args.url as string;
      let text = theme.fg("toolTitle", theme.bold("fetch "));
      text += theme.fg("accent", method);
      text += " ";
      text += theme.fg("muted", url);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as FetchDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "",
          0,
          0,
        );
      }

      // Collapsed: one-line summary
      if (!options.expanded) {
        const statusColor =
          details.status >= 200 && details.status < 300
            ? "success"
            : details.status >= 400
              ? "error"
              : "warning";
        const sizeStr =
          details.bodyLength > 1024
            ? `${(details.bodyLength / 1024).toFixed(1)}KB`
            : `${details.bodyLength}B`;
        let text = theme.fg(statusColor, `${details.status} `);
        text += theme.fg("muted", details.statusText);
        text += theme.fg("dim", ` · ${sizeStr}`);
        if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        return new Text(text, 0, 0);
      }

      // Expanded: curl equivalent only
      const curlLines = details.curlCommand.split("\n");
      const curlFormatted = curlLines
        .map((line, i) =>
          i === 0
            ? theme.fg("dim", "$ ") + theme.fg("muted", line)
            : theme.fg("dim", "  ") + theme.fg("muted", line),
        )
        .join("\n");

      return new Text(curlFormatted, 0, 0);
    },
  });
}
