// Personal build: chat-style timeline. Rearranges the rows the timeline already
// derives into a small model, so a conversation reads as a plain back-and-forth:
//
// - Your message, then one work line per turn, then the answer.
// - The work line is live while the agent works ("Reading bin.ts · 12s") and
//   becomes "Worked for 1m 21s" when it settles. It never moves; opening it
//   lists the turn's work right under it. Meanwhile a typing bubble sits where
//   the answer will appear.
// - Bookkeeping the provider reports outside a turn's work (for example
//   "Claude system message …") goes inside that work, never between the two.
// - A background job finishing is an event: a small line of its own.
//
// Nothing is dropped. Every hidden row is one toggle away, and the toggles reuse
// the existing per-turn expansion state.
import type { TurnId } from "@t3tools/contracts";
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

const isUserMessage = (row: Row) => row.kind === "message" && row.message.role === "user";

/** Rows that belong inside a turn's work rather than in the conversation. */
const isWorkRow = (row: Row) =>
  row.kind === "work" ||
  row.kind === "work-toggle" ||
  row.kind === "work-live" ||
  row.kind === "activity-group" ||
  (row.kind === "message" && row.message.role === "reasoning");

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
    /** The running turn, whose expansion state opens the live work. */
    readonly activeTurnId: TurnId | null;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  },
): Row[] {
  const result: Row[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;

    if (row.kind === "turn-fold") {
      // Work rows just above the fold (after the last message) belong to this
      // turn's work. Background jobs finishing stay out as events.
      const bookkeeping: Row[] = [];
      const events: Row[] = [];
      while (result.length > 0 && isWorkRow(result.at(-1)!)) {
        const previous = result.pop()!;
        if (previous.kind === "work-toggle" && previous.isBackgroundEvent) {
          events.unshift({ ...previous, chatEvent: true });
        } else {
          bookkeeping.unshift(previous);
        }
      }
      result.push(...events, {
        kind: "chat-work",
        id: row.id,
        createdAt: row.createdAt,
        turnId: row.turnId,
        expanded: row.expanded,
        live: false,
        label: row.label,
        status: THINKING,
      });
      if (row.expanded) result.push(...bookkeeping);
      continue;
    }

    if (row.kind === "working") {
      let end = index + 1;
      while (end < rows.length && rows[end]!.kind !== "queued-message") end += 1;
      const segment = rows.slice(index + 1, end);
      const expanded = input.activeTurnId !== null && input.expandedTurnIds.has(input.activeTurnId);
      result.push({
        kind: "chat-work",
        id: CHAT_LIVE_WORK_ROW_ID,
        createdAt: row.createdAt,
        turnId: input.activeTurnId,
        expanded,
        live: true,
        label: "",
        status: deriveChatWorkStatus(segment),
      });
      for (const other of segment) {
        if (other.kind === "thinking") continue;
        if (expanded || other.kind === "worktree-setup") result.push(other);
      }
      result.push({ kind: "chat-typing", id: CHAT_TYPING_ROW_ID, createdAt: row.createdAt });
      index = end - 1;
      continue;
    }

    if (row.kind === "work-toggle" && row.isBackgroundEvent && isBetweenTurns(rows, index)) {
      result.push({ ...row, chatEvent: true });
      continue;
    }

    result.push(row);
  }
  return result;
}

/** A background event not followed by a turn of its own (the agent stayed idle). */
function isBetweenTurns(rows: ReadonlyArray<Row>, index: number): boolean {
  const next = rows[index + 1];
  return next === undefined || isUserMessage(next) || next.kind === "queued-message";
}

export function chatWorkStatusEquals(a: ChatWorkStatus, b: ChatWorkStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool" && b.kind === "tool") return Equal.equals(a.entry, b.entry);
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  return true;
}
