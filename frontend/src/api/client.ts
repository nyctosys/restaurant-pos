/**
 * Global API client: request logging, normalized errors, auth header.
 */
import log from '../utils/logger';
import { API_BASE, type ApiErrorBody, ApiError } from './errors';

function getToken(): string | null {
  return localStorage.getItem('auth_token');
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: object | string | null;
  skipAuth?: boolean;
}

/**
 * Fetch with base URL, auth, logging, and consistent error handling.
 * Throws ApiError on non-2xx; logs request + response (status, duration, X-Request-ID).
 */
export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const method = options.method ?? 'GET';
  const token = options.skipAuth ? null : getToken();
  const start = performance.now();

  const headers: HeadersInit = {
    ...(options.headers as Record<string, string>),
  };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body != null && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  let body: BodyInit | undefined;
  if (options.body != null) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  log.info('API', `${method} ${path}`, { url });
  let res: Response;
  try {
    res = await fetch(url, { ...options, method, headers, body });
  } catch (e) {
    const duration = Math.round(performance.now() - start);
    log.error('API', 'Network error', { path, duration, err: String(e) });
    throw new ApiError(0, { error: 'Network Error', message: 'Network request failed' }, (e as Error).message);
  }

  const duration = Math.round(performance.now() - start);
  const requestId = res.headers.get('X-Request-ID') ?? undefined;
  if (res.ok) {
    log.info('API', `${res.status} ${path}`, { duration, requestId });
  } else {
    log.error('API', `${res.status} ${path}`, { duration, requestId });
  }

  let bodyJson: ApiErrorBody & T;
  const text = await res.text();
  try {
    bodyJson = (text ? JSON.parse(text) : {}) as ApiErrorBody & T;
  } catch {
    bodyJson = { error: 'Invalid Response', message: text || `Request failed (${res.status})` } as ApiErrorBody & T;
  }

  if (!res.ok) {
    const errBody: ApiErrorBody = {
      error: bodyJson.error ?? `Error ${res.status}`,
      message: bodyJson.message ?? bodyJson.error ?? `Request failed (${res.status})`,
      details: (bodyJson as ApiErrorBody).details,
    };
    throw new ApiError(res.status, errBody);
  }

  return bodyJson as T;
}

/** GET helper */
export function get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}

/** POST helper */
export function post<T = unknown>(path: string, body?: object | null, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body: body ?? undefined });
}

/** PUT helper */
export function put<T = unknown>(path: string, body?: object | null, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'PUT', body: body ?? undefined });
}

/** PATCH helper */
export function patch<T = unknown>(path: string, body?: object | null, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', body: body ?? undefined });
}

/** DELETE helper */
export function del<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE' });
}

export { getToken };
export { ApiError, getUserMessage, isApiError } from './errors';
