/**
 * Report client-side diagnostics to the server (Settings → App Logs).
 * Fire-and-forget; never throws to callers.
 */
import { post, getToken } from './client';

export async function postClientAppEvent(payload: {
  severity: 'info' | 'warn' | 'error';
  message: string;
  requestId?: string;
  route?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  if (!getToken()) return;
  try {
    await post('/settings/app-events/client', {
      severity: payload.severity,
      message: payload.message,
      requestId: payload.requestId,
      route: payload.route ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
      context: payload.context,
    });
  } catch {
    /* avoid feedback loops */
  }
}
