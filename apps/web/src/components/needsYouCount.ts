import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useMemo } from "react";

import { useThreadShells } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import {
  hasUnseenCompletion,
  isSidebarThreadWorking,
  resolveSidebarThreadStatus,
} from "./Sidebar.logic";

interface NeedsYouCapabilities {
  readonly threadSnooze?: boolean;
  readonly threadSettlement?: boolean;
}

// Personal build: how many threads need you, for the dock badge. Same rule as
// the sidebar's "Needs you" group (approval, input, failed, or finished and
// unread), across every project, pins included. Snoozed, settled, archived,
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
      hasUnseenCompletion({ ...thread, lastVisitedAt: lastVisitedAtByKey[key] })
    ) {
      count += 1;
    }
  }
  return count;
}

export function useNeedsYouCount(): number {
  const threads = useThreadShells();
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
