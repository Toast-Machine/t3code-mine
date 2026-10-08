import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useMemo } from "react";

import { useBackgroundGraceVersion, withBackgroundGrace } from "./backgroundGrace";
import { useThreadShells } from "./state/entities";

/** Every thread shell, with background grace applied. */
export function useThreadShellsWithGrace(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useThreadShells();
  const graceVersion = useBackgroundGraceVersion();
  return useMemo(() => {
    void graceVersion;
    return threads.map((thread) =>
      withBackgroundGrace(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread),
    );
  }, [threads, graceVersion]);
}
