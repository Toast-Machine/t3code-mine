import { describe, expect, it } from "vite-plus/test";
import { ApprovalRequestId, CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { applyChatStyleRows, CHAT_LIVE_WORK_ROW_ID, CHAT_TYPING_ROW_ID } from "./chatStyleRows";

const turnId = TurnId.make("turn-1");
// The timeline unfolds every turn before the chat pass (see MessagesTimeline).
const everyTurn = new Set([turnId, TurnId.make("turn-2")]);
const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
  turn = turnId,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: time(second),
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId: role === "user" ? null : turn,
      createdAt: time(second),
      updatedAt: time(second),
      streaming: false,
    },
  };
}

function tool(
  id: string,
  label: string,
  second: number,
  running = false,
  turn = turnId,
): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: time(second),
    entry: {
      id,
      turnId: turn,
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
    expandedTurnIds: everyTurn,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    flatWork: true,
  });
  return applyChatStyleRows(rows, { expandedBlockIds });
}

function runningRows(entries: TimelineEntry[], expandedBlockIds: ReadonlySet<string> = new Set()) {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries,
    runningTurnId: turnId,
    expandedTurnIds: everyTurn,
    isWorking: true,
    activeTurnStartedAt: time(0),
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    flatWork: true,
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

  it("keeps a question still waiting on you in the agent's work, not as your reply", () => {
    const pending: TimelineEntry = {
      ...question,
      entry: {
        ...question.entry,
        questionAnswer: { ...question.entry.questionAnswer!, answers: {} },
      },
    } as TimelineEntry;
    const rows = runningRows([settledTurn[0]!, tool("read", "cat ZoomBar.tsx", 1), pending]);
    expect(rows.map((row) => row.kind)).toEqual(["message", "chat-work", "chat-typing"]);
    expect(rows.some((row) => "chatReply" in row && row.chatReply)).toBe(false);
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
    });
    expect(rows[4]).toMatchObject({ id: CHAT_TYPING_ROW_ID });
  });

  it("opens a line to one row per step, with no groups inside it", () => {
    const entries = [
      message("user", "user", "Check the build", 0),
      tool("status", "git status", 1),
      tool("diff", "git diff", 2),
      tool("test", "vp test run", 3),
      message("reply", "assistant", "All green.", 4),
    ];
    const rows = settledRows(entries, new Set(["chat-work:user"]));
    expect(rows.map((row) => row.id)).toEqual([
      "user",
      "chat-work:user",
      "status",
      "diff",
      "test",
      "reply",
    ]);
  });

  it("opens a background event's details right under it", () => {
    const jobDone: TimelineEntry = {
      id: "job-done",
      kind: "work",
      createdAt: time(6),
      entry: {
        id: "job-done",
        turnId,
        createdAt: time(6),
        label: "Backfill finished",
        tone: "info",
        sourceActivityKind: "task.completed",
        taskId: "job",
        isBackgroundTask: true,
        detail: "Scanned 304 portals.",
      },
    };
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [...settledTurn, jobDone],
      latestTurn: { turnId, state: "completed", startedAt: time(0), completedAt: time(9) },
      expandedTurnIds: everyTurn,
      expandedWorkGroupIds: new Set(["work-group:job-done"]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      flatWork: true,
    });
    const chat = applyChatStyleRows(rows, { expandedBlockIds: new Set() });
    const event = chat.findIndex((row) => "chatEvent" in row && row.chatEvent);
    expect(event).toBeGreaterThan(-1);
    expect(chat[event + 1]).toMatchObject({ id: "work-group:job-done:details" });
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

  it("keeps the answer last when the agent worked after writing it", () => {
    const entries = [...settledTurn, tool("check", "git status", 5)];
    const rows = settledRows(entries);
    expect(rows.map((row) => row.kind)).toEqual(["message", "chat-work", "message"]);
    expect(rows[2]).toMatchObject({ id: "reply", showAssistantMeta: true });
    const open = settledRows(entries, new Set(["chat-work:user"]));
    expect(open.at(-1)).toMatchObject({ id: "reply" });
    expect(open.some((row) => row.id === "check")).toBe(true);
    expect(open.some((row) => row.kind === "assistant-meta")).toBe(false);
  });

  it("gives a turn the agent started on its own its own line", () => {
    const nextTurn = TurnId.make("turn-2");
    const entries = [
      ...settledTurn,
      tool("git", "git status", 6, false, nextTurn),
      message("summary", "assistant", "Updated the copy.", 8, nextTurn),
    ];
    const rows = settledRows(entries);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "chat-work",
      "message",
      "chat-work",
      "message",
    ]);
    expect(rows[1]).toMatchObject({ label: "Worked for 4.0s" });
    expect(rows[2]).toMatchObject({ id: "reply" });
    expect(rows[3]).toMatchObject({ toggleId: "chat-work:reply", label: "Worked for 4.0s" });
    expect(rows[4]).toMatchObject({ id: "summary" });
  });

  describe("when the agent wakes up on its own after answering", () => {
    // The first turn ended and recorded its answer; a finished background task
    // then woke the agent, which works on in a turn of its own.
    const wakeTurn = TurnId.make("turn-2");
    const finishedFirstTurn = {
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/turn-1"),
      status: "missing" as const,
      files: [],
      assistantMessageId: MessageId.make("reply"),
      completedAt: time(5),
    };
    const answerAndLiveLine = [
      "message",
      "chat-work",
      "message",
      "chat-work",
      "chat-typing",
    ] as const;

    it("keeps the answer while the wake-up turn works", () => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [...settledTurn, tool("audit", "cat audit.md", 8, true, wakeTurn)],
        latestTurn: { turnId: wakeTurn, state: "running", startedAt: time(7), completedAt: null },
        runningTurnId: wakeTurn,
        expandedTurnIds: everyTurn,
        isWorking: true,
        activeTurnStartedAt: time(7),
        turnDiffSummaries: [finishedFirstTurn],
        supportsConversationRollback: false,
      });
      const chat = applyChatStyleRows(rows, { expandedBlockIds: new Set() });
      expect(chat.map((row) => row.kind)).toEqual(answerAndLiveLine);
      expect(chat[2]).toMatchObject({ id: "reply" });
      expect(chat[3]).toMatchObject({ id: CHAT_LIVE_WORK_ROW_ID, toggleId: "chat-work:reply" });
    });

    it("keeps the answer before the wake-up turn has started", () => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: settledTurn,
        latestTurn: { turnId, state: "completed", startedAt: time(0), completedAt: time(5) },
        expandedTurnIds: everyTurn,
        isWorking: true,
        activeTurnStartedAt: time(7),
        turnDiffSummaries: [finishedFirstTurn],
        supportsConversationRollback: false,
      });
      const chat = applyChatStyleRows(rows, { expandedBlockIds: new Set() });
      expect(chat.map((row) => row.kind)).toEqual(answerAndLiveLine);
      expect(chat[2]).toMatchObject({ id: "reply" });
    });
  });

  it("never treats a note as the answer while the agent is still working", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [...settledTurn.slice(0, 3), tool("test", "vp test run", 3)],
      // A turn whose lifecycle lags the working state.
      latestTurn: { turnId, state: "completed", startedAt: time(0), completedAt: time(3) },
      expandedTurnIds: everyTurn,
      isWorking: true,
      activeTurnStartedAt: time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const chat = applyChatStyleRows(rows, { expandedBlockIds: new Set() });
    expect(chat.map((row) => row.kind)).toEqual(["message", "chat-work", "chat-typing"]);
  });
});
