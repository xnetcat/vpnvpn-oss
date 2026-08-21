import { describe, it, expect, beforeEach } from "vitest";

// Provide a minimal localStorage polyfill for test runners that do not supply a
// DOM environment (e.g. `bun test`). Under vitest's jsdom environment the real
// implementation is already present and this is a no-op.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

import {
  getStoredSessionToken,
  setStoredSessionToken,
  clearStoredSessionToken,
  getStoredUser,
  setStoredUser,
} from "./auth";

describe("session token storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no token is stored", () => {
    expect(getStoredSessionToken()).toBeNull();
  });

  it("round-trips a stored token", () => {
    setStoredSessionToken("abc123");
    expect(getStoredSessionToken()).toBe("abc123");
  });

  it("clears the token and user on sign-out", () => {
    setStoredSessionToken("tok");
    setStoredUser({ id: "u1", email: "a@b.c" });
    clearStoredSessionToken();
    expect(getStoredSessionToken()).toBeNull();
    expect(getStoredUser()).toBeNull();
  });
});

describe("user storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no user is stored", () => {
    expect(getStoredUser()).toBeNull();
  });

  it("round-trips a stored user object", () => {
    const user = { id: "u1", email: "a@b.c", name: "Alice" };
    setStoredUser(user);
    expect(getStoredUser()).toEqual(user);
  });

  it("returns null for corrupted user JSON", () => {
    localStorage.setItem("vpnvpn_user", "{not valid json");
    expect(getStoredUser()).toBeNull();
  });
});
