/**
 * Standard API error shape and helpers.
 * Matches backend { error, message?, details? }.
 */

export const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface ApiErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
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
