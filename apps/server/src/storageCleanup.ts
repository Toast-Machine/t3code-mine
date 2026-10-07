import type {
  OrchestrationThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ThreadDeletionReactor from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { threadHasQueuedTurnStart } from "./orchestration/ThreadSettlementPolicy.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const DAY_MS = 86_400_000;
/** Ignored paths inside directories that installs, builds, and tools regenerate, at any depth. */
const REBUILDABLE_IGNORED_PATH =
  /(^|\/)(node_modules|\.husky\/_|dist|\.astro|\.build|\.preview|supabase\/\.temp|tests\/browser\/\.artifacts)\//;
const MAX_COMPARED_FILE_BYTES = 8 * 1024 * 1024;
// Worktrees with more unique data than this are kept rather than backed up.
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const MAX_SCANNED_ENTRIES = 10_000;
const BACKUP_RETENTION_DAYS = 30;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

/** Live sessions keep their cwd even when no turn is currently running. */
function storageCleanupThreadIdle(thread: OrchestrationThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    (thread.session === null || thread.session.status === "stopped") &&
    thread.latestTurn?.state !== "running" &&
    thread.backgroundLiveness == null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !threadHasQueuedTurnStart(thread, DateTime.formatIso(DateTime.makeUnsafe(now)))
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
function storageCleanupActivityAt(thread: OrchestrationThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ].flatMap((value) => (value == null ? [] : [Date.parse(value)])),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletion = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderService.ProviderService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreeBackupsDir = path.join(path.dirname(config.worktreesDir), "worktree-backups");
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* snapshots.getShellSnapshot();
    const archived = yield* snapshots.getArchivedShellSnapshot();
    return { projects: active.projects, threads: [...active.threads, ...archived.threads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath = yield* fs
        .realPath(projectPath)
        .pipe(Effect.orElseSucceed(() => projectPath));
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const isSymlink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // True when the worktree file is a byte-identical copy of the main checkout's
  // file at the same relative path, such as an env file copied in at setup.
  const sameAsMainCheckout = Effect.fn("StorageCleanup.sameAsMainCheckout")(
    function* (worktreePath: string, workspaceRoot: string, relative: string) {
      const copy = path.join(worktreePath, relative);
      const original = path.join(workspaceRoot, relative);
      // An original that resolves into this worktree would be removed with it.
      const originalReal = yield* fs.realPath(original);
      if (originalReal === worktreePath || inside(worktreePath, originalReal)) return false;
      const [copyInfo, originalInfo] = yield* Effect.all([fs.stat(copy), fs.stat(original)]);
      if (
        copyInfo.type !== "File" ||
        originalInfo.type !== "File" ||
        copyInfo.size !== originalInfo.size ||
        Number(copyInfo.size) > MAX_COMPARED_FILE_BYTES
      )
        return false;
      const [copyBytes, originalBytes] = yield* Effect.all([
        fs.readFile(copy),
        fs.readFile(original),
      ]);
      return Buffer.from(copyBytes).equals(originalBytes);
    },
    Effect.orElseSucceed(() => false),
  );

  /**
   * Files that would exist nowhere else once the worktree is removed: uncommitted
   * and untracked files plus ignored files, minus rebuildable paths and identical
   * copies of the main checkout. Null when there is too much to back up.
   */
  const uniqueFiles = Effect.fn("StorageCleanup.uniqueFiles")(function* (
    worktreePath: string,
    workspaceRoot: string,
  ) {
    const listGit = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({ operation, cwd: worktreePath, args, maxOutputBytes: 1024 * 1024 });
    const ignored = yield* listGit("StorageCleanup.ignoredFiles", [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const changed = yield* listGit("StorageCleanup.changedFiles", [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]);
    if (ignored.stdoutTruncated || changed.stdoutTruncated) return null;
    const entries: string[] = [];
    for (const entry of ignored.stdout.split("\0")) {
      if (entry === "" || REBUILDABLE_IGNORED_PATH.test(entry)) continue;
      // A symlinked node_modules is listed without a trailing slash.
      if (/(^|\/)node_modules$/.test(entry) && (yield* isSymlink(path.join(worktreePath, entry))))
        continue;
      entries.push(entry);
    }
    // Porcelain -z records are "XY path"; renames and copies add the source path.
    const records = changed.stdout.split("\0");
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.length < 4) continue;
      if (/[RC]/.test(record.slice(0, 2))) index++;
      entries.push(record.slice(3));
    }
    const root = path.resolve(workspaceRoot);
    const files: string[] = [];
    let scanned = 0;
    let bytes = 0;
    const visit = Effect.fn("StorageCleanup.visitUniqueFile")(function* (
      relative: string,
    ): Effect.fn.Return<boolean, PlatformError> {
      if (++scanned > MAX_SCANNED_ENTRIES) return false;
      const target = path.join(worktreePath, relative);
      // Deleted tracked files are still in Git; removing a symlink loses nothing.
      if (!(yield* fs.exists(target)) || (yield* isSymlink(target))) return true;
      const info = yield* fs.stat(target);
      if (info.type === "Directory") {
        if (REBUILDABLE_IGNORED_PATH.test(`${relative}/`)) return true;
        for (const child of yield* fs.readDirectory(target))
          if (!(yield* visit(path.join(relative, child)))) return false;
        return true;
      }
      if (yield* sameAsMainCheckout(worktreePath, root, relative)) return true;
      bytes += Number(info.size);
      files.push(relative);
      return bytes <= MAX_BACKUP_BYTES;
    });
    for (const entry of new Set(entries)) if (!(yield* visit(entry))) return null;
    return files;
  });

  // Copies files into a dated folder under worktree-backups, mirroring their
  // place in the worktree, so they can be restored by hand.
  const backUp = Effect.fn("StorageCleanup.backUp")(function* (
    worktreePath: string,
    relativeWorktree: string,
    files: ReadonlyArray<string>,
    now: number,
  ) {
    const stamp = DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 16).replace(/[:T]/g, "-");
    const destination = path.join(worktreeBackupsDir, `${relativeWorktree}-${stamp}`);
    for (const file of files) {
      const target = path.join(destination, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copyFile(path.join(worktreePath, file), target);
    }
    return destination;
  });

  const cleanBackups = Effect.fn("StorageCleanup.cleanBackups")(function* (now: number) {
    if (!(yield* fs.exists(worktreeBackupsDir))) return;
    const realRoot = yield* fs.realPath(worktreeBackupsDir);
    if (realRoot !== path.resolve(worktreeBackupsDir)) return;
    for (const project of yield* fs.readDirectory(realRoot)) {
      const projectDir = path.join(realRoot, project);
      if ((yield* fs.realPath(projectDir)) !== projectDir) continue;
      if ((yield* fs.stat(projectDir)).type !== "Directory") continue;
      for (const backup of yield* fs.readDirectory(projectDir)) {
        const target = path.join(projectDir, backup);
        if ((yield* fs.realPath(target)) !== target) continue;
        const modified = Option.getOrNull((yield* fs.stat(target)).mtime);
        if (modified !== null && modified.getTime() < now - BACKUP_RETENTION_DAYS * DAY_MS)
          yield* fs.remove(target, { recursive: true });
      }
    }
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    if (!(yield* fs.exists(config.worktreesDir))) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedThreads = hasDeleteRule
      ? (yield* snapshots.getDeletedWorktreeThreads()).filter(
          (thread) => resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
        )
      : [];
    if (deletedThreads.length > 0) {
      // Read tombstones before taking this fence. A later deletion waits for the
      // next sweep; every captured deletion must finish stopping its resources.
      const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
      yield* threadDeletion.drainThrough(snapshotSequence);
    }
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "deletedAt" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        hasTerminal(worktreePath)
      )
        continue;
      yield* Effect.gen(function* () {
        if (!inside(root, worktreePath) || !(yield* fs.exists(worktreePath))) return;
        if ((yield* fs.realPath(worktreePath)) !== worktreePath) return;
        if (yield* containsProjectRoot(worktreePath, [project, ...snapshot.projects])) return;
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== thread.branch) return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return;
          // "Unchanged" means no work happened here, so uncommitted edits disqualify it.
          eligible = settings.worktreeUnchanged && !status.hasWorkingTreeChanges;
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = pullRequest?.state === "merged";
          }
        }
        if (!eligible) return;
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing this path cancels the removal.
        const latestSnapshot = yield* readThreads();
        if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects])) return;
        const latest = latestSnapshot.threads.filter(
          (entry) =>
            entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
        );
        if (hasTerminal(worktreePath)) return;
        if (deleted) {
          if (
            latest.length > 0 ||
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // A failed session stop is logged by the deletion reactor. Its drain
          // alone is not proof that a provider released this checkout.
          if (
            (yield* providers.listSessions()).some(
              (session) =>
                session.status !== "closed" &&
                (session.threadId === thread.id ||
                  (session.cwd !== undefined &&
                    (path.resolve(session.cwd) === worktreePath ||
                      inside(worktreePath, path.resolve(session.cwd))))),
            )
          )
            return;
        } else if (
          latest.length !== 1 ||
          latest[0]!.id !== thread.id ||
          !storageCleanupThreadIdle(latest[0]!, now) ||
          storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
        )
          return;
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.branch !== thread.branch ||
          finalStatus.hasWorkingTreeChanges !== status.hasWorkingTreeChanges
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        const files = yield* uniqueFiles(worktreePath, project.workspaceRoot);
        if (files === null) return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        // Nothing unique is lost: commits stay on the branch, and every file Git
        // does not hold is backed up first. A failed backup aborts the removal.
        const backup =
          files.length > 0
            ? yield* backUp(worktreePath, path.relative(root, worktreePath), files, now)
            : null;
        // Git refuses to remove a worktree with uncommitted changes unless forced.
        yield* git.removeWorktree({
          cwd: project.workspaceRoot,
          path: worktreePath,
          force: finalStatus.hasWorkingTreeChanges,
        });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderCommandReactor recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id, backup });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
    yield* cleanBackups(now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree backup cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = yield* engine.subscribeDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        event.type === "thread.deleted" &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies StorageCleanup["Service"];
});

export const layer = Layer.effect(StorageCleanup, make);
