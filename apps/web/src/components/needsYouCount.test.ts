import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { countThreadsNeedingYou } from "./needsYouCount";

const NOW = "2026-10-08T12:00:00.000Z";
const capable = () => ({ threadSnooze: true, threadSettlement: true });

let nextId = 0;
function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  nextId += 1;
  return {
    id: `thread-${nextId}`,
    environmentId: "env",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    snoozedUntil: null,
    settledOverride: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

// A never-visited thread counts as read (as in the sidebar), so unread
// completions need an earlier visit.
function seenBefore(threads: readonly EnvironmentThreadShell[]): Record<string, string> {
  return Object.fromEntries(
    threads.map((entry) => [
      scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id)),
      EARLIER,
    ]),
  );
}
const EARLIER = "2026-10-08T10:00:00.000Z";

const completed = {
  latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-10-08T11:00:00.000Z" },
};

describe("countThreadsNeedingYou", () => {
  it("counts approvals, input, failures, and unread completions", () => {
    const threads = [
      thread({ hasPendingApprovals: true }),
      thread({ hasPendingUserInput: true }),
      thread({ session: { status: "error" } }),
      thread(completed),
      thread(),
    ];
    expect(countThreadsNeedingYou(threads, capable, seenBefore(threads), NOW)).toBe(4);
  });

  it("stops counting a completion once the thread is visited", () => {
    const read = thread(completed);
    const visited = {
      [scopedThreadKey(scopeThreadRef(read.environmentId, read.id))]: "2026-10-08T11:30:00.000Z",
    };
    expect(countThreadsNeedingYou([read], capable, visited, NOW)).toBe(0);
  });

  it("skips archived, snoozed, settled, and working threads", () => {
    const threads = [
      thread({ ...completed, archivedAt: NOW }),
      thread({ ...completed, snoozedUntil: "2026-10-09T00:00:00.000Z" }),
      thread({ ...completed, settledOverride: "settled" }),
      thread({ session: { status: "running" } }),
    ];
    expect(countThreadsNeedingYou(threads, capable, seenBefore(threads), NOW)).toBe(0);
  });

  it("counts snoozed and settled threads on servers that can't snooze or settle", () => {
    const threads = [
      thread({ ...completed, snoozedUntil: "2026-10-09T00:00:00.000Z" }),
      thread({ ...completed, settledOverride: "settled" }),
    ];
    expect(countThreadsNeedingYou(threads, () => undefined, seenBefore(threads), NOW)).toBe(2);
  });
});
