import { z } from "zod";
import { router, paidProcedure } from "../init";
import { rateLimit } from "../rateLimit";
import { WEB_ENV } from "@/env";
import { TRPCError } from "@trpc/server";
import { addPeerForDevice, revokePeerByPublicKey } from "@/lib/controlPlane";
import { allocateDeviceIp } from "@/lib/networking";
import { getTierConfig } from "@/lib/tiers";
import { sendEmail } from "@/lib/email";
import { revalidatePath } from "next/cache";
import nacl from "tweetnacl";
import { randomUUID, randomBytes } from "node:crypto";

/**
 * Generate a WireGuard-compatible keypair using wg genkey.
 * This ensures keys are in the exact format WireGuard expects.
 *
 * Security note: Private keys are generated server-side and transmitted
 * to the client over HTTPS. The server does NOT store private keys.
 * For maximum security, consider generating keys client-side in the
 * desktop app using system wg genkey when available.
 */
async function generateWireGuardKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const { execSync } = await import("child_process");

  try {
    // Use wg genkey for proper WireGuard key format
    const privateKey = execSync("wg genkey", { encoding: "utf-8" }).trim();
    // Derive public key from private key
    const publicKey = execSync("wg pubkey", {
      encoding: "utf-8",
      input: privateKey,
    }).trim();

    return { publicKey, privateKey };
  } catch (error) {
    // Fallback to NaCl if wg command is not available (e.g., in Docker)
    console.warn(
      "[device] wg genkey not available, falling back to NaCl key generation",
      error,
    );
    // Match `wg genkey` semantics exactly: clamp the random scalar (RFC 7748)
    // BEFORE storing it and deriving the public key. X25519 implementations
    // (including nacl.scalarMult and WireGuard itself) clamp internally during
    // multiplication, so an unclamped key would still interoperate — but the
    // private key we emit into downloadable configs should be a canonical,
    // already-clamped scalar exactly like wg genkey produces.
    const privateKeyBytes = nacl.randomBytes(32);
    privateKeyBytes[0] &= 248;
    privateKeyBytes[31] &= 127;
    privateKeyBytes[31] |= 64;
    const publicKeyBytes = nacl.scalarMult.base(privateKeyBytes);
    // 32 bytes always base64-encode to 44 chars (with '=' padding), matching
    // wg genkey output — no extra padding normalization needed.
    return {
      publicKey: Buffer.from(publicKeyBytes).toString("base64"),
      privateKey: Buffer.from(privateKeyBytes).toString("base64"),
    };
  }
}

function buildWireguardConfig(params: {
  server: any;
  assignedIp: string;
  privateKey: string;
}) {
  const { server, assignedIp, privateKey } = params;
  const endpointHost = server.wgEndpoint || server.publicIp;
  const port =
    server.wgPort ??
    (server.metadata as any)?.listenPort ??
    (server.metadata as any)?.port ??
    51820;
  if (!endpointHost || !server.publicKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Server missing WireGuard endpoint or public key",
    });
  }

  const address = assignedIp.includes("/") ? assignedIp : `${assignedIp}/32`;
  const endpoint = `${endpointHost}:${port}`;

  return [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    "DNS = 1.1.1.1, 1.0.0.1",
    "",
    "[Peer]",
    `PublicKey = ${server.publicKey}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${endpoint}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function buildOpenVpnConfig(params: {
  server: any;
  assignedIp: string;
  serverName: string;
}) {
  const { server, assignedIp, serverName } = params;
  const endpoint = server.ovpnEndpoint || server.publicIp;
  const port =
    server.ovpnPort ??
    (server.metadata as any)?.listenPort ??
    (server.metadata as any)?.port ??
    1194;

  if (!endpoint) {
    return null;
  }

  const caBundle = server.ovpnCaBundle ?? null;
  const peerFingerprint = server.ovpnPeerFingerprint ?? null;
  if (!caBundle && !peerFingerprint) {
    return null;
  }

  const lines = [
    "client",
    "dev tun",
    "proto udp",
    `remote ${endpoint} ${port}`,
    "resolv-retry infinite",
    "nobind",
    "persist-key",
    "persist-tun",
    "remote-cert-tls server",
    peerFingerprint
      ? `peer-fingerprint ${peerFingerprint}`
      : "# peer-fingerprint <hex>",
    "cipher AES-256-GCM",
    "data-ciphers AES-256-GCM:CHACHA20-POLY1305",
    "tls-version-min 1.2",
    "auth-user-pass vpnvpn-auth.txt",
    "auth SHA256",
    "verb 3",
    `# Assigned IP hint: ${assignedIp}`,
    `# Server: ${serverName}`,
    "",
  ];

  if (caBundle) {
    lines.push("<ca>");
    lines.push(caBundle);
    lines.push("</ca>");
  }

  // Embed tls-crypt key if available (required by the server)
  const tlsCryptKey =
    server.tlsCryptKey ?? (server.metadata as any)?.tlsCryptKey ?? null;
  if (tlsCryptKey) {
    lines.push("<tls-crypt>");
    lines.push(tlsCryptKey);
    lines.push("</tls-crypt>");
  }

  return lines.join("\n");
}

