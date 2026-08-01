import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

/**
 * Clipboard access for the workbench. `navigator.clipboard` rejects when the
 * document is not focused or the platform refuses, so the result is reported
 * back instead of swallowed — a copy button must never claim a copy that did
 * not happen (AGENTS.md: no silent fallback).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type CopyState = "idle" | "copied" | "failed";

/**
 * A small copy-to-clipboard control used across the transcript (code blocks,
 * whole replies, link targets). It confirms with a check mark for a moment and
 * shows an explicit failure mark when the clipboard write was refused.
 */
export function CopyButton({ text, title = "복사", label, className = "" }: { text: string; title?: string; label?: string; className?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    void copyText(text).then((ok) => {
      setState(ok ? "copied" : "failed");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1400);
    });
  };

  const hint = state === "copied" ? "복사됨" : state === "failed" ? "복사 실패 — 클립보드 접근이 거부되었습니다" : title;
  return (
    <button
      type="button"
      className={"wb-copy-btn is-" + state + (className ? " " + className : "")}
      title={hint}
      aria-label={hint}
      data-copy-state={state}
      onClick={onClick}
    >
      {state === "copied" ? <Check size={12} /> : state === "failed" ? <X size={12} /> : <Copy size={12} />}
      {label && <span className="wb-copy-btn-label">{label}</span>}
    </button>
  );
}
