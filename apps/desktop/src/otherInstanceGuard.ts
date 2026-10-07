// @effect-diagnostics nodeBuiltinImport:off - runs once at module load, before the Effect runtime.
import * as NodeChildProcess from "node:child_process";

import * as Electron from "electron";

// Personal build guard. This app shares ~/.t3 and its data folder with the
// official T3 Code app, and Electron skips its single-instance lock on macOS,
// so two copies could write the same chat database at once. If another T3
// Code app is already running, explain and quit before touching any data.
export function quitIfAnotherT3CodeIsRunning(): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before any Effect runtime.
  if (process.platform !== "darwin" || !Electron.app.isPackaged) return;
  const ownBundle = process.execPath.slice(0, process.execPath.indexOf(".app/") + 5);
  let processPaths: string[];
  try {
    processPaths = NodeChildProcess.execFileSync("/bin/ps", ["-axo", "comm="], {
      encoding: "utf8",
    }).split("\n");
  } catch {
    return;
  }
  const other = processPaths.find(
    (path) => path.includes(".app/Contents/MacOS/T3 Code") && !path.startsWith(ownBundle),
  );
  if (other === undefined) return;
  const otherName = other.slice(other.lastIndexOf("/") + 1);
  Electron.dialog.showErrorBox(
    "T3 Code is already open",
    `${otherName} is running and uses the same chats and settings. Quit it first, then open this app again.`,
  );
  Electron.app.exit(0);
}
