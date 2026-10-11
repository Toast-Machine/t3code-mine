// Personal build: the one line that says what a working chat is doing, shown
// after "Working" in the sidebar and as the chat's live line, from the same
// thread summary so the two always agree. Like a messages app showing
// "typing…" instead of the old message: the agent's note from this turn
// ("Checking how the zoom bar loads"), or else the step it's on ("Running
// git"; the server keeps the newest step still running, ThreadPlanProgress.ts),
// or "Thinking" between steps. The previous turn's answer is stale, so it
// never shows.
import { deriveWorkLogEntries } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import { liveWorkEntryLabel } from "./chat/MessagesTimeline.logic";
import { sidebarMessagePreview } from "./messagePreview";
import { resolveWorkingStartedAt } from "./Sidebar.logic";

export function liveWorkLine(
  thread: Pick<
    SidebarThreadSummary,
    | "latestTurn"
    | "session"
    | "latestAssistantPreview"
    | "latestAssistantPreviewAt"
    | "liveActivity"
    | "planProgress"
  >,
): string {
  const startedAt = resolveWorkingStartedAt(thread);
  const inThisTurn = (at: string | null | undefined): at is string =>
    !!at && (startedAt === null || at >= startedAt);
  const activity =
    thread.liveActivity && inThisTurn(thread.liveActivity.createdAt) ? thread.liveActivity : null;
  const step = activity ? deriveWorkLogEntries([activity]).at(-1) : undefined;
  const noteAt = thread.latestAssistantPreviewAt;
  const note =
    inThisTurn(noteAt) && (!step || noteAt >= step.createdAt)
      ? sidebarMessagePreview(thread.latestAssistantPreview)
      : null;
  if (note) return note;
  if (step) {
    const named = step.command ? { ...step, command: closeCutQuote(step.command) } : step;
    return step.activeLabel ?? liveWorkEntryLabel(named, undefined, true);
  }
  return thread.planProgress?.step ?? "Thinking";
}

// The server cuts the live step's strings short (ThreadPlanProgress.ts), often
// inside a quoted argument, and an unclosed quote stops the command's program
// name from parsing ("Running command" instead of "Running sqlite3").
export function closeCutQuote(command: string): string {
  let open: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (open === null) {
      if (char === "\\") index += 1;
      else if (char === "'" || char === '"') open = char;
    } else if (open === '"' && char === "\\") {
      index += 1;
    } else if (char === open) {
      open = null;
    }
  }
  return open === null ? command : command + open;
}
