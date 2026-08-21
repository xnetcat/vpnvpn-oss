import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import { Terminal, Server } from "lucide-react";
import { WEB_ENV } from "@/env";

export default async function AdminProvisionPage() {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  const apiUrl = WEB_ENV.CONTROL_PLANE_API_URL;

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          Provisioning
        </p>
        <h1 className="text-2xl font-semibold text-slate-50">
          Server Provisioning
        </h1>
        <p className="text-sm text-slate-400">
          Deploy new VPN servers using the commands below
        </p>
      </div>

      <div className="space-y-6">
        {/* Docker Deployment */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20 backdrop-blur">
          <div className="mb-4 flex items-center gap-2">
            <Server className="h-5 w-5 text-sky-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Docker Deployment
            </h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Deploy a VPN server using Docker (requires NET_ADMIN capabilities)
          </p>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                1. Create a registration token
              </label>
              <p className="mb-2 text-sm text-slate-300">
                Go to the{" "}
                <a
                  href="/admin/tokens"
                  className="text-amber-200 underline-offset-4 transition hover:text-amber-100 hover:underline"
                >
                  Tokens page
                </a>{" "}
                and create a new token for this server.
              </p>
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                2. Run the Docker command
              </label>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-slate-950 p-4 text-xs font-mono text-emerald-100 ring-1 ring-slate-800">
                  {`docker run -d \\
  --name vpnvpn-server \\
  --cap-add NET_ADMIN \\
  --device /dev/net/tun \\
  -p 51820:51820/udp \\
  -p 8080:8080 \\
  -e API_URL="${apiUrl}" \\
  -e VPN_TOKEN="<YOUR_TOKEN_HERE>" \\
  -e LISTEN_UDP_PORT=51820 \\
  vpnvpn/vpn-server:latest`}
                </pre>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Replace{" "}
                <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-100">
                  &lt;YOUR_TOKEN_HERE&gt;
                </code>{" "}
                with your actual token.
              </p>
            </div>
          </div>
        </div>

        {/* Binary Deployment */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20 backdrop-blur">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Binary Deployment
            </h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Deploy a VPN server using the compiled binary (Linux, macOS,
            Windows)
          </p>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                1. Download the binary
              </label>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-slate-950 p-4 text-xs font-mono text-emerald-100 ring-1 ring-slate-800">
                  {`# Linux
curl -L -o vpn-server https://github.com/vpnvpn/vpn-server/releases/latest/download/vpn-server-linux-amd64
chmod +x vpn-server

# macOS
curl -L -o vpn-server https://github.com/vpnvpn/vpn-server/releases/latest/download/vpn-server-darwin-amd64
chmod +x vpn-server`}
                </pre>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                2. Run the server
              </label>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-slate-950 p-4 text-xs font-mono text-emerald-100 ring-1 ring-slate-800">
                  {`sudo ./vpn-server run \\
  --api-url "${apiUrl}" \\
  --token "<YOUR_TOKEN_HERE>" \\
  --listen-port 51820 \\
  --admin-port 8080`}
                </pre>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Note: Requires root/administrator privileges to create network
                interfaces.
              </p>
            </div>
          </div>
        </div>

        {/* Systemd Service */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20 backdrop-blur">
          <div className="mb-4 flex items-center gap-2">
            <Server className="h-5 w-5 text-purple-400" />
            <h2 className="text-lg font-semibold text-slate-50">
              Systemd Service (Linux)
            </h2>
          </div>
          <p className="mb-4 text-sm text-slate-400">
            Run as a systemd service for automatic restarts and management
          </p>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Create systemd service file
              </label>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-slate-950 p-4 text-xs font-mono text-emerald-100 ring-1 ring-slate-800">
                  {`sudo tee /etc/systemd/system/vpnvpn.service > /dev/null <<EOF
[Unit]
Description=vpnVPN Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vpnvpn
ExecStart=/opt/vpnvpn/vpn-server run \\
  --api-url "${apiUrl}" \\
  --token "<YOUR_TOKEN_HERE>" \\
  --listen-port 51820
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vpnvpn
sudo systemctl start vpnvpn`}
                </pre>
              </div>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 shadow-sm shadow-black/20">
          <h3 className="mb-2 text-sm font-semibold text-amber-100">
            Important Notes
          </h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-amber-50/90">
            <li>
              Ensure ports 51820 (UDP) and 8080 (TCP) are open in your firewall
            </li>
            <li>
              The server will automatically register with the control plane on
              startup
            </li>
            <li>Check server logs for any errors during startup</li>
            <li>
              Servers will appear in the Admin / Fleet view once registered
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
