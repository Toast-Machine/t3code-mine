import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { useMemo } from "react";

import { useThreadShellsWithGrace } from "../threadShellsWithGrace";
import { environmentServerConfigsAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import {
  hasUnseenCompletion,
  isSidebarThreadWorking,
  resolveSidebarThreadStatus,
} from "./Sidebar.logic";

// Personal build: a snoozed thread that woke and hasn't been looked at since.
// Same rule as the sidebar row's Woke label; opening the thread or marking it
// read clears it.
export function isThreadWoke(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  now: string,
): boolean {
  if (thread.settledOverride === "settled") return false;
  const wokeAt = threadWokeAt(thread, { now });
  const wokeMs = wokeAt === null ? Number.NaN : Date.parse(wokeAt);
  if (Number.isNaN(wokeMs)) return false;
  const visitedMs = lastVisitedAt === undefined ? Number.NaN : Date.parse(lastVisitedAt);
  return Number.isNaN(visitedMs) || visitedMs < wokeMs;
}

interface NeedsYouCapabilities {
  readonly threadSnooze?: boolean;
  readonly threadSettlement?: boolean;
}

// Personal build: how many threads need you, for the dock badge. Same rule as
// the sidebar's "Needs you" group (approval, input, failed, woke, or finished
// and unread), across every project, pins included. Snoozed, settled, archived,
// and still-working threads don't count.
export function countThreadsNeedingYou(
  threads: readonly EnvironmentThreadShell[],
  capabilitiesOf: (thread: EnvironmentThreadShell) => NeedsYouCapabilities | undefined,
  lastVisitedAtByKey: Readonly<Record<string, string>>,
  now: string,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || isSidebarThreadWorking(thread)) continue;
    const capabilities = capabilitiesOf(thread);
    if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now })) continue;
    if (capabilities?.threadSettlement === true && thread.settledOverride === "settled") continue;
    const status = resolveSidebarThreadStatus(thread);
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (
      status === "approval" ||
      status === "input" ||
      status === "failed" ||
      isThreadWoke(thread, lastVisitedAtByKey[key], now) ||
      hasUnseenCompletion({ ...thread, lastVisitedAt: lastVisitedAtByKey[key] })
    ) {
      count += 1;
    }
  }
  return count;
}

export function useNeedsYouCount(): number {
  const threads = useThreadShellsWithGrace();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  return useMemo(
    () =>
      countThreadsNeedingYou(
        threads,
        (thread) => serverConfigs.get(thread.environmentId)?.environment.capabilities,
        lastVisitedAtByKey,
        new Date().toISOString(),
      ),
    [threads, serverConfigs, lastVisitedAtByKey],
  );
}
