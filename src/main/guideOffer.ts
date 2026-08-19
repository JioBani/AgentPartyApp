/**
 * Persists the §8 first-install offer. Separate from settings.json so an
 * upgrade (existing settings, no record) can be told apart from a first boot.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { log } from "./logger";
import { resolveGuideOffer, type GuideOfferRecord, type GuideOfferView } from "../shared/guideOffer";

let settingsExistedAtBoot: boolean | undefined;
let cached: GuideOfferView | undefined;

function settingsPath(): string {
  return path.join(getUserDataDir(), "settings.json");
}

function offerPath(): string {
  return path.join(getUserDataDir(), "guide-offer.json");
}

function bootHadSettings(): boolean {
  if (settingsExistedAtBoot === undefined) {
    settingsExistedAtBoot = fs.existsSync(settingsPath());
  }
  return settingsExistedAtBoot;
}

function readRecord(): GuideOfferRecord | null {
  try {
    if (!fs.existsSync(offerPath())) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(offerPath(), "utf8")) as GuideOfferRecord;
    if (typeof raw?.shown !== "boolean") {
      throw new Error("guide-offer.json에 shown 값이 없습니다.");
    }
    return { shown: raw.shown };
  } catch (error) {
    log("warn", "guide", "guide-offer.json unreadable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function writeRecord(record: GuideOfferRecord): void {
  const dest = offerPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
  fs.renameSync(temp, dest);
}

export function getGuideOffer(): GuideOfferView {
  if (cached) {
    return cached;
  }
  const resolved = resolveGuideOffer({
    record: readRecord(),
    settingsExistedAtBoot: bootHadSettings(),
  });
  if (resolved.write) {
    writeRecord(resolved.write);
  }
  cached = resolved.view;
  return cached;
}

export function markGuideOfferShown(): GuideOfferView {
  writeRecord({ shown: true });
  cached = { pending: false, shown: true };
  log("info", "guide", "first-install offer marked shown");
  return cached;
}

/** Test-only: drop the process-local snapshot so a later call re-reads disk. */
export function resetGuideOfferCacheForTests(): void {
  settingsExistedAtBoot = undefined;
  cached = undefined;
}
