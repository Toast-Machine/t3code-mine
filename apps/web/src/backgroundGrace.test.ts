import { describe, expect, it } from "vite-plus/test";

import { BACKGROUND_GRACE_MS, withBackgroundGrace } from "./backgroundGrace";

const idle = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  backgroundLiveness: null,
  latestTurn: { state: "completed" },
};
const T0 = 1_000_000;
let keyCount = 0;
const freshKey = () => `env:thread-${++keyCount}`;

describe("withBackgroundGrace", () => {
  it("keeps the last background state through the grace window, then lets go", () => {
    const key = freshKey();
    withBackgroundGrace(key, { ...idle, backgroundLiveness: "monitoring" as const }, T0);
    expect(withBackgroundGrace(key, idle, T0 + 1).backgroundLiveness).toBe("monitoring");
    expect(withBackgroundGrace(key, idle, T0 + BACKGROUND_GRACE_MS - 1).backgroundLiveness).toBe(
      "monitoring",
    );
    expect(withBackgroundGrace(key, idle, T0 + BACKGROUND_GRACE_MS + 2).backgroundLiveness).toBe(
      null,
    );
  });

  it("shows a new turn, an approval, or a failure right away", () => {
    for (const next of [
      { ...idle, session: { status: "running" } as never },
      { ...idle, hasPendingApprovals: true },
      { ...idle, latestTurn: { state: "error" } },
    ]) {
      const key = freshKey();
      withBackgroundGrace(key, { ...idle, backgroundLiveness: "working" as const }, T0);
      expect(withBackgroundGrace(key, next, T0 + 1)).toBe(next);
    }
  });

  it("does nothing for threads that never had background work", () => {
    const key = freshKey();
    expect(withBackgroundGrace(key, idle, T0)).toBe(idle);
    expect(withBackgroundGrace(key, idle, T0 + 1)).toBe(idle);
  });
});
