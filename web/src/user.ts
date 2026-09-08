// Lightweight, non-secure "auth": user id + display name in localStorage.
// Server trusts X-User-Id. This is a prototype convenience, not real auth.

const USER_KEY = "grubmaps.user.v1";

export type User = { id: string; displayName: string };

export const loadUser = (): User | null => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<User>;
    if (!parsed.id || !parsed.displayName) return null;
    return { id: parsed.id, displayName: parsed.displayName };
  } catch {
    return null;
  }
};

export const saveUser = (u: User) => {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
};

export const clearUser = () => {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
};

const uuid = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for very old environments.
  return "u-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
};

// Register or upsert the display name on the server. Returns the server's
// canonical user record (id may differ if we passed nothing).
export const registerUser = async (displayName: string, existing?: string): Promise<User> => {
  const id = existing ?? uuid();
  const res = await fetch("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, display_name: displayName }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const data = (await res.json()) as { id: string; display_name: string };
  const user = { id: data.id, displayName: data.display_name };
  saveUser(user);
  return user;
};

// Common authenticated fetch wrapper — adds X-User-Id if we have one.
// If the server 401s with "unknown user" (typically because the DB was
// reset while our localStorage id survived), re-upsert the user and retry
// once so the flow doesn't dead-end for the user.
export const authFetch = async (user: User | null, url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? {});
  if (user) headers.set("X-User-Id", user.id);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && user) {
    const cloned = res.clone();
    const body = await cloned.json().catch(() => null) as { error?: string } | null;
    if (body?.error === "unknown user") {
      await registerUser(user.displayName, user.id);
      // Retry once with the freshly-upserted user id.
      const retryHeaders = new Headers(init?.headers ?? {});
      retryHeaders.set("X-User-Id", user.id);
      return fetch(url, { ...init, headers: retryHeaders });
    }
  }
  return res;
};

// Verify our stored user still exists on the server. If not (fresh DB, etc.),
// re-upsert it. Call this on app boot after loadUser().
export const ensureUser = async (user: User): Promise<User> => {
  const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`);
  if (res.ok) return user;
  return registerUser(user.displayName, user.id);
};
