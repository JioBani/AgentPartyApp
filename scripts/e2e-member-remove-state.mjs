/*
 * Focused real-app E2E for member removal with more than one party.
 *
 * A headless caller moves the process-wide advisory party hint to B while the
 * only window remains on A. The real sidebar then removes a member from A. This
 * locks in four boundaries that previously drifted independently:
 *   - the renderer stays on the window-owned party A;
 *   - the removed member and its live session disappear only from A;
 *   - B is unchanged;
 *   - the grouped sidebar summary drops immediately and survives restart.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, removePath } from "./lib/electron-e2e.mjs";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = qaRunDir("member-remove-state");
const workspace = path.join(runRoot, "workspace");
const userData = path.join(runRoot, "userdata");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(probe, matches, attempts = 160) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      value = await probe();
      if (matches(value)) return value;
    } catch {
      // The renderer/API is between two expected states; retry the observation.
    }
    await delay(50);
  }
  return value;
}

const durableMemberKey = (member) => [
  member.partyId,
  member.name,
  member.runtime,
  member.model,
  member.role,
  member.location,
].map((value) => value || "").join("/");
const durableMemberSignature = (party) => (party?.members || [])
  .map(durableMemberKey)
  .sort();
const liveMemberSignature = (party) => (party?.members || [])
  .map((member) => `${durableMemberKey(member)}/${member.sessionId || ""}`)
  .sort();

async function main() {
  const port = await freePort();
  const app = createElectronE2eApp({
    root,
    workspace,
    userData,
    port,
    env: {
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([path.join(root, "scripts", "fake-codex-appserver.mjs")]),
    },
  });
  const { get, post } = app;
  let keepEvidence = true;

  const windowId = async () => (await get("/api/windows")).windows?.[0]?.id;
  const measure = (win, selector, body = {}) => post(
    `/api/measure?window=${encodeURIComponent(win)}`,
    { selector, ...body },
  );
  const rendererParty = async (win) => {
    const result = await measure(win, ".wb-root", { attributes: ["data-party-id"] });
    return result?.elements?.[0]?.attributes?.["data-party-id"];
  };
  const sidebarSummary = async (win, partyId) => {
    const result = await measure(win, `.wb-party-row[data-party-id=${JSON.stringify(partyId)}] .wb-party-sub`);
    return result?.elements?.[0]?.text || "";
  };
  const registeredParty = async (partyId) => (await get("/api/party-groups")).parties?.find((party) => party.id === partyId);
  const partyById = (partyId) => get("/api/party", { "x-agentparty-party": partyId });

  await app.prepare();
  try {
    await app.launch();
    let win = await windowId();
    assert(Boolean(win), "the isolated app opened one target window");

    await post("/api/settings", {
      selectedHarnessId: "codex",
      harnessDefaults: {
        codex: {
          model: "gpt-5.4",
          effort: "medium",
          codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
        },
      },
      workspacePath: workspace,
    });

    const partyA = await post(`/api/parties?window=${encodeURIComponent(win)}`, {
      name: "DELETE-A",
      location: workspace,
    });
    const idA = partyA.currentPartyId;
    await post(`/api/party/members?window=${encodeURIComponent(win)}`, {
      partyId: idA,
      name: "delete-probe",
      requirement: "Offline member-removal E2E probe.",
      runtime: "codex",
      model: "gpt-5.4",
      location: workspace,
    });

    const beforeA = await waitFor(
      () => partyById(idA),
      (party) => party?.members?.some((member) => member.name === "delete-probe" && member.sessionId),
    );
    const removedSessionId = beforeA?.members?.find((member) => member.name === "delete-probe")?.sessionId;
    assert(Boolean(removedSessionId), "the deletion target owns a live session before removal");

    // No window scope: this moves only the process-wide default/hint to B. The
    // renderer and controller must continue to regard this window as A.
    const partyB = await post("/api/parties", { name: "UNCHANGED-B", location: workspace });
    const idB = partyB.currentPartyId;
    const beforeB = await partyById(idB);
    const otherPartyBefore = liveMemberSignature(beforeB);
    const otherPartyDurableBefore = durableMemberSignature(beforeB);

    const ready = await waitFor(async () => ({
      controllerParty: (await get(`/api/party?window=${encodeURIComponent(win)}`)).currentPartyId,
      rendererParty: await rendererParty(win),
      summary: await sidebarSummary(win, idA),
      registeredCount: (await registeredParty(idA))?.memberCount,
    }), (value) => value.controllerParty === idA
      && value.rendererParty === idA
      && value.summary === "2 members"
      && value.registeredCount === 2);
    assert(ready?.controllerParty === idA && ready?.rendererParty === idA, "window and renderer remain on A while the global hint points to B");
    assert(ready?.summary === "2 members" && ready?.registeredCount === 2, "sidebar and registry show A's two members before removal");

    const memberDir = path.join(userData, "party-store", ".agent_party_app", "parties", idA, "members", "delete-probe");
    assert(fs.existsSync(memberDir), "the target member has persisted storage before removal");

    await post(`/api/qa/pointer?window=${encodeURIComponent(win)}`, {
      steps: [
        { selector: '.wb-member-row:has(.wb-member-name[title="delete-probe"])', action: "rightclick" },
        { selector: ".wb-ctx-menu .wb-ctx-item.is-danger", action: "click" },
      ],
      delayMs: 120,
    });

    const removed = await waitFor(async () => {
      const party = await get(`/api/party?window=${encodeURIComponent(win)}`);
      const members = await measure(win, ".wb-member-row");
      return {
        party,
        rendererParty: await rendererParty(win),
        memberTexts: members.texts || [],
        summary: await sidebarSummary(win, idA),
        registeredCount: (await registeredParty(idA))?.memberCount,
      };
    }, (value) => value.party?.currentPartyId === idA
      && value.rendererParty === idA
      && !value.party?.members?.some((member) => member.name === "delete-probe")
      && !value.memberTexts.some((text) => text.includes("delete-probe"))
      && value.summary === "1 member"
      && value.registeredCount === 1);

    assert(removed?.party?.currentPartyId === idA && removed?.rendererParty === idA, "member removal keeps the current window and rendered workbench on A");
    assert(!removed?.party?.members?.some((member) => member.name === "delete-probe"), "A's authoritative state no longer contains the deleted member");
    assert(!removed?.memberTexts?.some((text) => text.includes("delete-probe")), "the deleted member disappears from the real sidebar");
    assert(removed?.summary === "1 member" && removed?.registeredCount === 1, "the sidebar and registered summary immediately drop A to one member");

    const afterB = await partyById(idB);
    assert(JSON.stringify(liveMemberSignature(afterB)) === JSON.stringify(otherPartyBefore), "B's members and sessions are unchanged");
    const sessionsAfter = (await get("/api/state")).sessions || [];
    assert(!sessionsAfter.some((session) => session.id === removedSessionId), "the deleted member's live session is still closed");
    assert(!fs.existsSync(memberDir), "the deleted member's persisted directory is still removed");

    await app.close();
    await app.launch();
    win = await windowId();

    const restartA = await partyById(idA);
    const restartB = await partyById(idB);
    const restartRegisteredA = await registeredParty(idA);
    assert(durableMemberSignature(restartA).length === 1 && restartA.members[0]?.name === "main", "restart restores A with only its main member");
    assert(JSON.stringify(durableMemberSignature(restartB)) === JSON.stringify(otherPartyDurableBefore), "restart preserves B's durable member state unchanged");
    assert(restartRegisteredA?.memberCount === 1, "restart restores the grouped summary with A at one member");
    assert(!fs.existsSync(memberDir), "restart does not resurrect the deleted member's storage");

    await post(`/api/parties/${idA}/select?window=${encodeURIComponent(win)}`, {});
    const restartedUi = await waitFor(async () => ({
      party: await rendererParty(win),
      summary: await sidebarSummary(win, idA),
      members: (await measure(win, ".wb-member-row")).texts || [],
    }), (value) => value.party === idA
      && value.summary === "1 member"
      && value.members.length === 1
      && value.members[0].includes("main"));
    assert(restartedUi?.party === idA && restartedUi?.summary === "1 member", "after restart, selecting A renders the same one-member summary");
    assert(restartedUi?.members?.length === 1 && restartedUi.members[0].includes("main"), "after restart, A's real member sidebar remains consistent");

    await app.close();
    keepEvidence = failures.length > 0;
  } catch (error) {
    app.kill();
    throw error;
  } finally {
    app.kill();
    if (keepEvidence) {
      console.error(`E2E evidence retained at ${runRoot}`);
    } else {
      await removePath(runRoot);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`MEMBER REMOVE STATE E2E FAILED: ${failures.length}`);
    process.exit(1);
  }
  console.log("MEMBER REMOVE STATE E2E PASSED (party selection + summary + restart)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
