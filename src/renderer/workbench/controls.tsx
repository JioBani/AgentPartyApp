import { BellOff, ClipboardList, FileCheck, Shield, ShieldOff, Sparkles, TerminalSquare, Zap } from "lucide-react";
import type { DropdownOption } from "./Dropdown";

/** Permission modes with an intuitive icon + one-line hint per option. */
export const PERMISSION_OPTIONS: DropdownOption[] = [
  { id: "default", label: "Default", hint: "민감한 작업마다 확인", icon: <Shield size={14} /> },
  { id: "acceptEdits", label: "Accept edits", hint: "파일 편집 자동 승인", icon: <FileCheck size={14} /> },
  { id: "plan", label: "Plan", hint: "실행 전 계획만", icon: <ClipboardList size={14} /> },
  { id: "auto", label: "Auto", hint: "대부분 자동 진행", icon: <Zap size={14} /> },
  { id: "dontAsk", label: "Don't ask", hint: "추가 질문 없이 진행", icon: <BellOff size={14} /> },
  { id: "bypassPermissions", label: "Bypass", hint: "모든 권한 우회", icon: <ShieldOff size={14} /> },
];

/** Harness runtimes with an icon per option. */
export const RUNTIME_OPTIONS: DropdownOption[] = [
  { id: "claude-code", label: "Claude Code", icon: <Sparkles size={14} /> },
  { id: "codex", label: "Codex", icon: <TerminalSquare size={14} /> },
];
