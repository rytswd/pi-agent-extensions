/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
  multiple: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
  // Populated for multiple-choice questions
  values?: string[];
  labels?: string[];
  indices?: number[];
  customText?: string;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
  }),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Allow 'Type something' option (default: true)",
    }),
  ),
  multiple: Type.Optional(
    Type.Boolean({
      description:
        "Allow selecting multiple options (checkbox style). Space toggles, Enter confirms. Default: false",
    }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
});

function errorResult(
  message: string,
  questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult(
          "Error: UI not available (running in non-interactive mode)",
        );
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }
      const badQ = params.questions.find(
        (q) => q.options.length === 0 && q.allowOther === false,
      );
      if (badQ) {
        return errorResult(
          `Error: Question '${badQ.id}' has no options and allowOther is false`,
        );
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        allowOther: q.allowOther !== false,
        multiple: q.multiple === true,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          // State
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionId: string | null = null;
          let cachedLines: string[] | undefined;
          let cachedWidth = -1;
          const answers = new Map<string, Answer>();
          // Multi-select state: checked option indices and optional custom text per question
          const multiChecked = new Map<string, Set<number>>();
          const multiCustom = new Map<string, string>();

          // Editor for "Type something" option
          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          // Helpers
          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function submit(cancelled: boolean) {
            // Emit answers in question order so consumers get a stable layout
            // regardless of the order the user filled tabs.
            const ordered = questions
              .map((q) => answers.get(q.id))
              .filter((a): a is Answer => a !== undefined);
            done({ questions, answers: ordered, cancelled });
          }

          function currentQuestion(): Question | undefined {
            return questions[currentTab];
          }

          const OTHER: RenderOption = {
            value: "__other__",
            label: "Type something.",
            isOther: true,
          };

          function currentOptions(): RenderOption[] {
            const q = currentQuestion();
            if (!q) return [];
            return q.allowOther ? [...q.options, OTHER] : [...q.options];
          }

          function allAnswered(): boolean {
            return questions.every((q) => answers.has(q.id));
          }

          function advanceAfterAnswer() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) {
              currentTab++;
            } else {
              currentTab = questions.length; // Submit tab
            }
            optionIndex = 0;
            refresh();
          }

          function enterInputMode(q: Question) {
            inputMode = true;
            inputQuestionId = q.id;
            editor.setText(q.multiple ? multiCustom.get(q.id) ?? "" : "");
            refresh();
          }

          function checkedFor(q: Question): Set<number> {
            let s = multiChecked.get(q.id);
            if (!s) {
              s = new Set();
              multiChecked.set(q.id, s);
            }
            return s;
          }

          function commitMultiAnswer(q: Question) {
            const checked = checkedFor(q);
            const indices = [...checked].sort((a, b) => a - b);
            const values = indices.map((i) => q.options[i].value);
            const labels = indices.map((i) => q.options[i].label);
            const custom = multiCustom.get(q.id);
            if (custom) {
              values.push(custom);
              labels.push(custom);
            }
            if (values.length === 0) {
              answers.delete(q.id);
              return;
            }
            answers.set(q.id, {
              id: q.id,
              value: values.join(", "),
              label: labels.join(", "),
              wasCustom: !!custom && indices.length === 0,
              values,
              labels,
              indices: indices.map((i) => i + 1),
              customText: custom,
            });
          }

          // Editor submit callback
          editor.onSubmit = (value) => {
            const qid = inputQuestionId;
            if (!qid) return;
            const q = questions.find((x) => x.id === qid);
            const trimmed = value.trim();
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            if (q?.multiple) {
              trimmed ? multiCustom.set(qid, trimmed) : multiCustom.delete(qid);
              commitMultiAnswer(q);
              refresh();
              return;
            }
            const text = trimmed || "(no response)";
            answers.set(qid, { id: qid, value: text, label: text, wasCustom: true });
            advanceAfterAnswer();
          };

          function handleInput(data: string) {
            // Input mode: route to editor
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionId = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = currentOptions();

            // Tab navigation (multi-question only)
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)
              ) {
                currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
            }

            // Submit tab
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }

            // Multi-select: Space toggles current option
            if (q?.multiple && matchesKey(data, Key.space)) {
              const opt = opts[optionIndex];
              if (!opt) return;
              if (opt.isOther) return enterInputMode(q);
              const checked = checkedFor(q);
              checked.has(optionIndex)
                ? checked.delete(optionIndex)
                : checked.add(optionIndex);
              commitMultiAnswer(q);
              refresh();
              return;
            }

            // Option navigation
            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            // Select option / confirm
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (q.multiple) {
                // Enter confirms current selection. If nothing checked yet,
                // act on the cursor item so a bare Enter still does something
                // useful (and avoids a soft-lock when the only option is "Other").
                const checked = checkedFor(q);
                if (checked.size === 0 && !multiCustom.get(q.id) && opt) {
                  if (opt.isOther) return enterInputMode(q);
                  checked.add(optionIndex);
                }
                commitMultiAnswer(q);
                answers.has(q.id) ? advanceAfterAnswer() : refresh();
                return;
              }
              if (!opt) return;
              if (opt.isOther) return enterInputMode(q);
              answers.set(q.id, {
                id: q.id,
                value: opt.value,
                label: opt.label,
                wasCustom: false,
                index: optionIndex + 1,
              });
              advanceAfterAnswer();
              return;
            }

            // Cancel
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            cachedWidth = width;

            const lines: string[] = [];
            const q = currentQuestion();
            const opts = currentOptions();

            // Helper to add truncated line
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "─".repeat(width)));

            // Tab bar (multi-question only)
            if (isMulti) {
              const tabs: string[] = ["← "];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const isAnswered = answers.has(questions[i].id);
                const lbl = questions[i].label;
                const box = isAnswered ? "■" : "□";
                const color = isAnswered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                const styled = isActive
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(color, text);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmitTab = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const submitStyled = isSubmitTab
                ? theme.bg("selectedBg", theme.fg("text", submitText))
                : theme.fg(canSubmit ? "success" : "dim", submitText);
              tabs.push(`${submitStyled} →`);
              add(` ${tabs.join("")}`);
              lines.push("");
            }

            // Helper to render options list
            const renderOptions = () => {
              if (!q) return;
              const checked = q.multiple ? checkedFor(q) : undefined;
              const custom = multiCustom.get(q.id);
              opts.forEach((opt, i) => {
                const selected = i === optionIndex;
                const isOther = !!opt.isOther;
                const on = isOther ? !!custom : checked?.has(i);
                const marker = q.multiple ? (on ? "[x]" : "[ ]") : `${i + 1}.`;
                const label = isOther && q.multiple && custom
                  ? `Other: ${custom}`
                  : opt.label;
                const editing = isOther && inputMode;
                const color = selected || editing ? "accent" : "text";
                const prefix = selected ? theme.fg("accent", "> ") : "  ";
                add(
                  prefix +
                    theme.fg(color, `${marker} ${label}${editing ? " ✎" : ""}`),
                );
                if (opt.description) {
                  add(`     ${theme.fg("muted", opt.description)}`);
                }
              });
            };

            // Content
            if (inputMode && q) {
              add(theme.fg("text", ` ${q.prompt}`));
              lines.push("");
              // Show options for reference
              renderOptions();
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              for (const line of editor.render(width - 2)) {
                add(` ${line}`);
              }
              lines.push("");
              add(theme.fg("dim", " Enter to submit • Esc to cancel"));
            } else if (currentTab === questions.length) {
              add(theme.fg("accent", theme.bold(" Ready to submit")));
              lines.push("");
              for (const question of questions) {
                const answer = answers.get(question.id);
                if (answer) {
                  const prefix = answer.wasCustom ? "(wrote) " : "";
                  add(
                    `${theme.fg("muted", ` ${question.label}: `)}${
                      theme.fg("text", prefix + answer.label)
                    }`,
                  );
                }
              }
              lines.push("");
              if (allAnswered()) {
                add(theme.fg("success", " Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((q) => !answers.has(q.id))
                  .map((q) => q.label)
                  .join(", ");
                add(theme.fg("warning", ` Unanswered: ${missing}`));
              }
            } else if (q) {
              add(theme.fg("text", ` ${q.prompt}`));
              lines.push("");
              renderOptions();
            }

            lines.push("");
            if (!inputMode) {
              const mq = q?.multiple;
              const parts = [
                isMulti && "Tab/←→ navigate",
                mq ? "↑↓ move" : "↑↓ navigate",
                mq && "Space toggle",
                mq || isMulti ? "Enter confirm" : "Enter select",
                "Esc cancel",
              ].filter(Boolean);
              add(theme.fg("dim", ` ${parts.join(" • ")}`));
            }
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
        },
      );

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const q = questions.find((x) => x.id === a.id);
        const qLabel = q?.label ?? a.id;
        if (a.values) {
          const parts = [
            ...(a.indices ?? []).map((idx, i) => `${idx}. ${a.labels?.[i]}`),
            ...(a.customText ? [`(wrote) ${a.customText}`] : []),
          ];
          return `${qLabel}: user selected (multiple): ${
            parts.join("; ") || "(none)"
          }`;
        }
        if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.values) {
          return `${theme.fg("success", "✓ ")}${
            theme.fg("accent", a.id)
          }: ${a.label}`;
        }
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${
            theme.fg("muted", "(wrote) ")
          }${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${
          theme.fg("accent", a.id)
        }: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
