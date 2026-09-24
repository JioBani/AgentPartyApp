/** Browser tabs live in the workbench layout, but are not party members. */
// Private-use marker keeps this tab id separate from ordinary user names while
// remaining safe in persisted JSON and DOM data attributes used by tab drag.
const BROWSER_TAB_PREFIX = "\uE000agentparty-browser:";

export function browserTabId(member: string): string {
  return `${BROWSER_TAB_PREFIX}${member}`;
}

export function browserTabMember(tab: string): string | undefined {
  return tab.startsWith(BROWSER_TAB_PREFIX) && tab.length > BROWSER_TAB_PREFIX.length
    ? tab.slice(BROWSER_TAB_PREFIX.length)
    : undefined;
}
