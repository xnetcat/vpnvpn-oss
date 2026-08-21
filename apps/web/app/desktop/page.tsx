"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function DesktopAuthContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"redirecting" | "error">("redirecting");

  useEffect(() => {
    const token = searchParams.get("token");
    const callbackUrl = searchParams.get("callbackUrl");

    if (token) {
      window.location.href = `vpnvpn://auth?token=${encodeURIComponent(token)}`;
      return;
    }

    if (callbackUrl) {
      window.location.href = `vpnvpn://auth/email-callback?next=${encodeURIComponent(callbackUrl)}`;
      return;
    }

    setStatus("error");
  }, [searchParams]);

  if (status === "error") {
    return (
      <div style={{ padding: 40, textAlign: "center", fontFamily: "system-ui" }}>
        <h1>vpnVPN Desktop</h1>
        <p>Missing authentication token. Please sign in from the desktop app.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 40, textAlign: "center", fontFamily: "system-ui" }}>
      <h1>vpnVPN Desktop</h1>
      <p>Redirecting to the desktop app...</p>
      <p style={{ fontSize: 14, color: "#666", marginTop: 16 }}>
        If nothing happens, make sure vpnVPN Desktop is installed.
      </p>
    </div>
  );
}

export default function DesktopAuthPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 40, textAlign: "center", fontFamily: "system-ui" }}>
          <h1>vpnVPN Desktop</h1>
          <p>Loading...</p>
        </div>
      }
    >
      <DesktopAuthContent />
    </Suspense>
  );
}
