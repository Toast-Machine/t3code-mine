// Personal build: Claude reports its built-in tools (Read, Grep, …) as generic
// "Tool call" items with the input packed into the detail ("Read: {json}").
// This names the step and keeps just its target, so the work log reads
// "Read file · bin.ts" instead of a JSON blob.

export interface ClaudeToolStep {
  /** Past tense, for finished steps in the log. */
  readonly label: string;
  /** Present tense, for the live work line. */
  readonly activeLabel: string;
  readonly target: string | null;
}

const STEPS: Record<string, { label: string; activeLabel: string; field: string }> = {
  Read: { label: "Read", activeLabel: "Reading", field: "file_path" },
  Edit: { label: "Edited", activeLabel: "Editing", field: "file_path" },
  MultiEdit: { label: "Edited", activeLabel: "Editing", field: "file_path" },
  Write: { label: "Wrote", activeLabel: "Writing", field: "file_path" },
  NotebookEdit: { label: "Edited", activeLabel: "Editing", field: "notebook_path" },
  Grep: { label: "Searched for", activeLabel: "Searching for", field: "pattern" },
  Glob: { label: "Found files", activeLabel: "Finding files", field: "pattern" },
  WebFetch: { label: "Fetched", activeLabel: "Fetching", field: "url" },
  WebSearch: {
    label: "Searched the web for",
    activeLabel: "Searching the web for",
    field: "query",
  },
  TodoWrite: { label: "Updated tasks", activeLabel: "Updating tasks", field: "" },
};

const DETAIL_PATTERN = /^(\w+): (\{[\s\S]*\})$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function shortTarget(field: string, value: string): string {
  if (field === "url") {
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  }
  if (field.endsWith("path")) return value.split("/").filter(Boolean).at(-1) ?? value;
  return value;
}

/** Reads the tool name and input from a tool activity payload. */
export function describeClaudeToolStep(
  payload: Record<string, unknown> | null,
): ClaudeToolStep | null {
  const data = asRecord(payload?.data);
  let toolName = typeof data?.toolName === "string" ? data.toolName : null;
  let input = asRecord(data?.input);
  if (!input && typeof payload?.detail === "string") {
    const match = DETAIL_PATTERN.exec(payload.detail.trim());
    if (match) {
      toolName ??= match[1]!;
      try {
        input = asRecord(JSON.parse(match[2]!));
      } catch {
        input = null;
      }
    }
  }
  const step = toolName ? STEPS[toolName] : undefined;
  if (!step) return null;
  const value = step.field && input ? input[step.field] : undefined;
  return {
    label: step.label,
    activeLabel: step.activeLabel,
    target: typeof value === "string" && value.length > 0 ? shortTarget(step.field, value) : null,
  };
}
