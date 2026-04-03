/**
 * Single terminal branch: always derived from the authenticated user (JWT / localStorage user).
 * Do not use `active_branch_id` for scoping — branch switching is not supported in POS.
 */

export type AuthUser = {
  id?: number;
  branch_id?: number | null;
  role?: string;
  username?: string;
};

export function parseUserFromStorage(): AuthUser | null {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function getTerminalBranchId(user: AuthUser | null | undefined): number | null {
  if (user?.branch_id != null && user.branch_id !== undefined) {
    const n = Number(user.branch_id);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function getTerminalBranchIdString(user: AuthUser | null | undefined): string {
  const id = getTerminalBranchId(user);
  return id == null ? '' : String(id);
}
