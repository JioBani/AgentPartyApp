/**
 * Whether the user has at least one account that can actually run a turn.
 *
 * B-03: harness / CLI `available` means "the binary is there", not "signed in".
 * Claude·Codex·Cursor cards start as `available` for that reason. Treating that
 * as connected would open the guide for a logged-out user and fail on the first
 * question — the chicken-and-egg §8 exists to prevent.
 */
import type { AuthProviderState } from "./types";

export function hasConnectedAccount(auth: readonly AuthProviderState[]): boolean {
  return auth.some(accountIsConnected);
}

export function accountIsConnected(provider: AuthProviderState): boolean {
  if (provider.kind === "apiKey") {
    return provider.status === "configured" || provider.status === "valid";
  }
  if (provider.authenticated !== undefined) {
    return provider.authenticated;
  }
  if (provider.status === "configured" || provider.status === "valid") {
    return true;
  }
  if (provider.status !== "available") {
    return false;
  }
  // Remaining `available` is ambiguous. Only count it when a later overlay
  // left a positive login proof in `detail` (signed in / 로그인됨 / connected).
  // The stock Claude/Codex cards say "delegates … to the local CLI" — not a login.
  return /signed in|로그인됨|is connected|bridge is connected/i.test(provider.detail || "");
}
