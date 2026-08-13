import { useEffect } from "react";

/**
 * A one-line channel for reporting a message UPWARD to the app's notice strip,
 * from a component too deep to hold the state itself.
 *
 * The mirror image of composerPrefs: that one publishes a value down from App,
 * this one carries a message back up. It exists for the same reason — a
 * transcript link sits behind Workbench → Panel → Transcript → Markdown, and
 * threading a callback through four layers that have no other use for it is
 * worse than a channel.
 *
 * It is here so a failure can be SEEN. A clicked file link that cannot be
 * opened must say why; without somewhere to say it, the only options were a
 * silent no-op or a console line nobody reads.
 */
type NoticeSink = (message: string) => void;

const sinks = new Set<NoticeSink>();

/** Shows a message in the app's notice strip. Safe to call from anywhere. */
export function reportNotice(message: string): void {
  const text = String(message || "").trim();
  if (!text) {
    return;
  }
  for (const sink of sinks) {
    sink(text);
  }
}

/** Registers the display. Call once, from whoever owns the notice state. */
export function useNoticeSink(sink: NoticeSink): void {
  useEffect(() => {
    sinks.add(sink);
    return () => { sinks.delete(sink); };
  }, [sink]);
}
