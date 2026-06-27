export function isE2E(): boolean {
  return process.env.AGENTPARTY_E2E === "1";
}
