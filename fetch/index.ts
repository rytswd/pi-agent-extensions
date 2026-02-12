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
 *   - Readability mode for extracting main content from web pages
 */

import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB (download / outputPath)
const DEFAULT_MAX_RESPONSE_TEXT = 100 * 1024; // 100KB text returned to LLM
const MIN_READABILITY_CONTENT_LENGTH = 200; // Minimum chars for readability to be considered successful

interface FetchDetails {
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyLength: number;
  truncated: boolean;
  curlCommand: string;
  outputPath?: string;
  textOnly?: boolean;
  readability?: boolean;
  readabilityMethod?: "mozilla" | "simple" | "failed";
  readabilityWarning?: string;
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
  outputPath?: string;
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

  if (params.outputPath) {
    parts.push("-o", shellQuote(params.outputPath));
  }

  parts.push(shellQuote(params.url));

  if (parts.length <= 2) return parts.join(" ");
  return parts[0] + " " + parts.slice(1).join(" \\\n  ");
}

/**
 * Extract main article content from HTML using simple heuristics.
 * Removes navigation, sidebars, headers, footers before processing.
 * Returns extracted HTML (not yet converted to text).
 */
function extractMainContentSimple(html: string): string {
  let processed = html;
  
  // Remove common UI elements that aren't part of the main content
  processed = processed
    // Remove navigation sections
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    // Remove sidebars
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    // Remove page headers (but keep article headers)
    .replace(/<header[^>]*class="[^"]*(?:site|page|navbar|top|global)[^"]*"[\s\S]*?<\/header>/gi, "")
    .replace(/<header[^>]*id="[^"]*(?:site|page|navbar|top|global)[^"]*"[\s\S]*?<\/header>/gi, "")
    // Remove page footers
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    // Remove common sidebar/navigation class patterns
    .replace(/<div[^>]*class="[^"]*(?:sidebar|nav-|navigation|menu|drawer|toc|breadcrumb|td-sidebar)[^"]*"[\s\S]*?<\/div>/gi, "")
    // Remove common id patterns for navigation
    .replace(/<div[^>]*id="[^"]*(?:sidebar|navigation|nav-|menu|toc|td-sidebar)[^"]*"[\s\S]*?<\/div>/gi, "")
    // Remove forms (usually search, login, etc.)
    .replace(/<form[\s\S]*?<\/form>/gi, "");
  
  // Try to extract the main content area if it exists
  // Look for <main>, <article>, or common content wrappers
  const mainMatch = processed.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    return mainMatch[1];
  }
  
  const articleMatch = processed.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    return articleMatch[1];
  }
  
  // Look for common content div patterns
  const contentMatch = processed.match(/<div[^>]*(?:class|id)="[^"]*(?:content|main|article|post|entry|td-content)[^"]*"[\s\S]*?>([\s\S]*?)<\/div>/i);
  if (contentMatch) {
    return contentMatch[1];
  }
  
  // If no main content area found, return the processed HTML with UI elements removed
  return processed;
}

/**
 * Extract readable content using Mozilla's Readability algorithm.
 * This is the same algorithm used in Firefox Reader Mode.
 * Returns { content: string, method: string, title?: string } or null on failure.
 */
function extractWithMozillaReadability(html: string, url: string): { 
  content: string; 
  method: "mozilla"; 
  title?: string;
} | null {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    
    if (article && article.textContent && article.textContent.length > MIN_READABILITY_CONTENT_LENGTH) {
      return {
        content: article.textContent,
        method: "mozilla",
        title: article.title,
      };
    }
    return null;
  } catch (error) {
    // If Mozilla Readability fails, return null to try simple extraction
    return null;
  }
}

/**
 * Strip HTML to plain text.
 * Removes scripts, styles, and tags while preserving readable structure.
 */
