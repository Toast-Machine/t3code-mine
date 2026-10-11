import { describe, expect, it } from "@effect/vitest";

import {
  attributeSessions,
  resumeCursorSessionId,
  type UsageThreadDirectory,
} from "./usageBreakdown.ts";
import type { UsageSessionScanEntry } from "./UsageService.ts";

function session(overrides: Partial<UsageSessionScanEntry>): UsageSessionScanEntry {
  return {
    sessionId: "s",
    filePath: "/x.jsonl",
    costUsd: 1,
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    records: 1,
    models: [],
    hours: [{ hourStartMs: Date.parse("2026-10-08T10:00:00.000Z"), costUsd: 1, records: 1 }],
    ...overrides,
  };
}

const directory: UsageThreadDirectory = {
  sessionThreads: new Map([["claude:resumed", "thread-1"]]),
  threads: new Map([
    ["thread-1", { projectId: "p1", title: "Invoice split", worktreePath: null, deleted: false }],
    [
      "thread-2",
      { projectId: "p1", title: "Worktree chat", worktreePath: "/wt/feature", deleted: false },
    ],
    ["thread-3", { projectId: "p1", title: "Gone", worktreePath: null, deleted: true }],
  ]),
  projects: new Map([
    ["p1", { title: "Acme", workspaceRoot: "/code/acme" }],
    ["p2", { title: "Acme web", workspaceRoot: "/code/acme/web" }],
  ]),
};

describe("attributeSessions", () => {
  it("joins a session to its thread through the resume cursor", () => {
    const [result] = attributeSessions("claude", [session({ sessionId: "resumed" })], directory);
    expect(result).toMatchObject({
      threadId: "thread-1",
      title: "Invoice split",
      projectId: "p1",
      projectTitle: "Acme",
    });
  });

  it("falls back to a thread's worktree, then the deepest containing project", () => {
    const [worktree, nested, outside] = attributeSessions(
      "claude",
      [
        session({ sessionId: "a", cwd: "/wt/feature/apps/server" }),
        session({ sessionId: "b", cwd: "/code/acme/web/src", title: "CLI title" }),
        session({ sessionId: "c", cwd: "/tmp" }),
      ],
      directory,
    );
    expect(worktree).toMatchObject({ threadId: "thread-2", projectTitle: "Acme" });
    expect(nested).toMatchObject({ title: "CLI title", projectId: "p2" });
    expect(nested?.threadId).toBeUndefined();
    expect(outside?.projectId).toBeUndefined();
    expect(outside?.cwd).toBe("/tmp");
  });

  it("matches Windows working directories however they were recorded", () => {
    const [result] = attributeSessions(
      "codex",
      [session({ sessionId: "win", cwd: "\\\\?\\c:\\Code\\Acme\\src" })],
      {
        ...directory,
        projects: new Map([["p1", { title: "Acme", workspaceRoot: "C:/Code/Acme" }]]),
      },
    );
    expect(result).toMatchObject({ projectId: "p1" });
  });

  it("keeps a deleted thread's title without linking to it", () => {
    const [result] = attributeSessions("codex", [session({ sessionId: "gone" })], {
      ...directory,
      sessionThreads: new Map([["codex:gone", "thread-3"]]),
    });
    expect(result?.title).toBe("Gone");
    expect(result?.threadId).toBeUndefined();
  });
});

describe("resumeCursorSessionId", () => {
  it("reads each provider's own session field", () => {
    const claude = '{"threadId":"t3-thread","resume":"claude-session"}';
    expect(resumeCursorSessionId("claude", claude)).toBe("claude-session");
    expect(resumeCursorSessionId("codex", '{"threadId":"codex-thread"}')).toBe("codex-thread");
    expect(resumeCursorSessionId("claude", "not json")).toBeNull();
  });
});
