// Runtime config. The hosted app reads /config.json, which CDK writes at deploy time
// (infra/lib/web.ts) from the stack's own API URL and Cognito IDs, so one build works for any
// environment and can't drift from what's deployed. Local dev keeps using the VITE_* vars in .env.

export interface AppConfig {
  apiBaseUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  googleMapsApiKey: string;
}

let config: AppConfig | undefined;

export async function loadConfig(): Promise<void> {
  const raw: AppConfig = import.meta.env.DEV
    ? {
        apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
        userPoolId: import.meta.env.VITE_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
        googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
      }
    : await fetchConfigJson();
  // API Gateway's stage URL ends in '/', while every request path starts with one.
  config = { ...raw, apiBaseUrl: raw.apiBaseUrl.replace(/\/+$/, '') };
}

async function fetchConfigJson(): Promise<AppConfig> {
  // no-store: a stale config could point a fresh deploy at the wrong API or user pool.
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Couldn't load /config.json (HTTP ${response.status}).`);
  }
  return (await response.json()) as AppConfig;
}

export function getConfig(): AppConfig {
  if (!config) {
    throw new Error('getConfig() called before loadConfig() finished.');
  }
  return config;
}
