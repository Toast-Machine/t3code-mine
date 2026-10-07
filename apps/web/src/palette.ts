import { useSyncExternalStore } from "react";

// Peaceful pastel palettes (my-tweaks). Each palette's colors live in
// index.css under :root[data-palette="..."]; this module only picks one.
export const PALETTES = [
  { id: "paper", label: "Paper", swatch: ["#e2dacb", "#34302b"] },
  { id: "lotus", label: "Lotus", swatch: ["#e9d0da", "#14625f"] },
  { id: "storm", label: "Storm", swatch: ["#cfdcd9", "#3d6a65"] },
  { id: "crocus", label: "Crocus", swatch: ["#d8d2ee", "#56499b"] },
  { id: "peony", label: "Peony", swatch: ["#eed4cd", "#6c7254"] },
  { id: "succulent", label: "Succulent", swatch: ["#cddfd2", "#1f4d3f"] },
  { id: "meadow", label: "Meadow", swatch: ["#eedfb7", "#8a5571"] },
  { id: "blueberry", label: "Blueberry", swatch: ["#1e3150", "#b9c8f2"] },
  { id: "forest", label: "Forest", swatch: ["#173a2f", "#a8dcb8"] },
  { id: "rosewood", label: "Rosewood", swatch: ["#6a3450", "#ffc1c6"] },
  { id: "plum", label: "Plum", swatch: ["#382356", "#d4c4f6"] },
  { id: "deepteal", label: "Deep Teal", swatch: ["#0f4746", "#a6e0cf"] },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];

const STORAGE_KEY = "t3code:palette";
const DEFAULT_PALETTE: PaletteId = "paper";
const listeners = new Set<() => void>();

function readPalette(): PaletteId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (PALETTES.some((palette) => palette.id === stored)) return stored as PaletteId;
  } catch {
    // Storage can be unavailable; fall back to the default.
  }
  return DEFAULT_PALETTE;
}

export function applyStoredPalette(): void {
  document.documentElement.dataset.palette = readPalette();
}

export function setPalette(id: PaletteId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Still apply it for this session.
  }
  document.documentElement.dataset.palette = id;
  for (const listener of listeners) listener();
}

export function usePalette(): PaletteId {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readPalette,
    () => DEFAULT_PALETTE,
  );
}
