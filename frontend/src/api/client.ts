/**
 * Global API client: request logging, normalized errors, auth header.
 */
import log from '../utils/logger';
import { API_BASE, type ApiErrorBody, ApiError } from './errors';

function getToken(): string | null {
  return localStorage.getItem('auth_token');
}

function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: object | string | null;
  skipAuth?: boolean;
  /** Explicit idempotency key for retry-safe critical write requests. */
  idempotencyKey?: string;
  /** Force idempotency on/off for this write. Defaults on for critical mutations only. */
  idempotent?: boolean;
  /** Semantic in-flight dedup key for duplicate write clicks/submits. */
  mutationKey?: string;
  /** Override default GET cache TTL. `0` disables caching for this request. */
  cacheTtlMs?: number;
  /** Force bypassing cache and network-dedup for this request. */
  forceRefresh?: boolean;
  /** Optional stable key override when query params are not deterministic. */
  cacheKey?: string;
}

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const responseCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<unknown>>();
const inflightMutations = new Map<string, Promise<unknown>>();

const DEFAULT_CACHE_TTL_MS = 20_000;
const CACHEABLE_GET_PREFIXES = [
  '/settings/',
  '/menu-items/',
  '/modifiers/',
  '/menu/deals',
  '/stock/',
  '/inventory-advanced/',
  '/branches/',
];
const NON_CACHEABLE_GET_PREFIXES = [
  '/orders/kitchen',
  '/orders/active',
  '/orders/',
  '/printer/status',
];

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON clone for plain objects.
    }
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function normalizePath(path: string): string {
  try {
    const asUrl = path.startsWith('http') ? new URL(path) : new URL(path, API_BASE);
    return `${asUrl.pathname}${asUrl.search}`;
  } catch {
    return path;
  }
}

function shouldCacheGet(path: string): boolean {
  const normalized = normalizePath(path);
  if (NON_CACHEABLE_GET_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return false;
  }
  return CACHEABLE_GET_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function shouldUseIdempotency(method: string, path: string): boolean {
  const normalized = normalizePath(path);
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return false;
  }
  return [
    /^\/orders\/(checkout|kot|dine-in\/kot)$/,
    /^\/orders\/\d+\/(items|kitchen-status|delivery-complete|finalize|cancel-open|rollback)$/,
    /^\/stock\/(update|bulk-restock)$/,
    /^\/inventory-advanced\/prepared-items\/\d+\/batches$/,
    /^\/inventory-advanced\/purchase-orders\/\d+\/(receive|cancel)$/,
    /^\/inventory-advanced\/movements$/,
    /^\/inventory-advanced\/recipes$/,
    /^\/inventory-advanced\/recipes\/prepared-items$/,
    /^\/inventory-advanced\/recipes\/extra-costs$/,
    /^\/inventory-advanced\/recipes\/extra-costs\/\d+$/,
    /^\/inventory-advanced\/recipes\/\d+$/,
    /^\/inventory-advanced\/recipes\/prepared-items\/\d+$/,
  ].some(pattern => pattern.test(normalized));
}

function stableBodyForKey(body: object | string | null | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return value;
  };
  try {
    return JSON.stringify(normalize(body));
  } catch {
    return JSON.stringify(body);
  }
}

function buildMutationKey(method: string, path: string, token: string | null, body: object | string | null | undefined, override?: string): string {
  const key = override?.trim();
  if (key) return key;
  const tokenSegment = token ? token.slice(-16) : 'anon';
  return `${method}:${normalizePath(path)}:${stableBodyForKey(body)}:u=${tokenSegment}`;
}

function getDefaultCacheTtlMs(path: string): number {
  return shouldCacheGet(path) ? DEFAULT_CACHE_TTL_MS : 0;
}

function buildCacheKey(method: string, path: string, token: string | null, cacheKeyOverride?: string): string {
  const stablePath = cacheKeyOverride?.trim() || normalizePath(path);
  // Token segment keeps cache isolated per authenticated user/session.
  const tokenSegment = token ? token.slice(-16) : 'anon';
  return `${method}:${stablePath}:u=${tokenSegment}`;
}

function getCachedResponse<T>(key: string): T | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return cloneValue(entry.value as T);
}

function setCachedResponse<T>(key: string, value: T, ttlMs: number): void {
  if (ttlMs <= 0) return;
  responseCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value: cloneValue(value),
  });
}

