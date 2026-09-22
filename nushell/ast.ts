/**
 * nushell — map nu's `ast --flatten` tokens onto permission-gate pipelines.
 *
 * nu classifies every token for us (internal/external call, flag, string,
 * block delimiter, …). --flatten loses only two things, recovered here:
 *   - statement boundaries: read from the source text between two tokens
 *   - nesting: tracked from the `{ … }`, `( … )`, `$" … "` delimiter tokens
 * Each nested body yields its own pipelines, like permission-gate treats
 * `$( … )` in sh.
 */

import type { ArgvPipeline } from "../permission-gate/types.ts";

export interface FlatToken {
	content: string;
	shape: string;
	/** UTF-8 byte offsets into the script. */
	span: { start: number; end: number };
}

/** argv[0] when the command name only exists at runtime (`^$cmd`, `^ $in`). */
export const OPAQUE_HEAD = "\0nu-opaque-command";

/**
 * argv[0] of a stage that is a bare value (`'sudo id' | ^sh`). It runs
 * nothing but feeds stdin, so it must occupy a stage for pipeline rules
 * ("shell executes stdin") to see `sh` as downstream.
 */
export const NU_VALUE = "\0nu-value";

/**
 * Stand-in word for a value computed at runtime (`$"…"`). Spelled as a sh
 * parameter expansion so that, forwarded into `bash -c`, permission-gate's
 * "non-literal command name" rule recognises it.
 */
const RUNTIME_WORD = "${nu}";

/** Punctuation and declarations that never become an argv word. */
const SYNTAX_SHAPES = new Set([
	"shape_operator", "shape_keyword", "shape_pipe", "shape_match_pattern",
	"shape_list", "shape_record", "shape_table", "shape_signature", "shape_vardecl",
]);

/** `run-external rm x` runs `rm x`. */
const WRAPPERS = new Set(["run-external", "exec"]);
/** nu built-ins behaving like a POSIX tool the rules already know. */
const ALIASES: Record<string, string> = { save: "tee" };

function unquote(s: string): string {
	const raw = /^r(#+)'([\s\S]*)'\1$/.exec(s); // r#'…'#
	if (raw) return raw[2];
	return /^(["'`])[\s\S]*\1$/.test(s) ? s.slice(1, -1) : s;
}

/** Also list the command a wrapper/alias stands for, right after it. */
function expandWrappers(pipeline: ArgvPipeline): ArgvPipeline {
	return pipeline.flatMap((argv) => {
		const [head, ...rest] = argv;
		if (WRAPPERS.has(head) && rest.length) return [argv, rest];
		if (head in ALIASES) return [argv, [ALIASES[head], ...rest]];
		return [argv];
	});
}

/** One `{ }` / `( )` / `$" "` nesting level while walking the tokens. */
interface Frame {
	pipeline: ArgvPipeline;
	/** Command being collected; null between commands. */
	argv: string[] | null;
	/** Inside `$"…"`: literal fragments are not words. */
	interpolation: boolean;
}

export function nuPipelines(script: string, tokens: FlatToken[]): ArgvPipeline[] {
	const source = Buffer.from(script);
	const pipelines: ArgvPipeline[] = [];
	const stack: Frame[] = [];
	let frame!: Frame;

	const open = (interpolation = false) => {
		frame = { pipeline: [], argv: null, interpolation };
		stack.push(frame);
	};
	const endCommand = () => {
		if (frame.argv?.length) frame.pipeline.push(frame.argv);
		frame.argv = null;
	};
	const endPipeline = () => {
		endCommand();
		if (frame.pipeline.length) pipelines.push(expandWrappers(frame.pipeline));
		frame.pipeline = [];
	};
	const close = () => {
		endPipeline();
		if (stack.length > 1) stack.pop();
		frame = stack[stack.length - 1];
	};
	const startCommand = (argv0: string[]) => {
		endCommand();
		frame.argv = argv0;
	};
	const addWord = (word: string) => {
		if (frame.interpolation) return;
		frame.argv ??= [NU_VALUE];
		frame.argv.push(word);
	};

	open();
	let cursor = 0;
	let afterPipe = false;
	let afterCaret = false; // `^`: the next token is an external command name
	let afterRedirect = false; // the next token is a redirection target

	for (const token of tokens) {
		const between = source.subarray(cursor, token.span.start).toString();
		cursor = token.span.end;
		const isPipe = token.shape === "shape_pipe";
		if (/[;\n]/.test(between) && !afterPipe && !isPipe) endPipeline();
		if (/\^\s*$/.test(between)) afterCaret = true;
		afterPipe = isPipe;

		if (afterRedirect) {
			afterRedirect = false;
			continue;
		}
		const text = token.content.trim();

		switch (token.shape) {
			case "shape_block":
			case "shape_closure":
				// "{ ", "{|row| ", "(", "(^", " }", ")", "{}" or a lone "^"
				if (text.endsWith("^")) afterCaret = true;
				if (text === "^") continue;
				if ("({".includes(text[0])) {
					addWord(text[0] === "(" ? "$(...)" : "{...}");
					if (!/[)}]$/.test(text)) open();
				} else {
					close();
				}
				continue;

			case "shape_string_interpolation":
				// `$"` opens, `"` closes
				if (text.startsWith("$")) {
					addWord(RUNTIME_WORD);
					open(true);
				} else {
					close();
				}
				continue;

			case "shape_internalcall":
				afterCaret = false;
				startCommand(text.split(/\s+/)); // "str trim" is one token
				continue;

			case "shape_external":
				afterCaret = false;
				startCommand(text ? [unquote(text)] : [OPAQUE_HEAD]); // `^ $in` has an empty name
				continue;

			case "shape_redirection":
				afterRedirect = true;
				continue;
		}

		if (afterCaret) {
			// `^$cmd`, `^("r" + "m")`: something runs, name unknown
			afterCaret = false;
			startCommand([OPAQUE_HEAD]);
		} else if (!SYNTAX_SHAPES.has(token.shape)) {
			const quoted = token.shape === "shape_string" || token.shape === "shape_externalarg";
			addWord(quoted ? unquote(token.content) : token.content);
		}
	}
	while (stack.length > 1) close();
	endPipeline();
	return pipelines;
}

export function hasOpaqueCommand(pipelines: ArgvPipeline[]): boolean {
	return pipelines.some((p) => p.some((argv) => argv[0] === OPAQUE_HEAD));
}
