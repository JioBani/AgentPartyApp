import { resolveGuideOffer } from "../dist/shared/guideOffer.js";

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

const first = resolveGuideOffer(null);
assert(first.view.pending === false && first.view.shown === true, "first install does not offer the guide at startup");
assert(first.write?.shown === true, "first install persists the disabled startup offer");

const pending = resolveGuideOffer({ shown: false });
assert(pending.view.pending === false && pending.view.shown === true, "an old pending record is disabled after updating");
assert(pending.write?.shown === true, "an old pending record is migrated to shown");

const done = resolveGuideOffer({ shown: true });
assert(done.view.pending === false && done.view.shown === true, "shown stays shown");

if (failures.length) {
  console.error(`FAILED ${failures.length}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("OK");
