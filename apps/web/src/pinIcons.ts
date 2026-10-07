import { useSyncExternalStore } from "react";

// Emoji icons for pinned threads (my-tweaks). Stored locally by thread key;
// they are personal decoration, so they are not synced to the server.
const STORAGE_KEY = "t3code:pin-icons";
const listeners = new Set<() => void>();
let cache: Readonly<Record<string, string>> | null = null;

function read(): Readonly<Record<string, string>> {
  if (cache !== null) return cache;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    cache = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function setPinIcon(threadKey: string, emoji: string | null): void {
  const next = { ...read() };
  if (emoji === null) delete next[threadKey];
  else next[threadKey] = emoji;
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory value for this session.
  }
  for (const listener of listeners) listener();
}

export function usePinIcon(threadKey: string): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read()[threadKey] ?? null,
    () => null,
  );
}

// Values are either "icon:<name>" (a line icon from PIN_LINE_ICONS) or an emoji.
export const PIN_EMOJI_CHOICES = [
  "📚",
  "🎨",
  "✉️",
  "🔀",
  "🚀",
  "🛠️",
  "🐛",
  "📈",
  "💡",
  "📝",
  "📸",
  "🎬",
  "🏠",
  "💬",
  "🧪",
  "🔒",
  "⚙️",
  "📦",
  "🌐",
  "📣",
  "🗂️",
  "🧭",
  "⭐",
  "🔥",
  "🌿",
  "🌸",
  "🍀",
  "🌊",
  "☀️",
  "🌙",
  "🍋",
  "🫐",
  "🧠",
  "🤖",
  "💳",
  "📅",
] as const;
