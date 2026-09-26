/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_USER_POOL_ID: string;
  readonly VITE_USER_POOL_CLIENT_ID: string;
  // Google Maps JavaScript API key (HEZ-86) - used only by components/ExactLocationMap.tsx for
  // the bounded pin-placement step, after county/constituency/ward is already chosen via
  // OpenStreetMap boundary data. Restrict this key in the Google Cloud Console to the Maps
  // JavaScript API and to this app's actual origin(s) - it is bundled into client-side JS like
  // every other VITE_ var here, so it is not a secret in the traditional sense, but an
  // unrestricted key lets anyone who copies it make calls billed to this project.
  readonly VITE_GOOGLE_MAPS_API_KEY: string;
  // SAMPLE DATA (remove with api/dashboardSample.ts): "true" shows a generated busy day on the
  // Overview instead of real data. Local .env only.
  readonly VITE_DASHBOARD_SAMPLE_DATA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
