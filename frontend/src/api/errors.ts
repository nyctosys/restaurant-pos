/**
 * Standard API error shape and helpers.
 * Matches backend { error, message?, details? }.
 */

export const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ApiErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
  /** Correlates with server `X-Request-ID` and Settings → App Logs */
  requestId?: string;
  code?: string;
  /** Present on some 500 responses when APP_DEBUG=1 on server */
  debug?: unknown;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody, message?: string) {
    super(message ?? body.message ?? body.error ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get userMessage(): string {
    return this.body.message ?? this.body.error ?? this.message;
  }

  /** User-facing message plus request reference when available (for support / logs). */
  get messageWithRef(): string {
    const base = this.userMessage;
    const rid = this.body.requestId;
    if (rid) return `${base} (Ref: ${rid})`;
    return base;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Get a user-facing message from an unknown error (API or network). */
export function getUserMessage(e: unknown): string {
  if (isApiError(e)) return e.userMessage;
  if (e instanceof Error) return e.message;
  return String(e ?? 'An error occurred');
}

/** Prefer message + request id for toasts and diagnostics. */
export function getUserMessageWithRef(e: unknown): string {
  if (isApiError(e)) return e.messageWithRef;
  return getUserMessage(e);
}