function stripHtml(html: string): string {
  return (
    html
      // Remove entire script/style/noscript blocks
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      // Remove HTML comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // Block elements → newlines (before stripping tags)
      .replace(/<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main|aside|details|summary|figcaption|figure|dl|dt|dd)[\s>][^>]*>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&#(\d+);/gi, (_m, code) =>
        String.fromCharCode(Number(code)),
      )
      // Collapse whitespace within lines
      .replace(/[ \t]+/g, " ")
      // Collapse multiple blank lines into one
      .replace(/\n[ \t]*\n/g, "\n\n")
      // Trim each line
      .replace(/^[ \t]+|[ \t]+$/gm, "")
      .trim()
  );
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
      outputPath: Type.Optional(
        Type.String({
          description:
            "Save response body to this file path instead of returning it. " +
            "Useful for binary downloads (images, archives, etc.). " +
            "Parent directories are created automatically.",
        }),
      ),
      textOnly: Type.Optional(
        Type.Boolean({
          description:
            "Strip HTML tags and return plain text. " +
            "Removes scripts, styles, and markup while preserving readable structure. " +
            "Default: auto-detects from Content-Type (strips text/html, leaves others as-is). " +
            "Set true to force strip, false to force raw.",
        }),
      ),
      readability: Type.Optional(
        Type.Boolean({
          description:
            "Extract main article content only, removing navigation, sidebars, headers, and footers. " +
            "Uses Mozilla Readability (Firefox Reader Mode algorithm) with fallback to simple extraction. " +
            "Best for blogs, articles, and documentation. " +
            "If extraction yields insufficient content, re-fetch with readability=false.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const method = params.method ?? "GET";
      const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBody = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const outputPath = params.outputPath
        ? resolve(ctx.cwd, params.outputPath)
        : undefined;

      const curlCommand = toCurl({
        url: params.url,
        method,
        headers: params.headers,
        body: params.body,
        outputPath,
      });

      // Guard: without write tool, outputPath is restricted to tmpdir
      if (outputPath && !pi.getActiveTools().includes("write")) {
        const tmp = tmpdir();
        if (!outputPath.startsWith(tmp + "/")) {
          throw new Error(
            `✗ outputPath restricted to ${tmp}/ when write tool is not enabled. ` +
            `Use a path under ${tmp}/ or enable the write tool.`,
          );
        }
      }

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

        const buffer = await response.arrayBuffer();
        const totalBytes = buffer.byteLength;

        // Collect response headers
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // HTTP errors: throw so pi renders with red toolErrorBg
        if (!response.ok) {
          throw new Error(
            `✗ ${response.status} ${response.statusText}: ${params.url}`,
          );
        }

        // Save to file: write bytes to disk, return metadata only
        if (outputPath) {
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, Buffer.from(buffer));

          const details: FetchDetails = {
            url: params.url,
            method,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            bodyLength: totalBytes,
            truncated: false,
            curlCommand,
            outputPath,
          };

          const lines: string[] = [
            `HTTP ${response.status} ${response.statusText}`,
            `Saved ${totalBytes} bytes to ${outputPath}`,
          ];

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details,
          };
        }

        // Return as text: decode full download, strip if needed, then truncate for LLM
        let bodyText = new TextDecoder("utf-8", { fatal: false }).decode(
          buffer,
        );

        // Auto-detect: strip HTML unless explicitly told not to
        const contentType = responseHeaders["content-type"] || "";
        const isHtml = contentType.includes("text/html");
        
        // Track readability processing
        let readabilityUsed = false;
        let readabilityMethod: "mozilla" | "simple" | "failed" | undefined;
        let readabilityWarning: string | undefined;
        let articleTitle: string | undefined;

        // Apply readability extraction if requested and content is HTML
        if (params.readability && isHtml) {
          readabilityUsed = true;
          
          // Try Mozilla Readability first
          const mozillaResult = extractWithMozillaReadability(bodyText, params.url);
          if (mozillaResult) {
            bodyText = mozillaResult.content;
            readabilityMethod = "mozilla";
            articleTitle = mozillaResult.title;
          } else {
            // Fallback to simple extraction
            const extractedHtml = extractMainContentSimple(bodyText);
            bodyText = stripHtml(extractedHtml);
            readabilityMethod = "simple";
          }
          
          // Check if readability extraction yielded enough content
          if (bodyText.length < MIN_READABILITY_CONTENT_LENGTH) {
            readabilityMethod = "failed";
            readabilityWarning = 
              `Readability extraction yielded only ${bodyText.length} chars (minimum: ${MIN_READABILITY_CONTENT_LENGTH}). ` +
              `Re-fetch with readability=false to get full page content.`;
          }
        } else {
          // Normal text-only stripping
          const stripped =
            params.textOnly === true || (params.textOnly !== false && isHtml);

          if (stripped) {
            bodyText = stripHtml(bodyText);
          }
        }

        const textLimit = DEFAULT_MAX_RESPONSE_TEXT;
        const truncated = bodyText.length > textLimit;
        if (truncated) {
          bodyText = bodyText.slice(0, textLimit);
        }

        const details: FetchDetails = {
          url: params.url,
          method,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          bodyLength: totalBytes,
          truncated,
          curlCommand,
          textOnly: !readabilityUsed && (params.textOnly === true || (params.textOnly !== false && isHtml)),
          readability: readabilityUsed,
          readabilityMethod,
          readabilityWarning,
        };

        // Format output
        const lines: string[] = [
          `HTTP ${response.status} ${response.statusText}`,
          "",
        ];

        for (const [key, value] of Object.entries(responseHeaders)) {
          lines.push(`${key}: ${value}`);
        }
        lines.push("");

        // Add readability info if used
        if (readabilityUsed && articleTitle) {
          lines.push(`Article: ${articleTitle}`);
          lines.push("");
        }

        if (readabilityWarning) {
          lines.push(`⚠️  ${readabilityWarning}`);
          lines.push("");
        }

        if (truncated) {
          lines.push(
            `[Truncated to ${textLimit} chars for context. Use outputPath to save full response.]`,
          );
        }
        lines.push(bodyText);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details,
        };
      } catch (err: unknown) {
        clearTimeout(timer);

        // Re-throw our own errors (HTTP 4xx/5xx) as-is
        if (err instanceof Error && err.message.startsWith("✗")) {
          throw err;
        }

        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";

        throw new Error(
          isTimeout
            ? `✗ Timed out after ${timeout}ms: ${params.url}`
            : `✗ ${err instanceof Error ? err.message : "Unknown fetch error"}`,
        );
      }
    },

    renderCall(args, theme) {
      const method = (args.method as string) ?? "GET";
      const url = args.url as string;
      let text = theme.fg("toolTitle", theme.bold("fetch "));
      text += theme.fg("accent", method);
      text += " ";
      text += theme.fg("muted", url);
      if (args.outputPath) {
        text += theme.fg("dim", " → ") + theme.fg("accent", args.outputPath as string);
      }
      if (args.readability) {
        text += theme.fg("accent", " [readability]");
      } else if (args.textOnly) {
        text += theme.fg("dim", " [text]");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as FetchDetails | undefined;
      if (!details || details.status === undefined) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "",
          0,
          0,
        );
      }

      // Collapsed: one-line summary
      if (!options.expanded) {
        // Normal HTTP response
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
        if (details.outputPath) {
          text +=
            theme.fg("dim", " → ") +
            theme.fg(statusColor, details.outputPath);
        } else if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        if (details.readability) {
          if (details.readabilityMethod === "failed") {
            text += theme.fg("error", " [readability: failed]");
          } else {
            text += theme.fg("accent", ` [readability: ${details.readabilityMethod}]`);
          }
        } else if (details.textOnly) {
          text += theme.fg("dim", " [text]");
        }
        if (details.readabilityWarning) {
          text += theme.fg("warning", " ⚠️");
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
