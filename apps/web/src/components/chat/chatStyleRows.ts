// Personal build: chat-style timeline. Two speakers, one rule:
//
//   Every time you say something (a message, a message sent mid-turn, or your
//   answer to the agent's question), the agent's work up to that point closes
//   into one "Worked for …" line.
//
// So the agent's side is always some work lines, each closed by something you
// said, and then its answer in a bubble. While it works, the newest line is
// live ("Reading bin.ts · 12s") and a typing bubble sits where the answer will
// appear. Each line opens to just its own part of the work, in place. A
// background job finishing is an event: a small centered line.
//
// The timeline hands this pass every row (no upstream folds), and the lines'
// open state lives in the existing per-group expansion set, keyed by the
// message that opened each block.
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as Equal from "effect/Equal";

import type { WorkLogEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export const CHAT_LIVE_WORK_ROW_ID = "chat-live-work-row";
export const CHAT_TYPING_ROW_ID = "chat-typing-row";

export type ChatWorkStatus =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool"; readonly entry: WorkLogEntry }
  | { readonly kind: "text"; readonly text: string };

type Row = MessagesTimelineRow;

const THINKING: ChatWorkStatus = { kind: "thinking" };

/** Your answer to a question the agent asked; shown as a reply. */
export const isQuestionReplyRow = (row: Row): row is Extract<Row, { kind: "work" }> =>
  row.kind === "work" && row.groupedEntries.length === 1 && !!row.groupedEntries[0]!.questionAnswer;

const isBackgroundEventRow = (row: Row): row is Extract<Row, { kind: "work-toggle" }> =>
  row.kind === "work-toggle" && !!row.isBackgroundEvent;

/** The agent's final reply for a turn; everything else it writes is a note in its work. */
export const isChatAnswerRow = (row: Row) =>
  row.kind === "message" &&
  row.message.role === "assistant" &&
  (row.showAssistantMeta || row.metaMovedBelowTools === true);

/** Rows that are the agent working: tools, thinking, notes, and provider bookkeeping. */
const isAgentWorkRow = (row: Row) =>
  (row.kind === "work" && !isQuestionReplyRow(row)) ||
  (row.kind === "work-toggle" && !isBackgroundEventRow(row)) ||
  row.kind === "work-live" ||
  row.kind === "activity-group" ||
  (row.kind === "message" &&
    (row.message.role === "reasoning" ||
      (row.message.role === "assistant" && !isChatAnswerRow(row))));

/** The provider turn a row belongs to; null for rows that don't say. */
function rowTurnId(row: Row): string | null {
  switch (row.kind) {
    case "message":
      return row.message.role === "user" ? null : (row.message.turnId ?? null);
    case "work":
      return row.groupedEntries[0]?.turnId ?? null;
    case "work-live":
      return row.entry.turnId ?? null;
    default:
      return null;
  }
}

/** The newest thing the running turn is doing, for the live work line. */
export function deriveChatWorkStatus(rows: ReadonlyArray<Row>): ChatWorkStatus {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    switch (row.kind) {
      case "work-live":
        return { kind: "tool", entry: row.entry };
      case "work": {
        const entry = row.groupedEntries.at(-1);
        if (entry) return { kind: "tool", entry };
        break;
      }
      case "work-toggle":
        return { kind: "text", text: row.summary };
      case "activity-group": {
        const last = row.entries.at(-1);
        return last?.kind === "work" ? { kind: "tool", entry: last.entry } : THINKING;
      }
      case "message": {
        if (row.message.role === "reasoning") return THINKING;
        if (row.message.role === "assistant") {
          const text = firstLine(row.message.text);
          if (text) return { kind: "text", text };
        }
        break;
      }
      default:
        break;
    }
  }
  return THINKING;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? "").replace(/[*_`#>]/g, "").slice(0, 160);
}

export function applyChatStyleRows(
  rows: ReadonlyArray<Row>,
  input: {
    /** Open work lines, by toggle id. */
    readonly expandedBlockIds: ReadonlySet<string>;
  },
): Row[] {
  const result: Row[] = [];
  let block: Row[] = [];
  // The last thing said (by you, or the agent's answer); the next block starts there.
  let opener: Row | null = null;
  // Set once the running turn begins; its last block is the live one.
  let live: { createdAt: string | null } | null = null;
  // The answer always comes last in its turn: work the agent did after its final
  // text (a last check, a trailing command) folds into the line above it, and the
  // answer waits until the turn's next boundary.
  // Typed through `as` so control flow doesn't pin it to null; closures assign it.
  let pendingAnswer = null as Extract<Row, { kind: "message" }> | null;
  // The turn the open block's work belongs to. Like upstream, each turn folds
  // on its own: a turn the agent starts without you (a Codex continuation)
  // never folds into the line above the previous turn's answer.
  let blockTurnId: string | null = null;

  const toggleIdFor = (first: Row) => `chat-work:${opener?.id ?? first.id}`;

  const closeBlock = (endAt: string | null) => {
    const first = block[0];
    if (!first) return;
    const toggleId = toggleIdFor(first);
    const expanded = input.expandedBlockIds.has(toggleId);
    const startAt = opener?.createdAt ?? first.createdAt;
    const lastAt = endAt ?? block.at(-1)!.createdAt;
    result.push({
      kind: "chat-work",
      id: toggleId,
      createdAt: startAt,
      toggleId,
      expanded,
      live: false,
      label:
        startAt && lastAt
          ? `Worked for ${formatDuration(Date.parse(lastAt) - Date.parse(startAt))}`
          : "Worked",
      status: THINKING,
    });
    if (expanded) result.push(...block);
    block = [];
    blockTurnId = null;
  };

  const flushAnswer = () => {
    if (!pendingAnswer) return;
    const answer = pendingAnswer;
    pendingAnswer = null;
    const lastWorkAt = block.at(-1)?.createdAt ?? null;
    closeBlock(
      lastWorkAt && answer.createdAt && lastWorkAt > answer.createdAt
        ? lastWorkAt
        : answer.createdAt,
    );
    result.push(answer);
    opener = answer;
  };

  const finishLive = () => {
    if (!live) return;
    const toggleId = `chat-work:${opener?.id ?? "live"}`;
    const expanded = input.expandedBlockIds.has(toggleId);
    result.push({
      kind: "chat-work",
      id: CHAT_LIVE_WORK_ROW_ID,
      createdAt: opener?.createdAt ?? live.createdAt,
      toggleId,
      expanded,
      live: true,
      label: "",
      status: deriveChatWorkStatus(block),
    });
    if (expanded) result.push(...block);
    result.push({ kind: "chat-typing", id: CHAT_TYPING_ROW_ID, createdAt: live.createdAt });
    block = [];
    live = null;
  };

  // Like upstream, while the agent works everything after your latest message
  // is still in progress: a note there is never the answer, even if a turn's
  // lifecycle lags behind the working state. The exception is the answer a
  // finished turn recorded (its checkpoint): once shown it stays, and work
  // after it, such as Claude waking up for a background task, starts the next
  // line.
  const working = rows.some((row) => row.kind === "working");
  const latestUserIndex = rows.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );

  for (const [index, row] of rows.entries()) {
    if (row.kind === "turn-fold" || row.kind === "thinking") continue;
    if (row.kind === "assistant-meta" && pendingAnswer) {
      // The copy button and time sit right under the answer.
      pendingAnswer = {
        ...pendingAnswer,
        showAssistantMeta: true,
        showAssistantCopyButton: row.showAssistantCopyButton,
      };
      continue;
    }
    const turnOfRow = rowTurnId(row);
    if (turnOfRow !== null) {
      if (pendingAnswer) {
        if (pendingAnswer.message.turnId && turnOfRow !== pendingAnswer.message.turnId) {
          flushAnswer();
        }
      } else if (block.length > 0 && blockTurnId !== null && turnOfRow !== blockTurnId) {
        // A turn that ended without an answer: its work closes on its own,
        // and the next turn's line starts at its own first row.
        closeBlock(null);
        opener = null;
      }
    }
    if (
      working &&
      index > latestUserIndex &&
      row.kind === "message" &&
      isChatAnswerRow(row) &&
      !row.assistantTurnDiffSummary
    ) {
      block.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
      blockTurnId = turnOfRow ?? blockTurnId;
      continue;
    }
    if (isChatAnswerRow(row) && row.kind === "message") {
      flushAnswer();
      pendingAnswer = row;
      continue;
    }
    if (row.kind === "working") {
      flushAnswer();
      live = { createdAt: row.createdAt };
      continue;
    }
    if (isAgentWorkRow(row)) {
      block.push(row);
      blockTurnId = turnOfRow ?? blockTurnId;
      continue;
    }
    if (row.kind === "worktree-setup") {
      result.push(row);
      continue;
    }
    if (row.kind === "queued-message") {
      flushAnswer();
      finishLive();
      result.push(row);
      continue;
    }
    // Something was said or happened: the work so far closes into its own line.
    if (pendingAnswer) flushAnswer();
    else closeBlock(row.createdAt);
    if (isQuestionReplyRow(row)) result.push({ ...row, chatReply: true });
    else if (isBackgroundEventRow(row)) result.push({ ...row, chatEvent: true });
    else result.push(row);
    opener = row;
  }
  flushAnswer();
  if (live) finishLive();
  else closeBlock(null);
  return result;
}

export function chatWorkStatusEquals(a: ChatWorkStatus, b: ChatWorkStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool" && b.kind === "tool") return Equal.equals(a.entry, b.entry);
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  return true;
}
