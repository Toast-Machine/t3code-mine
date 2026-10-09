import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { applyChatStyleRows, CHAT_LIVE_WORK_ROW_ID, CHAT_TYPING_ROW_ID } from "./chatStyleRows";

const turnId = TurnId.make("turn-1");
const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time(second),
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId: role === "user" ? null : turnId,
      createdAt: time(second),
      updatedAt: time(second),
      streaming: false,
    },
  };
}

function tool(id: string, label: string, second: number, running = false): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time(second),
    entry: {
      id,
      turnId,
      createdAt: time(second),
      label,
      tone: "tool",
      itemType: "command_execution",
      command: label,
      toolLifecycleStatus: running ? "inProgress" : "completed",
    },
  };
}

const settledTurn = [
  message("user", "user", "Fix the zoom bar", 0),
  tool("read", "cat ZoomBar.tsx", 1),
  message("note", "assistant", "Checking how the zoom bar loads.", 2),
  tool("test", "vp test run", 3),
  message("reply", "assistant", "Fixed. The zoom bar no longer flashes.", 4),
];

function settledRows(expanded: boolean) {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: settledTurn,
    latestTurn: { turnId, state: "completed", startedAt: time(0), completedAt: time(5) },
    expandedTurnIds: expanded ? new Set([turnId]) : new Set(),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return applyChatStyleRows(rows, {
    activeTurnId: null,
    expandedTurnIds: expanded ? new Set([turnId]) : new Set(),
  });
}

describe("applyChatStyleRows", () => {
  it("shows a settled turn as one work line followed by the answer", () => {
    const rows = settledRows(false);
    expect(rows.map((row) => row.kind)).toEqual(["message", "chat-work", "message"]);
    expect(rows[1]).toMatchObject({ live: false, expanded: false, turnId });
    expect(rows[2]).toMatchObject({ id: "reply", showAssistantMeta: true });
  });

  it("opens a settled turn's work in place, between the work line and the answer", () => {
    const rows = settledRows(true);
    expect(rows[1]).toMatchObject({ kind: "chat-work", expanded: true });
    expect(rows.at(-1)).toMatchObject({ id: "reply" });
    expect(rows.some((row) => row.id === "note")).toBe(true);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
  });

  it("keeps a running turn to one live work line that names the current step", () => {
    const entries = [...settledTurn.slice(0, 3), tool("test", "vp test run", 3, true)];
    const derive = (expanded: boolean) =>
      applyChatStyleRows(
        deriveMessagesTimelineRows({
          timelineEntries: entries,
          runningTurnId: turnId,
          isWorking: true,
          activeTurnStartedAt: time(0),
          turnDiffSummaries: [],
          supportsConversationRollback: false,
        }),
        { activeTurnId: turnId, expandedTurnIds: expanded ? new Set([turnId]) : new Set() },
      );

    const collapsed = derive(false);
    expect(collapsed.map((row) => row.id)).toEqual([
      "user",
      CHAT_LIVE_WORK_ROW_ID,
      CHAT_TYPING_ROW_ID,
    ]);
    expect(collapsed[1]).toMatchObject({
      kind: "chat-work",
      live: true,
      expanded: false,
      status: { kind: "tool", entry: { id: "test" } },
    });

    // Opening it lists the live work under the line, which stays in place, and
    // the typing bubble stays last.
    const expanded = derive(true);
    expect(expanded[1]).toMatchObject({ kind: "chat-work", expanded: true });
    expect(expanded.at(-1)).toMatchObject({ kind: "chat-typing" });
    expect(expanded.some((row) => row.id === "note")).toBe(true);
    expect(expanded.some((row) => row.kind === "working" || row.kind === "thinking")).toBe(false);
  });
});
