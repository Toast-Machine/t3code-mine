import { useSyncExternalStore } from "react";

import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";

// Personal build: when an agent's background work (a monitor, a background
// shell, subagents) finishes after its turn already ended, the agent usually
// starts a new turn to react a few seconds later (2–10s in practice). In that
// gap the thread briefly looks done, so the sidebar moved it out of Working,
// the "done" sound played, and then it jumped straight back. Keep reporting the
// last background state for a short grace window instead; if the agent starts
// again inside it nothing changes, otherwise the thread settles once it ends.
export const BACKGROUND_GRACE_MS = 12_000;

type Liveness = "working" | "monitoring";
type GraceInput = Parameters<typeof resolveSidebarThreadStatus>[0] & {
  readonly latestTurn?: { readonly state?: string } | null;
};

const lastSeen = new Map<string, Liveness | null>();
const held = new Map<string, { readonly liveness: Liveness; readonly until: number }>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleExpiry(now: number) {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  let next = Infinity;
  for (const hold of held.values()) next = Math.min(next, hold.until);
  if (next === Infinity) return;
  timer = setTimeout(
    () => {
      const at = Date.now();
      for (const [key, hold] of held) if (hold.until <= at) held.delete(key);
      version += 1;
      for (const listener of listeners) listener();
      scheduleExpiry(at);
    },
    Math.max(0, next - now),
  );
}

/** Returns the thread as it should be presented: unchanged, or with its last
    background state kept while the grace window runs. Safe to call from many
    places with the same data; the first caller to see the transition starts
    the window. */
export function withBackgroundGrace<T extends GraceInput>(
  key: string,
  thread: T,
  now = Date.now(),
): T {
  const live = thread.backgroundLiveness ?? null;
  const previous = lastSeen.get(key) ?? null;
  lastSeen.set(key, live);
  if (live !== null) {
    held.delete(key);
    return thread;
  }
  // Only an otherwise idle thread is held: a new turn, an approval, a
  // question, or a failure shows immediately.
  const idle =
    resolveSidebarThreadStatus(thread) === "ready" && thread.latestTurn?.state !== "error";
  if (!idle) {
    held.delete(key);
    return thread;
  }
  if (previous !== null && !held.has(key)) {
    held.set(key, { liveness: previous, until: now + BACKGROUND_GRACE_MS });
    scheduleExpiry(now);
  }
  const hold = held.get(key);
  if (hold === undefined || hold.until <= now) return thread;
  return { ...thread, backgroundLiveness: hold.liveness };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever a grace window ends, so callers re-derive their view. */
export function useBackgroundGraceVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}