function clearApiCache(): void {
  responseCache.clear();
}

export function resetApiClientStateForTests(): void {
  clearApiCache();
  inflightRequests.clear();
  inflightMutations.clear();
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
  const defaultTtl = method === 'GET' ? getDefaultCacheTtlMs(path) : 0;
  const ttlMs = options.cacheTtlMs ?? defaultTtl;
  const shouldUseCache = method === 'GET' && ttlMs > 0 && !options.forceRefresh;
  const shouldUseMutationIdempotency =
    method !== 'GET' && !options.skipAuth && (options.idempotent ?? shouldUseIdempotency(method, path));

  const clientRequestId = newClientRequestId();
  const headers: HeadersInit = {
    ...(options.headers as Record<string, string>),
  };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!(headers as Record<string, string>)['X-Request-ID'] && !(headers as Record<string, string>)['x-request-id']) {
    (headers as Record<string, string>)['X-Request-ID'] = clientRequestId;
  }
  if (shouldUseMutationIdempotency && !(headers as Record<string, string>)['X-Idempotency-Key'] && !(headers as Record<string, string>)['x-idempotency-key']) {
    (headers as Record<string, string>)['X-Idempotency-Key'] = options.idempotencyKey?.trim() || newClientRequestId();
  }
  if (options.body != null && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const cacheKey = shouldUseCache ? buildCacheKey(method, path, token, options.cacheKey) : null;
  const mutationKey = shouldUseMutationIdempotency ? buildMutationKey(method, path, token, options.body, options.mutationKey) : null;
  if (mutationKey) {
    const inflightMutation = inflightMutations.get(mutationKey) as Promise<T> | undefined;
    if (inflightMutation) {
      log.info('API', `MUTATION INFLIGHT DEDUP ${path}`, { mutationKey });
      return inflightMutation;
    }
  }
  if (cacheKey) {
    const cached = getCachedResponse<T>(cacheKey);
    if (cached !== null) {
      log.info('API', `CACHE HIT ${path}`, { cacheKey });
      return cached;
    }
    const inflight = inflightRequests.get(cacheKey) as Promise<T> | undefined;
    if (inflight) {
      log.info('API', `INFLIGHT DEDUP ${path}`, { cacheKey });
      return inflight;
    }
  }

  let body: BodyInit | undefined;
  if (options.body != null) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  log.info('API', `${method} ${path}`, { url, clientRequestId });
  const execute = async (): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(url, { ...options, method, headers, body });
    } catch (e) {
      const duration = Math.round(performance.now() - start);
      log.error('API', 'Network error', { path, duration, clientRequestId, err: String(e) });
      throw new ApiError(
        0,
        { error: 'Network Error', message: 'Network request failed', requestId: clientRequestId },
        (e as Error).message
      );
    }

    const duration = Math.round(performance.now() - start);
    const requestId = res.headers.get('X-Request-ID') ?? clientRequestId;
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
        code: (bodyJson as ApiErrorBody).code,
        requestId: (bodyJson as ApiErrorBody).requestId ?? requestId,
        debug: (bodyJson as ApiErrorBody).debug,
      };
      const apiError = new ApiError(res.status, errBody);

      // Session expired or invalid: clear auth and redirect to login so user can re-authenticate without restarting.
      if (res.status === 401 && token && !options.skipAuth) {
        const pathLower = path.toLowerCase();
        const isAuthRoute = pathLower.includes('/auth/login') || pathLower.includes('/auth/setup');
        if (!isAuthRoute) {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('user');
          log.info('API', 'Session expired or invalid → cleared auth, redirecting to login');
          window.location.href = '/login';
        }
      }

      throw apiError;
    }

    if (cacheKey && shouldUseCache) {
      setCachedResponse(cacheKey, bodyJson as T, ttlMs);
    } else if (method !== 'GET') {
      // Keep read-after-write behavior predictable after mutations.
      clearApiCache();
    }

    return bodyJson as T;
  };

  if (!cacheKey) {
    if (!mutationKey) {
      return execute();
    }
    const promise = execute();
    inflightMutations.set(mutationKey, promise);
    try {
      return await promise;
    } finally {
      inflightMutations.delete(mutationKey);
    }
  }

  const promise = execute();
  inflightRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
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
export { ApiError, getUserMessage, getUserMessageWithRef, isApiError } from './errors';
