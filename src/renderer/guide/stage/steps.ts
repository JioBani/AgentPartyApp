/**
 * Runs a slide's `steps` against the stage's own DOM.
 *
 * The stage shows the real workbench, and half of what a first-time user needs
 * to see lives behind a click: the new-party modal, the member wizard, the model
 * catalog, the ⋯ menu, the right-click menu. Those are component state, so no
 * snapshot can express them. This opens them the way a user does.
 *
 * Everything here is deliberately unforgiving. A selector that never appears
 * returns a failure string, and the guide paints it over the stage — a slide
 * that silently lost its modal would still look like a finished slide, which is
 * exactly the kind of quiet wrong this project keeps having to dig back out.
 */
import type { GuideStageStep } from "../../../shared/guide";

/** How long a step waits for its target before giving up. */
const WAIT_MS = 2000;
const POLL_MS = 25;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitFor(selector: string): Promise<Element | null> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = document.querySelector(selector);
    if (found) {
      return found;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(POLL_MS);
  }
}

/**
 * Types into a React-controlled field.
 *
 * `el.value = text` is invisible to React — its own value setter is shadowed on
 * the instance, so the component would keep rendering the old (empty) value and
 * the slide would show an empty box. Calling the prototype setter and then
 * firing `input` is what React's synthetic-event layer actually listens to.
 */
function fill(el: Element, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) {
    throw new Error("value setter 를 찾지 못했습니다.");
  }
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function contextMenu(el: Element): void {
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2),
  }));
}

/**
 * Runs the steps in order and returns the failures, most useful one first.
 *
 * The settle wait is not padding. The transcript scrolls itself to the bottom
 * right after mount, and the sidebar's context menu closes on ANY window scroll
 * — so a menu opened before that scroll lands is gone by the time the slide is
 * looked at, with nothing to show it ever opened.
 */
export async function runStageSteps(steps: readonly GuideStageStep[]): Promise<string[]> {
  if (!steps.length) {
    return [];
  }
  await sleep(400);
  for (const step of steps) {
    const target = await waitFor(step.selector);
    if (!target) {
      return [`무대 연출 실패: '${step.selector}' 가 나타나지 않았습니다 (${step.do}).`];
    }
    try {
      if (step.do === "click") {
        (target as HTMLElement).click();
      } else if (step.do === "contextmenu") {
        contextMenu(target);
      } else {
        fill(target, step.text);
      }
    } catch (error) {
      return [`무대 연출 실패: '${step.selector}' (${step.do}) — ${error instanceof Error ? error.message : String(error)}`];
    }
    // One frame plus a tick: the click's state update has to render before the
    // next step can look for what it opened.
    await new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
  }
  return [];
}
