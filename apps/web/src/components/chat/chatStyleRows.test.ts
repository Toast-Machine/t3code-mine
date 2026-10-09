import { describe, expect, it } from "vite-plus/test";
import { ApprovalRequestId, MessageId, TurnId } from "@t3tools/contracts";

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

function settledRows(entries: TimelineEntry[], expandedBlockIds: ReadonlySet<string> = new Set()) {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries,
    latestTurn: { turnId, state: "completed", startedAt: time(0), completedAt: time(9) },
    expandedTurnIds: new Set([turnId]),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return applyChatStyleRows(rows, { expandedBlockIds });
}

function runningRows(entries: TimelineEntry[], expandedBlockIds: ReadonlySet<string> = new Set()) {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries,
    runningTurnId: turnId,
    expandedTurnIds: new Set([turnId]),
    isWorking: true,
    activeTurnStartedAt: time(0),
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return applyChatStyleRows(rows, { expandedBlockIds });
}

const question: TimelineEntry = {
  id: "question",
  kind: "work",
  createdAt: time(2),
  entry: {
    id: "question",
    turnId,
    createdAt: time(2),
    label: "Answered a question",
    tone: "info",
    questionAnswer: {
      requestId: ApprovalRequestId.make("request-1"),
      questionTextById: { q1: "Which phone should I use?" },
      answers: { q1: "My real phone" },
      attachmentsByQuestionId: {},
    },
  },
};

describe("applyChatStyleRows", () => {
  it("closes the work before the answer into one line", () => {
    const rows = settledRows(settledTurn);
    expect(rows.map((row) => row.kind)).toEqual(["message", "chat-work", "message"]);
    expect(rows[1]).toMatchObject({ live: false, expanded: false, label: "Worked for 4.0s" });
  });

  it("opens one line's work in place, between that line and what closed it", () => {
    const rows = settledRows(settledTurn, new Set(["chat-work:user"]));
    expect(rows[1]).toMatchObject({ kind: "chat-work", expanded: true });
    expect(rows.slice(2).map((row) => row.id)).toEqual(["read", "note", "test", "reply"]);
  });

  it("closes a line each time you answer a question", () => {
    const entries = [
      settledTurn[0]!,
      tool("read", "cat ZoomBar.tsx", 1),
      question,
      tool("test", "vp test run", 3),
      settledTurn[4]!,
    ];
    const rows = settledRows(entries);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "chat-work",
      "work",
      "chat-work",
      "message",
    ]);
    expect(rows[2]).toMatchObject({ id: "question", chatReply: true });
    expect(rows[1]).toMatchObject({ toggleId: "chat-work:user" });
    expect(rows[3]).toMatchObject({ toggleId: "chat-work:question" });
  });

  it("closes a line when you send a message mid-turn, and keeps the newest one live", () => {
    const entries = [
      ...settledTurn.slice(0, 3),
      message("steer", "user", "Also check the slider", 4),
      tool("slider", "vp test run slider", 5, true),
    ];
    const rows = runningRows(entries);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "chat-work",
      "message",
      "chat-work",
      "chat-typing",
    ]);
    expect(rows[1]).toMatchObject({ live: false, toggleId: "chat-work:user" });
    expect(rows[3]).toMatchObject({
      id: CHAT_LIVE_WORK_ROW_ID,
      live: true,
      toggleId: "chat-work:steer",
      status: { kind: "tool", entry: { id: "slider" } },
    });
    expect(rows[4]).toMatchObject({ id: CHAT_TYPING_ROW_ID });
  });

  it("keeps a live line's open state when the turn settles", () => {
    const open = new Set(["chat-work:user"]);
    const running = runningRows(
      [...settledTurn.slice(0, 3), tool("test", "vp test run", 3, true)],
      open,
    );
    expect(running.find((row) => row.kind === "chat-work")).toMatchObject({
      live: true,
      expanded: true,
    });
    expect(settledRows(settledTurn, open)[1]).toMatchObject({ live: false, expanded: true });
  });
});
