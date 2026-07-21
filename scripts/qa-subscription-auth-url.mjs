/*
 * Subscription OAuth URL surfacing.
 *
 * The bridge's login command opens the SYSTEM DEFAULT browser itself. When the
 * user's provider account lives in a different browser or profile, that flow can
 * never complete and Authentication sits at "인증 대기 중" with nothing to click.
 * The URL is printed on the login command's stdout, so it is extracted and shown
 * for copying. This locks the extraction, which is the fragile part: it must find
 * a real authorization endpoint and must NOT offer a docs/callback link instead.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const r = await build({
  entryPoints: [path.join(projectRoot, "src/main/subscriptionProxyService.ts")],
  bundle: true, format: "cjs", platform: "node", write: false, external: ["electron"],
});
// CJS: the module graph pulls in packages that need a real `require`.
const file = path.join(outDir, "subscription-proxy.cjs");
writeFileSync(file, r.outputFiles[0].text);
const { authUrlFromLoginOutput, loginOutputProvesCredentialSaved } = createRequire(import.meta.url)(file);

const CLAUDE = "https://claude.ai/oauth/authorize?code=true&client_id=abc123&response_type=code&code_challenge=xyz&state=s1";
const CODEX = "https://auth.openai.com/oauth/authorize?client_id=app_1&response_type=code&code_challenge=q";

console.log("\nauth URL extraction:");

assert(authUrlFromLoginOutput(`Please open the following URL:\n${CLAUDE}\n`) === CLAUDE, "finds a Claude authorize URL in prose");
assert(authUrlFromLoginOutput(`Opening browser...\n  ${CODEX}\nWaiting.`) === CODEX, "finds a Codex authorize URL in prose");
assert(authUrlFromLoginOutput("") === undefined, "empty output yields no URL");
assert(authUrlFromLoginOutput("Authentication successful!") === undefined, "output with no URL yields none");

// A docs or callback link must never be offered as the thing to click.
assert(
  authUrlFromLoginOutput("See https://docs.example.com/oauth/setup for help.") === undefined,
  "a docs link that merely contains /oauth is not treated as the auth URL",
);
assert(
  authUrlFromLoginOutput("Listening on https://localhost:8317/callback for the redirect.") === undefined,
  "the local callback URL is not offered as the auth URL",
);
assert(
  authUrlFromLoginOutput(`Docs: https://docs.example.com/oauth\nOpen: ${CLAUDE}`) === CLAUDE,
  "the real authorize URL wins over a docs link in the same output",
);

// A reprinted/retried flow must surface the CURRENT attempt, not the first.
const second = CLAUDE.replace("state=s1", "state=s2");
assert(authUrlFromLoginOutput(`${CLAUDE}\nretrying\n${second}`) === second, "a reprinted URL surfaces the newest attempt");

// Trailing punctuation from surrounding prose must not corrupt the link.
assert(authUrlFromLoginOutput(`Open ${CODEX}.`) === CODEX, "trailing sentence punctuation is trimmed");
assert(authUrlFromLoginOutput(`Open (${CODEX})`) === CODEX, "a trailing bracket is trimmed");

// The success detector must stay independent of URL extraction.
console.log("\ncredential-saved detection (unchanged):");
assert(loginOutputProvesCredentialSaved("Authentication successful!\nAuthentication saved to /home/u/.cliproxy") === true, "both markers → saved");
assert(loginOutputProvesCredentialSaved("Authentication successful!") === false, "success without a save path is NOT proof");
assert(loginOutputProvesCredentialSaved(CLAUDE) === false, "a bare URL is not proof of a saved credential");

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
