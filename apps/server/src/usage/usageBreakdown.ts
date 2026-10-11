/**
 * Where a quota window went: per-session usage from `UsageService`, named by
 * the T3 thread and project each session belongs to.
 *
 * A session joins its thread through the provider resume cursor T3 stores.
 * Sessions the cursor no longer names (a thread that started over, or work
 * run outside T3) fall back to their working directory: a thread's worktree,
 * else the project whose workspace contains it.
 *
 * @module usageBreakdown
 */
import {
  type UsageBreakdown,
  type UsageBreakdownInput,
  type UsageBreakdownSession,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { type UsageSessionScanEntry, UsageService } from "./UsageService.ts";

export interface UsageThreadDirectory {
  /** `provider:sessionId` → thread id. */
  readonly sessionThreads: ReadonlyMap<string, string>;
  readonly threads: ReadonlyMap<
    string,
    {
      readonly projectId: string;
      readonly title: string;
      readonly worktreePath: string | null;
      readonly deleted: boolean;
    }
  >;
  readonly projects: ReadonlyMap<
    string,
    { readonly title: string; readonly workspaceRoot: string }
  >;
}

const DRIVER_USAGE_KIND: Record<string, UsageProviderKind> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
};

/** The provider session a stored resume cursor points at. Claude's `threadId` is T3's own. */
export function resumeCursorSessionId(provider: UsageProviderKind, cursorJson: string | null) {
  if (!cursorJson) return null;
  let cursor: unknown;
  try {
    cursor = JSON.parse(cursorJson);
  } catch {
    return null;
  }
  if (typeof cursor !== "object" || cursor === null) return null;
  const record = cursor as Record<string, unknown>;
  const keys =
    provider === "claude"
      ? ["resume"]
      : provider === "codex"
        ? ["threadId"]
        : ["sessionId", "resume", "threadId"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

const loadThreadDirectory = Effect.fn("usage.loadThreadDirectory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cursors = yield* sql<{
    threadId: string;
    providerName: string;
    resumeCursor: string | null;
  }>`
    SELECT thread_id AS "threadId", provider_name AS "providerName",
      resume_cursor_json AS "resumeCursor"
    FROM provider_session_runtime
  `;
  const threadRows = yield* sql<{
    threadId: string;
    projectId: string;
    title: string;
    worktreePath: string | null;
    deletedAt: string | null;
  }>`
    SELECT thread_id AS "threadId", project_id AS "projectId", title,
      worktree_path AS "worktreePath", deleted_at AS "deletedAt"
    FROM projection_threads
  `;
  const projectRows = yield* sql<{ projectId: string; title: string; workspaceRoot: string }>`
    SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
  `;
  const sessionThreads = new Map<string, string>();
  for (const row of cursors) {
    const provider = DRIVER_USAGE_KIND[row.providerName];
    const sessionId = provider ? resumeCursorSessionId(provider, row.resumeCursor) : null;
    if (provider && sessionId) sessionThreads.set(`${provider}:${sessionId}`, row.threadId);
  }
  return {
    sessionThreads,
    threads: new Map(
      threadRows.map((row) => [
        row.threadId,
        {
          projectId: row.projectId,
          title: row.title,
          worktreePath: row.worktreePath,
          deleted: row.deletedAt !== null,
        },
      ]),
    ),
    projects: new Map(
      projectRows.map((row) => [
        row.projectId,
        { title: row.title, workspaceRoot: row.workspaceRoot },
      ]),
    ),
  } satisfies UsageThreadDirectory;
});

// Windows paths may arrive with either separator, a \\?\ prefix, or a different
// drive-letter case, depending on which tool recorded them.
function comparablePath(path: string): string {
  const slashed = path
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
}

function within(path: string, root: string): boolean {
  const base = comparablePath(root);
  const target = comparablePath(path);
  return base.length > 0 && (target === base || target.startsWith(`${base}/`));
}

/** Names each scanned session by its thread and project, falling back to its working directory. */
export function attributeSessions(
  provider: UsageProviderKind,
  sessions: readonly UsageSessionScanEntry[],
  directory: UsageThreadDirectory,
): UsageBreakdownSession[] {
  // Worktrees that exactly one live thread uses, so a cwd match is unambiguous.
  const worktreeThreads = new Map<string, string | null>();
  for (const [threadId, thread] of directory.threads) {
    if (thread.deleted || !thread.worktreePath) continue;
    const key = thread.worktreePath.replace(/\/+$/, "");
    worktreeThreads.set(key, worktreeThreads.has(key) ? null : threadId);
  }
  const projectFor = (cwd: string) => {
    let best: { id: string; length: number } | null = null;
    for (const [id, project] of directory.projects) {
      if (
        within(cwd, project.workspaceRoot) &&
        project.workspaceRoot.length > (best?.length ?? -1)
      ) {
        best = { id, length: project.workspaceRoot.length };
      }
    }
    return best?.id ?? null;
  };
  const threadForCwd = (cwd: string) => {
    for (const [worktree, threadId] of worktreeThreads) {
      if (threadId && within(cwd, worktree)) return threadId;
    }
    return null;
  };

  return sessions.map((session) => {
    const threadId =
      directory.sessionThreads.get(`${provider}:${session.sessionId}`) ??
      (session.cwd ? threadForCwd(session.cwd) : null);
    const thread = threadId ? directory.threads.get(threadId) : undefined;
    const projectId =
      thread?.projectId ?? (session.cwd ? projectFor(session.cwd) : null) ?? undefined;
    const project = projectId ? directory.projects.get(projectId) : undefined;
    const title = thread?.title.trim() || session.title;
    return {
      provider,
      sessionId: session.sessionId,
      ...(threadId && thread && !thread.deleted ? { threadId } : {}),
      ...(title ? { title } : {}),
      ...(projectId && project ? { projectId, projectTitle: project.title } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.origin ? { origin: session.origin } : {}),
      costUsd: session.costUsd,
      totals: session.totals,
      records: session.records,
      models: session.models.map((model) => ({ ...model })),
      hours: session.hours.map((hour) => ({
        hourStart: DateTime.formatIso(DateTime.makeUnsafe(hour.hourStartMs)),
        costUsd: hour.costUsd,
        records: hour.records,
      })),
    };
  });
}

const EMPTY_DIRECTORY: UsageThreadDirectory = {
  sessionThreads: new Map(),
  threads: new Map(),
  projects: new Map(),
};

/** Per-session usage for one provider window, named by thread and project. */
export const readUsageBreakdown = Effect.fn("usage.readUsageBreakdown")(function* (
  input: UsageBreakdownInput,
) {
  const usage = yield* UsageService;
  const scan = yield* usage.readSessions(input);
  // Unnamed sessions are still worth showing; a read failure only costs the names.
  const directory = yield* loadThreadDirectory().pipe(
    Effect.tapCause((cause) => Effect.logWarning("Usage breakdown could not read threads", cause)),
    Effect.orElseSucceed(() => EMPTY_DIRECTORY),
  );
  return {
    readAt: scan.readAt,
    provider: input.provider,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
    sessions: attributeSessions(input.provider, scan.sessions, directory),
  } satisfies UsageBreakdown;
});
