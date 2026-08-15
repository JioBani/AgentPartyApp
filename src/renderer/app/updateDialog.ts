import { useEffect } from "react";

/**
 * A one-line channel for asking the app to open the update dialog, from a
 * component too deep to hold that state.
 *
 * Same shape and same reason as app/appNotice.ts: the settings 진단 tab sits
 * behind RuntimeSettingsView → tab panel → card, and threading a callback
 * through three layers that have no other use for it is worse than a channel.
 *
 * It exists so the dialog stays reachable when the titlebar pill is hidden —
 * the pill only appears for a pending update, but "확인했는데 실패했다" and
 * "이 빌드는 자동 업데이트를 못 한다" also need somewhere to be read.
 */
type OpenSink = () => void;

const sinks = new Set<OpenSink>();

/** Opens the app-update dialog. Safe to call from anywhere. */
export function openUpdateDialog(): void {
  for (const sink of sinks) {
    sink();
  }
}

/** Registers the dialog owner. Call once, from whoever holds the open state. */
export function useUpdateDialogSink(sink: OpenSink): void {
  useEffect(() => {
    sinks.add(sink);
    return () => { sinks.delete(sink); };
  }, [sink]);
}
