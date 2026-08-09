/**
 * Recorded approval scenarios — GENERATED, DO NOT EDIT BY HAND.
 *
 * Produced by scripts/build-approval-scenarios.mjs from the real traffic in
 * scripts/fixtures/approvals/*.jsonl (codex-cli 0.145.0 + gpt-5.4-mini,
 * claude-haiku-4-5). Injecting one of these drives the approval card through the
 * SAME mapping a live harness does (src/shared/approvalRequest.ts), so the UI can
 * be designed, demoed and QA'd without paying for a model turn each time.
 *
 * Every value here was sent by a real harness. Nothing is authored.
 * Re-record with scripts/record-approval-traffic.mjs, then re-run the generator.
 */

/** A recorded server request, tagged with the harness that sent it. */
export type ApprovalScenario =
  | { harness: "codex"; method: string; params: Record<string, unknown>; changes?: unknown[] }
  | { harness: "claude-code"; toolName: string; input: unknown; options: Record<string, unknown> };

export const APPROVAL_SCENARIOS: Record<string, ApprovalScenario> = {
  "claude-bash-deny": {
    "harness": "claude-code",
    "toolName": "Bash",
    "input": {
      "command": "echo two > b18b.txt",
      "description": "Create file b18b.txt with contents \"two\""
    },
    "options": {
      "suggestions": [
        {
          "type": "addRules",
          "rules": [
            {
              "toolName": "Bash",
              "ruleContent": "echo two *"
            }
          ],
          "behavior": "allow",
          "destination": "localSettings"
        },
        {
          "type": "addDirectories",
          "directories": [
            "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-claude-ws"
          ],
          "destination": "session"
        }
      ],
      "blockedPath": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-claude-ws\\b18b.txt",
      "displayName": "Bash",
      "description": "Create file b18b.txt with contents \"two\"",
      "toolUseID": "toolu_01KhQy4cjJLM9f7VBjghCi1i"
    }
  },
  "claude-bash": {
    "harness": "claude-code",
    "toolName": "Bash",
    "input": {
      "command": "echo one > b18a.txt",
      "description": "Write \"one\" to file b18a.txt"
    },
    "options": {
      "suggestions": [
        {
          "type": "addRules",
          "rules": [
            {
              "toolName": "Bash",
              "ruleContent": "echo one *"
            }
          ],
          "behavior": "allow",
          "destination": "localSettings"
        },
        {
          "type": "addDirectories",
          "directories": [
            "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-claude-ws"
          ],
          "destination": "session"
        }
      ],
      "blockedPath": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-claude-ws\\b18a.txt",
      "displayName": "Bash",
      "description": "Write \"one\" to file b18a.txt",
      "toolUseID": "toolu_01V7QbDjNS67nMErTcBDQhTS"
    }
  },
  "claude-file-edit": {
    "harness": "claude-code",
    "toolName": "Edit",
    "input": {
      "file_path": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-claude-ws\\seed.txt",
      "old_string": "seed changed",
      "new_string": "sprout changed",
      "replace_all": false
    },
    "options": {
      "suggestions": [
        {
          "type": "setMode",
          "mode": "acceptEdits",
          "destination": "session"
        }
      ],
      "displayName": "Edit",
      "description": "seed.txt",
      "toolUseID": "toolu_01TJeQJqb1ed8Dadn3xuYhXz"
    }
  },
  "claude-file-write": {
    "harness": "claude-code",
    "toolName": "Write",
    "input": {
      "file_path": "\\b18.txt",
      "content": "hi"
    },
    "options": {
      "suggestions": [
        {
          "type": "setMode",
          "mode": "acceptEdits",
          "destination": "session"
        },
        {
          "type": "addDirectories",
          "directories": [
            "\\",
            "C:\\"
          ],
          "destination": "session"
        }
      ],
      "decisionReason": "Path is outside allowed working directories",
      "displayName": "Write",
      "description": "\\b18.txt",
      "toolUseID": "toolu_01QAk9Bvukchr3ovAeEQhRrj"
    }
  },
  "claude-write-outside-cwd": {
    "harness": "claude-code",
    "toolName": "Write",
    "input": {
      "file_path": "\\tmp\\agentparty-b18-claude-ws\\b18.txt",
      "content": "hi"
    },
    "options": {
      "suggestions": [
        {
          "type": "setMode",
          "mode": "acceptEdits",
          "destination": "session"
        },
        {
          "type": "addDirectories",
          "directories": [
            "\\tmp\\agentparty-b18-claude-ws",
            "C:\\tmp\\agentparty-b18-claude-ws"
          ],
          "destination": "session"
        }
      ],
      "decisionReason": "Path is outside allowed working directories",
      "displayName": "Write",
      "description": "\\tmp\\agentparty-b18-claude-ws\\b18.txt",
      "toolUseID": "toolu_013EtRhAeawtxLD4w4KtwzaS"
    }
  },
  "codex-command-always": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1c3-d3e7-7802-bf00-e25cedb29ba5",
      "turnId": "019fe1c3-e853-72f2-a63c-be17e804ebab",
      "itemId": "call_vXD7fGKnqeZHHCLYNqCisFzx",
      "startedAtMs": 1786199156428,
      "environmentId": "local",
      "reason": "Do you want to allow me to run the exact command `echo three > b18c.txt` so it can write the requested file in this read-only workspace?",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo three > b18c.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo three > b18c.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo three > b18c.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo three > b18c.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-command-decline": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1c4-9ae5-7a52-9545-5f70042f39f6",
      "turnId": "019fe1c4-af56-7b03-b99f-ccc179bd8e41",
      "itemId": "call_TEWIqUO7atGT3NtJdTLOJlDv",
      "startedAtMs": 1786199208849,
      "environmentId": "local",
      "reason": "Do you want me to allow this exact command to write `b18d.txt` in the workspace?",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo four > b18d.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo four > b18d.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo four > b18d.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo four > b18d.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-command-once-stringid-hang": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1bf-f79c-78c1-8322-112b584a9055",
      "turnId": "019fe1c0-0cd3-7870-a5f5-9f2a49789259",
      "itemId": "call_cSdsWj7uFdpgRSWliO4vjsE9",
      "startedAtMs": 1786198903039,
      "environmentId": "local",
      "reason": "Do you want me to create the requested file `b18a.txt` by running the exact command in the workspace?",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo one > b18a.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo one > b18a.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo one > b18a.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo one > b18a.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-command-once": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1bf-2dab-7ae1-bf9f-dbf7f8d336f4",
      "turnId": "019fe1bf-4239-7190-bbd2-9abbd087f616",
      "itemId": "call_fCpnSGODNgPf12mcs8C8VdSM",
      "startedAtMs": 1786198851000,
      "environmentId": "local",
      "reason": "Do you want me to run the exact command you requested? It writes `b18a.txt`, which requires permission outside the read-only sandbox.",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo one > b18a.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo one > b18a.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo one > b18a.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo one > b18a.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-command-session": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1c3-36bd-7f23-ae2e-36ec840283ef",
      "turnId": "019fe1c3-4b1c-7170-af77-82cc41476fb8",
      "itemId": "call_N05WjUJf1dlGv69Ps6CSAzP5",
      "startedAtMs": 1786199117569,
      "environmentId": "local",
      "reason": "Do you want to allow this exact command to create `b18b.txt` in the workspace?",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo two > b18b.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo two > b18b.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo two > b18b.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo two > b18b.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-file-change": {
    "harness": "codex",
    "method": "item/fileChange/requestApproval",
    "params": {
      "threadId": "019fe73c-82bc-7b93-8ef8-e2f78588846b",
      "turnId": "019fe73c-972d-7ac3-84ba-b5837ed09705",
      "itemId": "exec-23ad6734-6974-4565-9918-22bb0f6c464f",
      "startedAtMs": 1786290957769,
      "reason": null,
      "grantRoot": null
    },
    "changes": [
      {
        "path": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws\\seed.txt",
        "kind": {
          "type": "add"
        },
        "diff": "sprout\n"
      }
    ]
  },
  "codex-file-write": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1c5-303a-73e1-b28b-217a1deda79d",
      "turnId": "019fe1c5-448e-74c2-9969-831578d4374c",
      "itemId": "call_zwbuVOcPLegmvBDWmhZ6sCAe",
      "startedAtMs": 1786199247487,
      "environmentId": "local",
      "reason": "Do you want me to create the requested file `b18.txt` in the workspace?",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Set-Content -LiteralPath 'b18.txt' -Value 'hi' -NoNewline\"",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "Set-Content -LiteralPath 'b18.txt' -Value 'hi' -NoNewline"
        }
      ],
      "proposedExecpolicyAmendment": [
        "Set-Content",
        "-LiteralPath",
        "b18.txt",
        "-Value",
        "hi",
        "-NoNewline"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "Set-Content",
              "-LiteralPath",
              "b18.txt",
              "-Value",
              "hi",
              "-NoNewline"
            ]
          }
        },
        "cancel"
      ]
    }
  },
  "codex-untrusted-no-reason": {
    "harness": "codex",
    "method": "item/commandExecution/requestApproval",
    "params": {
      "threadId": "019fe1ca-138d-7be1-8386-320a161ebdf5",
      "turnId": "019fe1ca-27fc-7262-b95e-3d55b8d6c6bd",
      "itemId": "call_9bkYj62usrXmnvjLfoUz3qBd",
      "startedAtMs": 1786199571620,
      "environmentId": "local",
      "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo five > b18e.txt'",
      "cwd": "C:\\Users\\Dev\\AppData\\Local\\Temp\\agentparty-b18-codex-ws",
      "commandActions": [
        {
          "type": "unknown",
          "command": "echo five > b18e.txt"
        }
      ],
      "proposedExecpolicyAmendment": [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-Command",
        "echo five > b18e.txt"
      ],
      "availableDecisions": [
        "accept",
        {
          "acceptWithExecpolicyAmendment": {
            "execpolicy_amendment": [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "echo five > b18e.txt"
            ]
          }
        },
        "cancel"
      ]
    }
  }
};

export function approvalScenarioNames(): string[] {
  return Object.keys(APPROVAL_SCENARIOS);
}
