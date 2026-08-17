import { nextGuideOfferAction, resolveGuideOffer } from "../dist/shared/guideOffer.js";

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

const first = resolveGuideOffer({ record: null, settingsExistedAtBoot: false });
assert(first.view.pending === true && first.view.shown === false, "first install is pending");
assert(first.write && first.write.shown === false, "first install writes pending record");

const upgrade = resolveGuideOffer({ record: null, settingsExistedAtBoot: true });
assert(upgrade.view.pending === false && upgrade.view.shown === true, "existing settings.json is an upgrade — never offer");
assert(upgrade.write && upgrade.write.shown === true, "upgrade writes shown so a later boot does not flip");

const pending = resolveGuideOffer({ record: { shown: false }, settingsExistedAtBoot: true });
assert(pending.view.pending === true, "a pending first-install survives a later settings.json write");

const done = resolveGuideOffer({ record: { shown: true }, settingsExistedAtBoot: false });
assert(done.view.pending === false && done.view.shown === true, "shown stays shown");

assert(nextGuideOfferAction(false, true) === "idle", "not pending → idle");
assert(nextGuideOfferAction(true, false) === "auth", "pending + no account → auth first");
assert(nextGuideOfferAction(true, true) === "show", "pending + connected → show popup");

if (failures.length) {
  console.error(`FAILED ${failures.length}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("OK");
