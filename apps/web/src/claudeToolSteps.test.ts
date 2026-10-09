import { describe, expect, it } from "vite-plus/test";

import { describeClaudeToolStep } from "./claudeToolSteps";

describe("describeClaudeToolStep", () => {
  it("names a finished read from its input", () => {
    expect(
      describeClaudeToolStep({
        detail: 'Read: {"file_path":"/repo/apps/server/src/bin.ts"}',
        data: { toolName: "Read", input: { file_path: "/repo/apps/server/src/bin.ts" } },
      }),
    ).toEqual({ label: "Read", activeLabel: "Reading", target: "bin.ts" });
  });

  it("reads the input from the detail while the step is still running", () => {
    expect(
      describeClaudeToolStep({
        detail: 'Grep: {"pattern":"Effect.fn(","path":"src"}',
        data: { toolName: "Grep" },
      }),
    ).toMatchObject({ activeLabel: "Searching for", target: "Effect.fn(" });
  });

  it("leaves tools it doesn't know to the existing labels", () => {
    expect(describeClaudeToolStep({ data: { toolName: "Bash", input: {} } })).toBeNull();
  });
});
