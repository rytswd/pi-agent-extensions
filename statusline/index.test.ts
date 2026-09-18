import { expect, test } from "bun:test";
import statusline from "./index.ts";

test("registers the current Pi model and thinking-level events", () => {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel: () => "high",
	} as any;

	statusline(pi);

	expect(handlers.has("model_select")).toBeTrue();
	expect(handlers.has("thinking_level_select")).toBeTrue();
	expect(handlers.has("model_update")).toBeFalse();
});
