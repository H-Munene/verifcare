// Fetch wrapper: adds the base URL and bearer token, and turns problem+json errors into ApiError.

import { getConfig } from '../config';

// RFC 7807 problem body.
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
  }
}

export interface ApiClient {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  /** Fetches a file (e.g. a CSV export) with the bearer token and saves it as [filename]. */
  download: (path: string, filename: string) => Promise<void>;
}

/** `?a=1&b=2` from the defined values of [params], or '' when there are none. */
export function queryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('json') ? await response.json() : undefined;

  if (!response.ok) {
    const problem: Problem =
      body && typeof body === 'object' && 'title' in body
        ? (body as Problem)
        : { type: 'about:blank', title: response.statusText, status: response.status };
    throw new ApiError(problem);
  }
  return body as T;
}

export function createApiClient(getIdToken: () => Promise<string | null>): ApiClient {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await getIdToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(`${getConfig().apiBaseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return parseResponse<T>(await send(method, path, body));
  }

  // A plain link can't carry the bearer token, so the file is fetched here and handed to the
  // browser as an object URL. The filename is the caller's: reading Content-Disposition would
  // need the API's CORS config to expose that header.
  async function download(path: string, filename: string): Promise<void> {
    const response = await send('GET', path);
    if (!response.ok) {
      await parseResponse(response);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked on the next tick: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
    download,
  };
}
