export interface PrintfulConfig {
  token: string;
  storeId?: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.printful.com";

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\$\{[^}]+\}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv): PrintfulConfig {
  const token = readEnv(env.PRINTFUL_API_TOKEN);
  if (!token) {
    throw new Error(
      "PRINTFUL_API_TOKEN is not set. Create a private token in the Printful Developer Portal (https://developers.printful.com/) and export PRINTFUL_API_TOKEN before starting printful-mcp. For an account-level token, also export PRINTFUL_STORE_ID.",
    );
  }

  const storeId = readEnv(env.PRINTFUL_STORE_ID);
  const baseUrl = readEnv(env.PRINTFUL_API_BASE_URL) ?? DEFAULT_BASE_URL;

  return {
    token,
    baseUrl,
    ...(storeId ? { storeId } : {}),
  };
}
