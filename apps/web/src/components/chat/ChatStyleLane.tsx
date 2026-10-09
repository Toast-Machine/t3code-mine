// Personal build: chat-style timeline pieces.
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/** Typing dots for a running turn. The steps() timing keeps them to a handful
 *  of repaints per cycle, and they pause when off screen. */
export function TypingDots() {
  return (
    <span ref={observeVisibleAnimation} className="flex shrink-0 items-center gap-1" aria-hidden>
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
    </span>
  );
}
