// Typed fetch wrapper: base URL from VITE_API_BASE_URL, attaches the bearer token from
// AuthContext, and parses RFC 7807 error bodies (backend/src/errors.ts's sendProblem() shape)
// into a typed ApiError instead of letting callers deal with raw Response objects.

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL;

// Matches backend/openapi.yaml's Problem schema and backend/src/errors.ts's sendProblem() exactly.
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

// getIdToken is injected (not imported from auth/AuthContext directly) so this module stays a
// plain, test-friendly function rather than reaching into React context from outside a component.
export function createApiClient(getIdToken: () => Promise<string | null>): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getIdToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return parseResponse<T>(response);
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  };
}
