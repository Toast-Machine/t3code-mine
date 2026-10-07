// @effect-diagnostics nodeBuiltinImport:off - small synchronous lookup inside an IPC handler.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_DOCK_PALETTE_ICON_CHANNEL } from "../channels.ts";

// Personal build: the Dock icon follows the selected color palette. Icons are
// bundled as resources/palette-icons/<palette>.png; a palette without one
// falls back to the app's own icon.
const PaletteId = Schema.String.check(Schema.isPattern(/^[a-z]{1,32}$/));

export const installDockPaletteIcon = Effect.fn("desktop.ipc.installDockPaletteIcon")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcessPlatform;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_DOCK_PALETTE_ICON_CHANNEL,
      payload: PaletteId,
      result: Schema.Void,
      handler: (palette) =>
        Effect.sync(() => {
          if (platform !== "darwin" || !Electron.app.dock) return;
          // oxlint-disable-next-line t3code/no-global-process-runtime -- Electron resources path.
          const iconPath = NodePath.join(process.resourcesPath, "palette-icons", `${palette}.png`);
          // oxlint-disable-next-line t3code/no-global-process-runtime -- Electron resources path.
          const fallbackPath = NodePath.join(process.resourcesPath, "icon.icns");
          const path = NodeFS.existsSync(iconPath) ? iconPath : fallbackPath;
          const image = Electron.nativeImage.createFromPath(path);
          if (!image.isEmpty()) Electron.app.dock.setIcon(image);
          persistBundleIcon(path);
        }),
    }),
  );
});

// The Dock shows the app bundle's own icon while the app is closed, so the
// palette icon is also set as the bundle's custom Finder icon. Skipped when
// the same icon was already applied, so launches stay quick.
let lastBundleIcon: string | null = null;
function persistBundleIcon(iconPath: string): void {
  if (!Electron.app.isPackaged || lastBundleIcon === iconPath) return;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Electron executable path.
  const execPath = process.execPath;
  const appIndex = execPath.indexOf(".app/");
  if (appIndex === -1) return;
  const appPath = execPath.slice(0, appIndex + 4);
  const markerPath = NodePath.join(Electron.app.getPath("userData"), "mine-bundle-icon.txt");
  try {
    if (NodeFS.readFileSync(markerPath, "utf8") === iconPath) {
      lastBundleIcon = iconPath;
      return;
    }
  } catch {
    // No marker yet.
  }
  lastBundleIcon = iconPath;
  const script = `ObjC.import("AppKit");
const image = $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(iconPath)});
$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, ${JSON.stringify(appPath)}, 0);`;
  // setIcon reports false rather than throwing when macOS blocks the write
  // (Privacy & Security > App Management), so only a "true" marks it applied;
  // anything else retries on the next launch or palette change.
  NodeChildProcess.execFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    (error, stdout) => {
      if (error === null && stdout.trim() === "true") {
        NodeFS.writeFile(markerPath, iconPath, () => {});
      } else if (lastBundleIcon === iconPath) {
        lastBundleIcon = null;
      }
    },
  );
}
