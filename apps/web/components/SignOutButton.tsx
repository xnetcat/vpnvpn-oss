"use client";

import { signOut } from "next-auth/react";

// Web (cookie/JWT) sign-out. Uses next-auth's client signOut() so the JWT
// session cookie is actually cleared, then sends the user to the landing page.
export default function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOut({ callbackUrl: "/" })}
      className="rounded-full border border-slate-700 px-3 py-1 text-slate-200 hover:bg-slate-800"
    >
      Sign out
    </button>
  );
}
