import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";

import { primaryServerConfigAtom } from "./state/server";

// Personal build: this app never installs upstream updates itself (it has no
// update feed). Instead it checks GitHub for a newer stable T3 Code release and
// offers to start an agent chat that moves the fork onto it (see FORK.md).

const LATEST_STABLE_RELEASE_URL = "https://api.github.com/repos/pingdotgg/t3code/releases/latest";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Folder name of the fork's checkout; the matching project gets the update chat. */
export const FORK_PROJECT_FOLDER = "T3 Code";

export interface ForkUpdate {
  readonly version: string;
  readonly url: string;
}

function parseVersion(version: string): ReadonlyArray<number> | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index]! !== now[index]!) return next[index]! > now[index]!;
  }
  return false;
}

export interface ForkUpdateState {
  readonly checking: boolean;
  /** Newest stable upstream release when it is newer than this build. */
  readonly update: ForkUpdate | null;
  /** Set after a check completes, so the UI can say "up to date". */
  readonly checkedAt: number | null;
}

let state: ForkUpdateState = { checking: false, update: null, checkedAt: null };
const listeners = new Set<() => void>();
function setState(next: Partial<ForkUpdateState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Checks GitHub now. Safe to call repeatedly; overlapping checks are skipped. */
export async function checkForForkUpdate(currentVersion: string): Promise<void> {
  if (state.checking) return;
  setState({ checking: true });
  try {
    const response = await fetch(LATEST_STABLE_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return;
    const release = (await response.json()) as { tag_name?: string; html_url?: string };
    const version = release.tag_name?.replace(/^v/, "");
    if (!version) return;
    setState({
      update: isNewerVersion(version, currentVersion)
        ? { version, url: release.html_url ?? LATEST_STABLE_RELEASE_URL }
        : null,
      checkedAt: Date.now(),
    });
  } catch {
    // Offline or rate limited: the next check tries again.
  } finally {
    setState({ checking: false });
  }
}

/** Update state, checked at startup and every few hours while mounted. */
export function useForkUpdate(): ForkUpdateState & { readonly currentVersion: string | null } {
  const currentVersion = useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  useEffect(() => {
    if (currentVersion === null) return;
    void checkForForkUpdate(currentVersion);
    const interval = window.setInterval(
      () => void checkForForkUpdate(currentVersion),
      CHECK_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [currentVersion]);
  return { ...snapshot, currentVersion };
}

/** Instructions pasted into the update chat; the maintainer reviews them before sending. */
export function forkUpdatePrompt(update: ForkUpdate, currentVersion: string): string {
  return `T3 Code v${update.version} is out (release notes: ${update.url}). This checkout is my personal fork, currently based on v${currentVersion}. Please update it to v${update.version}.

Start by reading FORK.md in this repo: it explains how the fork works and the build, install, and update steps.

What I want:
- Get everything upstream added and fixed in v${update.version}: all of their improvements and new features.
- Keep every change we made in this fork. That's not only the UI and design; some changes are features and behavior too.
- When there's a conflict, resolve it so both survive: keep their improvement and re-apply our change on top of it.
- If it's a real design conflict, where we built something one way and they redesigned the same thing another way, don't pick for me. Stop and ask me which to keep. Show me screenshots of their version and ours side by side so I can decide.

When it's done and checked, build the Mac app and tell me when to quit the app so the update installs.`;
}
