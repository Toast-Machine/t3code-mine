// Personal build: what a working chat's sidebar line says after "Working".
// Like a messages app showing "typing…" instead of the old message: the
// agent's note from this turn ("Checking how the zoom bar loads"), or else
// the step it's on, named the same way the chat's live line names it
// ("Running git"). The previous turn's answer is stale, so it never shows.
import { deriveWorkLogEntries } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import { liveWorkEntryLabel } from "./chat/MessagesTimeline.logic";
import { sidebarMessagePreview } from "./messagePreview";
import { resolveWorkingStartedAt } from "./Sidebar.logic";

export function sidebarWorkingDetail(
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
  if (step) return step.activeLabel ?? liveWorkEntryLabel(step, undefined, true);
  return thread.planProgress?.step ?? "";
}
