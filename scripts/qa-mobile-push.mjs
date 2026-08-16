/*
 * PushClient test (01 §7).
 *
 * The property that matters is end to end: what the desktop posts must be
 * something the PHONE can open and the RELAY can verify — while the relay
 * itself learns nothing (02 §T8). So the test plays both other roles with the
 * shared protocol package: it verifies the request signature the way the server
 * does, and opens the sealed box the way the phone's NSE does.
 *
 * The rest is failure behaviour. A push that silently fails to arrive is the
 * worst outcome in this system: someone is waiting on an approval that will
 * never appear, with nothing to explain the silence. Every failure path is
 * asserted to throw with a reason.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const outDir = qaTempDir();

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/mobile/pushClient.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@agentparty/protocol"],
  write: false,
});
const bundlePath = path.join(outDir, "pushClient.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { PushClient, pushEndpoint } = await import(pathToFileURL(bundlePath).href);
const P = await import("@agentparty/protocol");
await P.sodiumReady();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const throws = async (fn, match, msg) => {
  let message = "";
  try { await fn(); } catch (error) { message = String(error?.message ?? error); }
  assert(message.includes(match), `${msg} (got: ${message || "no throw"})`);
};

const desktop = P.identityFromSeeds(new Uint8Array(32).fill(61), new Uint8Array(32).fill(62));
const phone = P.identityFromSeeds(new Uint8Array(32).fill(63), new Uint8Array(32).fill(64));

const target = { deviceId: phone.deviceId, platform: "android", handle: "fcm-token-abc", kxPk: phone.kxPk };
const payload = {
  v: 1,
  type: "approval",
  deviceId: desktop.deviceId,
  requestId: "req-1",
  title: "명령 승인 요청",
  body: "rm -rf 를 실행하려 합니다",
  exp: 1_700_000_060_000,
};

function client({ post, pushUrl = "https://push.example" } = {}) {
  const posted = [];
  const instance = new PushClient({
    identity: desktop,
    pushUrl: () => pushUrl,
    log: () => {},
    post: async (url, body) => {
      posted.push({ url, body: JSON.parse(body) });
      return post ? post(url, body) : { status: 200, text: '{"ok":true}' };
    },
  });
  return { instance, posted };
}

console.log("PushClient assertions:");

// --- the relay verifies, the phone opens, neither role is guessed -----------
{
  const c = client();
  await c.instance.notify(target, payload);

  assert(c.posted.length === 1, "one request is posted");
  assert(c.posted[0].url === "https://push.example/v1/push", "it goes to the §7 endpoint");

  const body = c.posted[0].body;
  assert(P.PushRequestSchema.safeParse(body).success, "the body matches the shared PushRequest schema");
  assert(body.platform === "android" && body.handle === "fcm-token-abc", "platform and handle are carried");
  assert(body.sigPk === P.toB64(desktop.sigPk), "the desktop identifies itself with its signing key");

  // The relay's own check (02 §T8: it rate-limits per desktop without reading).
  const senderKey = P.verifyPushRequest(body);
  assert(P.toB64(senderKey) === P.toB64(desktop.sigPk), "the relay can verify who signed it");

  // The phone's NSE / background isolate.
  const opened = P.openPushPayload(P.fromB64(body.box), phone.kxPk, phone.kxSk);
  assert(opened.requestId === "req-1", "the phone opens the sealed payload");
  assert(opened.title === "명령 승인 요청" && opened.body === "rm -rf 를 실행하려 합니다", "non-ASCII text survives intact");
  assert(opened.deviceId === desktop.deviceId, "the payload names the desktop that sent it");
  assert(opened.exp === payload.exp, "the expiry is carried so the phone can stop showing a stale prompt");

  // What the relay cannot do.
  assert(!body.box.includes("승인"), "the notification text is not in the request in the clear");
  const wrongKey = P.identityFromSeeds(new Uint8Array(32).fill(71), new Uint8Array(32).fill(72));
  let openedByOther = true;
  try { P.openPushPayload(P.fromB64(body.box), wrongKey.kxPk, wrongKey.kxSk); }
  catch { openedByOther = false; }
  assert(!openedByOther, "and nobody but the target phone can open it");
}

// --- a tampered request stops verifying ------------------------------------
{
  const c = client();
  await c.instance.notify(target, payload);
  const body = c.posted[0].body;

  let verified = true;
  try { P.verifyPushRequest({ ...body, handle: "someone-elses-token" }); }
  catch { verified = false; }
  assert(!verified, "swapping the handle breaks the signature — the relay cannot be tricked into a different target");

  verified = true;
  try { P.verifyPushRequest({ ...body, box: P.toB64(new Uint8Array(64).fill(3)) }); }
  catch { verified = false; }
  assert(!verified, "and so does swapping the sealed payload");
}

// --- failures are loud ------------------------------------------------------
{
  await throws(
    () => client({ pushUrl: "" }).instance.notify(target, payload),
    "푸시 서버 주소가 설정되지 않아",
    "an unconfigured relay is refused before anything is sealed",
  );

  await throws(
    () => client({ post: async () => ({ status: 429, text: "" }) }).instance.notify(target, payload),
    "요청 빈도 제한",
    "a rate-limited push says so instead of retrying into the limit",
  );

  await throws(
    () => client({ post: async () => ({ status: 400, text: '{"error":"unknown handle"}' }) }).instance.notify(target, payload),
    "unknown handle",
    "the relay's own reason is surfaced, not a generic failure",
  );

  await throws(
    () => client({ post: async () => ({ status: 500, text: "<html>gateway error</html>" }) }).instance.notify(target, payload),
    "HTTP 500",
    "a non-JSON error body still produces a usable message",
  );

  await throws(
    () => client({ post: async () => { throw new Error("ECONNREFUSED"); } }).instance.notify(target, payload),
    "ECONNREFUSED",
    "a transport failure propagates rather than being swallowed",
  );
}

// --- endpoint derivation ----------------------------------------------------
{
  assert(pushEndpoint("https://push.example") === "https://push.example/v1/push", "a bare host gets the §7 path");
  assert(pushEndpoint("https://push.example/") === "https://push.example/v1/push", "a trailing slash is handled");
  assert(pushEndpoint("https://host/team/v1/push") === "https://host/team/v1/push", "an explicit path is left alone");
  assert(pushEndpoint("http://127.0.0.1:9000") === "http://127.0.0.1:9000/v1/push", "a local relay works for QA");
}

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nAll assertions passed");
process.exit(failures.length ? 1 : 0);
