/**
 * Local CLIProxyAPI defaults shared by the two cross-harness subscription
 * routes. The key authenticates only a loopback client to the local proxy; it
 * is not an OpenAI/Anthropic credential. Deployments with a different proxy
 * config can override both values through the documented environment vars.
 */
export const DEFAULT_SUBSCRIPTION_PROXY_BASE_URL = "http://127.0.0.1:8317/v1";
export const DEFAULT_SUBSCRIPTION_PROXY_API_KEY = "sk-local-ccr";
export const SUBSCRIPTION_PROXY_URL_ENV = "AGENTPARTY_SUBSCRIPTION_PROXY_URL";
export const SUBSCRIPTION_PROXY_KEY_ENV = "AGENTPARTY_SUBSCRIPTION_PROXY_KEY";

