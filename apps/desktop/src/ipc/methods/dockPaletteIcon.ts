// @effect-diagnostics nodeBuiltinImport:off - small synchronous lookup inside an IPC handler.
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
        }),
    }),
  );
});