function buildIkev2Config(params: {
  server: any;
  serverName: string;
  username?: string;
  password?: string;
}) {
  const { server, serverName, username, password } = params;
  const remote = server.ikev2Remote || server.publicIp;
  if (!remote) return null;
  // Strip port from remote if present (e.g. "1.2.3.4:500" → "1.2.3.4")
  const remoteHost = remote.includes(":") ? remote.split(":")[0] : remote;

  // The node ships the IKEv2 CA in metadata.ikev2CaBundle; fall back to the
  // OpenVPN CA bundle for older nodes that only set ovpnCaBundle.
  const caBundle =
    (server.metadata as any)?.ikev2CaBundle ?? server.ovpnCaBundle ?? null;

  const lines = [
    "# vpnVPN IKEv2 configuration (EAP-MSCHAPv2)",
    `# Remote gateway: ${remoteHost}`,
    "",
    "conn vpnvpn",
    "  keyexchange=ikev2",
    "  type=tunnel",
    "  left=%any",
    "  leftauth=eap-mschapv2",
    username ? `  eap_identity=${username}` : "  eap_identity=%identity",
    `  right=${remoteHost}`,
    `  rightid=${remoteHost}`,
    "  rightauth=pubkey",
    '  rightca="CN=vpnvpn-ca"',
    "  rightsubnet=0.0.0.0/0",
    "  ike=aes256-sha256-modp2048!",
    "  esp=aes256gcm128!",
    "  auto=add",
    `# Server: ${serverName}`,
    "",
  ];

  if (caBundle) {
    lines.push("# CA certificate (save as /etc/ipsec.d/cacerts/ca.pem):");
    lines.push(`# ${caBundle.replace(/\n/g, "\n# ")}`);
  }

  if (username && password) {
    lines.push(`# Secrets (add to /etc/ipsec.secrets):`);
    lines.push(`# ${username} : EAP "${password}"`);
  }

  return lines.join("\n");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Extract the base64-DER body from a PEM certificate (PEM is base64-DER wrapped
// in header/footer lines). Returns null if no certificate block is present.
function pemToBase64Der(pem: string): string | null {
  const m = pem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
  );
  return m ? m[1].replace(/\s+/g, "") : null;
}

// Build an Apple .mobileconfig profile for native IKEv2/IPsec (EAP-MSCHAPv2).
// Importable on macOS and iOS WITHOUT the desktop app or strongSwan: the user
// downloads it from the web dashboard and opens it. If the node's IKEv2 CA is
// available it is embedded as a trusted root so the self-signed server
// certificate validates automatically; otherwise macOS prompts to trust it on
// first connect. Returns null if the server exposes no IKEv2 endpoint.
function buildAppleMobileConfig(params: {
  server: any;
  username: string;
  password: string;
}): string | null {
  const { server, username, password } = params;
  const remote = server.ikev2Remote || server.publicIp;
  if (!remote) return null;
  const remoteHost = remote.includes(":") ? remote.split(":")[0] : remote;
  const caPem =
    (server.metadata as any)?.ikev2CaBundle ?? server.ovpnCaBundle ?? null;
  const caDer = caPem ? pemToBase64Der(caPem) : null;

  const vpnUuid = randomUUID().toUpperCase();
  const profileUuid = randomUUID().toUpperCase();
  const caUuid = randomUUID().toUpperCase();

  const certPayload = caDer
    ? `        <dict>
            <key>PayloadType</key>
            <string>com.apple.security.root</string>
            <key>PayloadIdentifier</key>
            <string>com.vpnvpn.ikev2.ca</string>
            <key>PayloadUUID</key>
            <string>${caUuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadDisplayName</key>
            <string>vpnVPN CA</string>
            <key>PayloadContent</key>
            <data>${caDer}</data>
        </dict>
`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
${certPayload}        <dict>
            <key>IKEv2</key>
            <dict>
                <key>AuthenticationMethod</key>
                <string>None</string>
                <key>ExtendedAuthEnabled</key>
                <integer>1</integer>
                <key>AuthName</key>
                <string>${xmlEscape(username)}</string>
                <key>AuthPassword</key>
                <string>${xmlEscape(password)}</string>
                <key>RemoteAddress</key>
                <string>${xmlEscape(remoteHost)}</string>
                <key>RemoteIdentifier</key>
                <string>${xmlEscape(remoteHost)}</string>
                <key>ServerCertificateIssuerCommonName</key>
                <string>vpnvpn-ca</string>
                <key>UseConfigurationAttributeInternalIPSubnet</key>
                <integer>0</integer>
            </dict>
            <key>PayloadDisplayName</key>
            <string>vpnVPN IKEv2</string>
            <key>PayloadIdentifier</key>
            <string>com.vpnvpn.ikev2.vpn</string>
            <key>PayloadType</key>
            <string>com.apple.vpn.managed</string>
            <key>PayloadUUID</key>
            <string>${vpnUuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>VPNType</key>
            <string>IKEv2</string>
            <key>UserDefinedName</key>
            <string>vpnVPN</string>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>vpnVPN IKEv2</string>
    <key>PayloadIdentifier</key>
    <string>com.vpnvpn.ikev2</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${profileUuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
`;
}

export const deviceRouter = router({
  list: paidProcedure.query(async ({ ctx }) => {
    const devices = await ctx.prisma.device.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
    });
    return devices;
  }),

  // Generate downloadable VPN configuration profiles for an existing device so
  // it can be used with ANY third-party client (WireGuard, OpenVPN, or native
  // IKEv2 via an Apple .mobileconfig) — no desktop app required.
  //
  // Because the device's WireGuard private key is never stored server-side,
  // this rotates the device's keypair and EAP credentials and re-registers the
  // peer, then returns a fresh, consistent set of configs. Any previously
  // downloaded profile for this device is therefore invalidated.
  getConfigs: paidProcedure
    .use(rateLimit({ name: "device.getConfigs", limit: 10 }))
    .input(z.object({ deviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const device = await ctx.prisma.device.findUnique({
        where: { id: input.deviceId },
      });
      if (!device || device.userId !== ctx.userId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      }
      if (!device.serverId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Device has no assigned VPN server",
        });
      }

      const serverRecord = await ctx.prisma.vpnServer.findUnique({
        where: { id: device.serverId },
      });
      if (!serverRecord || !serverRecord.publicKey) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "VPN server unavailable",
        });
      }
      const serverMetadata =
        (serverRecord.metadata as Record<string, unknown> | null) || null;

      // Revoke the old peer and rotate keys/credentials so the downloaded
      // profiles actually work (the previous private key was never persisted).
      try {
        await revokePeerByPublicKey(device.publicKey);
      } catch {
        // Best-effort: a missing/stale peer is fine.
      }

      const keyPair = await generateWireGuardKeyPair();
      const username = device.id;
      const password = randomBytes(16).toString("hex");
      const assignedIp =
        device.assignedIp ??
        (await allocateDeviceIp(ctx.prisma, {
          serverId: device.serverId,
          deviceId: device.id,
        }));

      await ctx.prisma.device.update({
        where: { id: device.id },
        data: {
          publicKey: keyPair.publicKey,
          ...(device.assignedIp ? {} : { assignedIp }),
        },
      });

      try {
        await addPeerForDevice({
          publicKey: keyPair.publicKey,
          userId: ctx.userId,
          allowedIps: [assignedIp],
          serverId: device.serverId,
          username,
          password,
        });
      } catch (err) {
        console.error("[device] control-plane addPeer failed in getConfigs", {
          err,
          deviceId: device.id,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to provision device on the VPN server",
        });
      }

      const serverArg = { ...serverRecord, metadata: serverMetadata };
      return {
        deviceId: device.id,
        deviceName: device.name,
        assignedIp,
        wireguardConfig: buildWireguardConfig({
          server: serverArg,
          assignedIp,
          privateKey: keyPair.privateKey,
        }),
        openvpnConfig: buildOpenVpnConfig({
          server: serverArg,
          assignedIp,
          serverName: serverRecord.id,
        }),
        ikev2Config: buildIkev2Config({
          server: serverArg,
          serverName: serverRecord.id,
          username,
          password,
        }),
        appleMobileConfig: buildAppleMobileConfig({
          server: serverArg,
          username,
          password,
        }),
        vpnCredentials: { username, password },
      };
    }),

  // Step 1: Register device - creates or updates device and peer, but doesn't send email
  // Device starts in "pending" status until connection is confirmed
  // If machineId is provided and a device with that machineId already exists for
  // this user, the existing device is updated instead of creating a new one
  register: paidProcedure
    .use(rateLimit({ name: "device.register", limit: 10 }))
    .input(
      z.object({
        name: z.string().min(1),
        serverId: z.string().optional(),
        machineId: z.string().optional(),
        // Optional: if provided, use client-generated public key (more secure)
        // If not provided, generate keys server-side (for web clients)
        publicKey: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { name, serverId, machineId } = input;

      if (!serverId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "serverId is required",
        });
      }

      // First check the local DB
      let serverRecord = await ctx.prisma.vpnServer.findUnique({
        where: { id: serverId },
      });

      // If not in DB, fetch from control plane and upsert
      if (!serverRecord) {
        const base = WEB_ENV.CONTROL_PLANE_API_URL?.replace(/\/$/, "");
        const apiKey = WEB_ENV.CONTROL_PLANE_API_KEY;

        if (!base || !apiKey) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Control plane not configured",
          });
        }

        const res = await fetch(`${base}/servers`, {
          method: "GET",
          headers: { "x-api-key": apiKey },
          cache: "no-store",
        });

        if (!res.ok) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "VPN server not found or offline",
          });
        }

        const servers: any[] = await res.json();
        const cpServer = servers.find((s: any) => s.id === serverId);

        if (!cpServer) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "VPN server not found or offline",
          });
        }

        // Upsert the server into the local DB so future lookups work
        serverRecord = await ctx.prisma.vpnServer.upsert({
          where: { id: serverId },
          update: {
            publicIp: cpServer.publicIp || null,
            publicKey: cpServer.publicKey || null,
            wgEndpoint:
              cpServer.wgEndpoint || cpServer.metadata?.wgEndpoint || null,
            wgPort: cpServer.wgPort || cpServer.metadata?.wgPort || null,
            ovpnEndpoint:
              cpServer.ovpnEndpoint || cpServer.metadata?.ovpnEndpoint || null,
            ovpnPort: cpServer.ovpnPort || cpServer.metadata?.ovpnPort || null,
            ovpnCaBundle:
              cpServer.ovpnCaBundle || cpServer.metadata?.ovpnCaBundle || null,
            ovpnPeerFingerprint:
              cpServer.ovpnPeerFingerprint ||
              cpServer.metadata?.ovpnPeerFingerprint ||
              null,
            ikev2Remote:
              cpServer.ikev2Remote || cpServer.metadata?.ikev2Remote || null,
            status: cpServer.status || "online",
            lastSeen: cpServer.lastSeen
              ? new Date(cpServer.lastSeen)
              : new Date(),
            metadata: cpServer.metadata || {},
          },
          create: {
            id: serverId,
            publicIp: cpServer.publicIp || null,
            publicKey: cpServer.publicKey || null,
            wgEndpoint:
              cpServer.wgEndpoint || cpServer.metadata?.wgEndpoint || null,
            wgPort: cpServer.wgPort || cpServer.metadata?.wgPort || null,
            ovpnEndpoint:
              cpServer.ovpnEndpoint || cpServer.metadata?.ovpnEndpoint || null,
            ovpnPort: cpServer.ovpnPort || cpServer.metadata?.ovpnPort || null,
            ovpnCaBundle:
              cpServer.ovpnCaBundle || cpServer.metadata?.ovpnCaBundle || null,
            ovpnPeerFingerprint:
              cpServer.ovpnPeerFingerprint ||
              cpServer.metadata?.ovpnPeerFingerprint ||
              null,
            ikev2Remote:
              cpServer.ikev2Remote || cpServer.metadata?.ikev2Remote || null,
            status: cpServer.status || "online",
            lastSeen: cpServer.lastSeen
              ? new Date(cpServer.lastSeen)
              : new Date(),
            metadata: cpServer.metadata || {},
          },
        });
      }

      if (!serverRecord) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "VPN server not found or offline",
        });
      }

      if (!serverRecord.publicKey) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "VPN server is missing WireGuard public key",
        });
      }

      const serverMetadata =
        (serverRecord?.metadata as Record<string, unknown> | null) || null;
      const serverPort =
        (serverMetadata?.listenPort as number | undefined) ??
        (serverMetadata?.port as number | undefined);

      // Check if there's an existing device with this machineId
      let existingDevice = machineId
        ? await ctx.prisma.device.findFirst({
            where: {
              userId: ctx.userId,
              machineId,
            },
          })
        : null;

      // If device exists with this machineId, we'll update it instead of creating a new one
      // This prevents device limit issues when reconnecting from the same machine
      if (existingDevice) {
        // Revoke old peer and generate new keys
        try {
          await revokePeerByPublicKey(existingDevice.publicKey);
        } catch {
          // Ignore errors revoking old peer
        }

        const keyPair = await generateWireGuardKeyPair();
        const publicKey = keyPair.publicKey;
        const privateKey = keyPair.privateKey;

        // If the device is moving to a different server, drop its old IP so a
        // fresh one is allocated from the new server's pool.
        const serverChanged = existingDevice.serverId !== serverId;

        // Update existing device with new keys
        const device = await ctx.prisma.device.update({
          where: { id: existingDevice.id },
          data: {
            publicKey,
            name,
            serverId,
            status: "pending",
            ...(serverChanged ? { assignedIp: null } : {}),
          },
        });

        const assignedIp = await allocateDeviceIp(ctx.prisma, {
          serverId,
          deviceId: device.id,
        });

        // Generate fresh OpenVPN/IKEv2 credentials, exactly like the
        // new-device path. NEVER derive these from the WireGuard private key —
        // that would leak key material into downloadable profiles, and the
        // control plane would not know the credentials.
        const vpnUsername = device.id;
        const vpnPassword = randomBytes(16).toString("hex");

        // Register with control plane
        try {
          await addPeerForDevice({
            publicKey,
            userId: ctx.userId,
            allowedIps: [assignedIp],
            serverId,
            // Capture the generated credentials for the control plane to verify
            username: vpnUsername,
            password: vpnPassword,
          });
        } catch (err) {
          console.error(
            "[device] control-plane addPeer failed for existing device",
            {
              err,
              userId: ctx.userId,
              deviceId: device.id,
            },
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to register device with VPN server",
          });
        }

        const wireguardConfig = buildWireguardConfig({
          server: { ...serverRecord, metadata: serverMetadata },
          assignedIp,
          privateKey,
        });
        const openvpnConfig = buildOpenVpnConfig({
          server: { ...serverRecord, metadata: serverMetadata },
          assignedIp,
          serverName: serverRecord.id,
        });
        const ikev2Config = buildIkev2Config({
          server: { ...serverRecord, metadata: serverMetadata },
          serverName: serverRecord.id,
          username: vpnUsername,
          password: vpnPassword,
        });
        const appleMobileConfig = buildAppleMobileConfig({
          server: { ...serverRecord, metadata: serverMetadata },
          username: vpnUsername,
          password: vpnPassword,
        });

        return {
          deviceId: device.id,
          assignedIp,
          wireguardConfig,
          openvpnConfig,
          ikev2Config,
          appleMobileConfig,
          vpnCredentials: {
            username: vpnUsername,
            password: vpnPassword,
          },
        };
      }

      // No existing device found - create a new one.
      // First clean up any stale pending devices (older than 10 minutes) so
      // they neither count against the limit nor leak peers/IPs.
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const oldPendingDevices = await ctx.prisma.device.findMany({
        where: {
          userId: ctx.userId,
          status: "pending",
          createdAt: { lt: tenMinutesAgo },
        },
      });

      for (const oldDevice of oldPendingDevices) {
        try {
          await revokePeerByPublicKey(oldDevice.publicKey);
        } catch {
          // Ignore errors revoking old peers
        }
        await ctx.prisma.device.delete({ where: { id: oldDevice.id } });
      }

      // Enforce the tier device limit. Count ALL of the user's devices,
      // including still-pending ones (each holds a peer + tunnel IP), so the
      // limit can't be bypassed by rapidly creating pending devices.
      const tierConfig = getTierConfig(ctx.tier);
      const deviceCount = await ctx.prisma.device.count({
        where: { userId: ctx.userId },
      });

      if (deviceCount >= tierConfig.deviceLimit) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Device limit reached (${tierConfig.deviceLimit}). Please upgrade your plan or remove an existing device.`,
        });
      }

      const keyPair = await generateWireGuardKeyPair();
      const publicKey = keyPair.publicKey;
      const privateKey = keyPair.privateKey;

      // Create device in database with "pending" status
      const device = await ctx.prisma.device.create({
        data: {
          userId: ctx.userId,
          publicKey,
          name,
          machineId, // Store machineId for future reconnections
          serverId,
          status: "pending", // Will be updated to "active" when confirmed
        },
      });

      const assignedIp = await allocateDeviceIp(ctx.prisma, {
        serverId,
        deviceId: device.id,
      });

      // Generate OpenVPN/IKEv2 credentials
      const vpnUsername = device.id;
      const vpnPassword = randomBytes(16).toString("hex");

      // Register the device's peer with the control plane. Paid tiers allow
      // multiple simultaneous devices, so we do NOT revoke the user's other
      // peers here — per-device revocation happens when a device is removed.
      try {
        await addPeerForDevice({
          publicKey,
          userId: ctx.userId,
          allowedIps: [assignedIp],
          // Pass through server affinity so the control plane can record it.
          serverId,
          // Capture the generated credentials for the control plane to verify
          username: vpnUsername,
          password: vpnPassword,
        });
      } catch (err) {
        // Clean up the device if control plane registration fails
        await ctx.prisma.device.delete({ where: { id: device.id } });

        console.error("[device] control-plane addPeer failed", {
          err,
          userId: ctx.userId,
          deviceId: device.id,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to register device with VPN server",
        });
      }

      // NOTE: Email is NOT sent here. It will be sent when confirmConnection is called.

      const wireguardConfig = buildWireguardConfig({
        server: { ...serverRecord, metadata: serverMetadata },
        assignedIp,
        privateKey,
      });
      const openvpnConfig = buildOpenVpnConfig({
        server: { ...serverRecord, metadata: serverMetadata },
        assignedIp,
        serverName: serverRecord.id,
      });
      const ikev2Config = buildIkev2Config({
        server: { ...serverRecord, metadata: serverMetadata },
        serverName: serverRecord.id,
        username: vpnUsername,
        password: vpnPassword,
      });
      const appleMobileConfig = buildAppleMobileConfig({
        server: { ...serverRecord, metadata: serverMetadata },
        username: vpnUsername,
        password: vpnPassword,
      });

      return {
        deviceId: device.id,
        assignedIp,
        wireguardConfig,
        openvpnConfig,
        ikev2Config,
        appleMobileConfig,
        vpnCredentials: {
          username: vpnUsername,
          password: vpnPassword,
        },
      };
    }),

  // Step 2: Confirm connection - called after VPN connection is verified
  // Marks device as active and sends confirmation email
  confirmConnection: paidProcedure
    .input(z.object({ deviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const device = await ctx.prisma.device.findUnique({
        where: { id: input.deviceId },
      });

      if (!device) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Device not found",
        });
      }

      if (device.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Unauthorized",
        });
      }

      // Only update if still pending
      if (device.status === "pending") {
        await ctx.prisma.device.update({
          where: { id: device.id },
          data: {
            status: "active",
            lastConnectedAt: new Date(),
          },
        });

        // Send device added email only after successful connection
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.userId },
        });
        if (user?.email) {
          await sendEmail({
            to: user.email,
            template: "device_added",
            data: {
              name: user.name,
              deviceName: device.name,
              dashboardUrl: `${WEB_ENV.NEXTAUTH_URL}/devices`,
            },
          });
        }

        revalidatePath("/dashboard");
        revalidatePath("/devices");
      }

      return { success: true };
    }),

  // Cancel a pending connection - cleans up device that was never confirmed
  cancelConnection: paidProcedure
    .input(z.object({ deviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const device = await ctx.prisma.device.findUnique({
        where: { id: input.deviceId },
      });

      if (!device) {
        // Device might already be deleted, that's fine
        return { success: true };
      }

      if (device.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Unauthorized",
        });
      }

      // Only delete if still pending
      if (device.status === "pending") {
        try {
          await revokePeerByPublicKey(device.publicKey);
        } catch (err) {
          console.error("[device] control-plane revokePeer failed", {
            err,
            deviceId: input.deviceId,
          });
        }

        await ctx.prisma.device.delete({
          where: { id: device.id },
        });
      }

      return { success: true };
    }),

  revoke: paidProcedure
    .input(z.object({ deviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const device = await ctx.prisma.device.findUnique({
        where: { id: input.deviceId },
      });

      if (!device) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Device not found",
        });
      }

      if (device.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Unauthorized",
        });
      }

      // Revoke from control plane
      try {
        await revokePeerByPublicKey(device.publicKey);
      } catch (err) {
        console.error("[device] control-plane revokePeer failed", {
          err,
          deviceId: input.deviceId,
        });
        // Continue anyway to remove from DB
      }

      // Delete from database
      await ctx.prisma.device.delete({
        where: { id: input.deviceId },
      });

      // Send device revoked email (only for active devices, not pending ones)
      if (device.status !== "pending") {
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.userId },
        });
        if (user?.email) {
          await sendEmail({
            to: user.email,
            template: "device_revoked",
            data: {
              name: user.name,
              deviceName: device.name,
              dashboardUrl: `${WEB_ENV.NEXTAUTH_URL}/devices`,
            },
          });
        }
      }

      revalidatePath("/dashboard");
      revalidatePath("/devices");

      return { success: true };
    }),
});
