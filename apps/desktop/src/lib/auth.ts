const SESSION_TOKEN_KEY = "vpnvpn_session_token";
const USER_KEY = "vpnvpn_user";

export function getStoredSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    console.error("Failed to store session token");
  }
}

export function clearStoredSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    console.error("Failed to clear session token");
  }
}

export function getStoredUser(): {
  id: string;
  email?: string;
  name?: string;
} | null {
  try {
    const stored = localStorage.getItem(USER_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user: {
  id: string;
  email?: string;
  name?: string;
}): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    console.error("Failed to store user");
  }
}

export async function authFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getStoredSessionToken();
  const headers = new Headers(options.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}
