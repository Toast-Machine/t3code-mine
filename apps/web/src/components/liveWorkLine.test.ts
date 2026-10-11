import { EventId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { liveWorkLine } from "./liveWorkLine";

const turnId = TurnId.make("turn-1");
const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

const working = {
  latestTurn: {
    turnId,
    state: "running" as const,
    requestedAt: time(10),
    startedAt: time(10),
    completedAt: null,
    assistantMessageId: null,
  },
  session: null,
  latestAssistantPreview: "Fixed. The zoom bar no longer flashes.",
  latestAssistantPreviewAt: time(5),
  liveActivity: null,
  planProgress: null,
};

const gitActivity = {
  id: EventId.make("activity-1"),
  tone: "tool" as const,
  kind: "tool.updated",
  summary: "Command run",
  payload: {
    itemType: "command_execution",
    status: "inProgress",
    title: "Command run",
    detail: "Bash: git status",
    data: { toolName: "Bash", command: "git status" },
  },
  turnId,
  createdAt: time(12),
};

describe("liveWorkLine", () => {
  it("never shows the previous turn's answer", () => {
    expect(liveWorkLine(working)).toBe("Thinking");
  });

  it("names the step the agent is on", () => {
    expect(liveWorkLine({ ...working, liveActivity: gitActivity })).toBe("Running git");
  });

  it("names a command the server cut off inside a quoted argument", () => {
    const command = `sqlite3 -readonly state.sqlite "select title from projection_threads where`;
    const cut = {
      ...gitActivity,
      payload: {
        ...gitActivity.payload,
        detail: `Bash: ${command}`,
        data: { toolName: "Bash", command },
      },
    };
    expect(liveWorkLine({ ...working, liveActivity: cut })).toBe("Running sqlite3");
  });

  it("shows the agent's newest note from this turn", () => {
    const note = {
      ...working,
      liveActivity: gitActivity,
      latestAssistantPreview: "Checking how the zoom bar loads.",
      latestAssistantPreviewAt: time(14),
    };
    expect(liveWorkLine(note)).toBe("Checking how the zoom bar loads.");
  });
});
