"use server";

import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { WEB_ENV } from "@/env";

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(WEB_ENV.RESEND_API_KEY);
  }
  return _resend;
}

function getFromEmail() {
  return WEB_ENV.EMAIL_FROM;
}
function getBaseUrl() {
  return WEB_ENV.NEXTAUTH_URL;
}

export type EmailTemplate =
  | "welcome"
  | "magic_link"
  | "otp_code"
  | "subscription_active"
  | "subscription_cancelled"
  | "payment_failed"
  | "payment_receipt"
  | "device_added"
  | "device_revoked";

interface EmailContext {
  to: string;
  template: EmailTemplate;
  data: Record<string, any>;
}

// Maps each template to a NotificationPreferences category, or marks it as
// always-send. Always-send templates bypass user preferences because skipping
// them would break a critical flow:
//   - magic_link / otp_code: skipping breaks authentication entirely.
//   - payment_failed: billing-critical dunning. A user who silenced this could
//     lose access without warning; legitimate-interest transactional mail.
// Everything else respects the matching preference toggle.
type PreferenceCategory = "marketing" | "transactional" | "security";

const TEMPLATE_PREFERENCE: Record<
  EmailTemplate,
  PreferenceCategory | "always"
> = {
  welcome: "marketing",
  magic_link: "always",
  otp_code: "always",
  subscription_active: "transactional",
  subscription_cancelled: "transactional",
  payment_failed: "always",
  // Receipts are informational, not dunning — they honor the billing-emails
  // (transactional) preference like subscription_active does.
  payment_receipt: "transactional",
  device_added: "security",
  device_revoked: "security",
};

// Returns true if this email should be suppressed for the recipient based on
// their stored notification preferences. Always-send templates are never
// suppressed. If preferences can't be resolved (no row, lookup error), we
// default to sending — opt-out, not opt-in. Categories default to `true`
// (enabled) to match the schema defaults and the account UI.
async function isSuppressedByPreferences(
  to: string,
  template: EmailTemplate,
): Promise<boolean> {
  const category = TEMPLATE_PREFERENCE[template];
  if (category === "always") return false;

  try {
    const user = await prisma.user.findUnique({
      where: { email: to },
      select: { notificationPreferences: { select: { [category]: true } } },
    });
    const prefs = user?.notificationPreferences as
      | Record<PreferenceCategory, boolean>
      | null
      | undefined;
    if (!prefs) return false; // no preferences row → send by default
    return prefs[category] === false;
  } catch (error) {
    console.error("[email] preference lookup failed; sending anyway", {
      template,
      to,
      error,
    });
    return false;
  }
}

// Shared email wrapper with vpnVPN branding
function emailWrapper(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vpnVPN</title>
</head>
<body style="margin:0;padding:0;background-color:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#020617;min-height:100vh;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:32px;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#10b981 0%,#14b8a6 100%);border-radius:16px;padding:16px;">
                    <img src="https://vpnvpn.dev/shield-icon.png" alt="vpnVPN" width="32" height="32" style="display:block;" onerror="this.style.display='none'">
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:20px;font-weight:700;color:#f8fafc;letter-spacing:-0.025em;">vpnVPN</p>
            </td>
          </tr>
          
          <!-- Card -->
          <tr>
            <td style="background-color:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:32px;">
              ${content}
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:32px;">
              <p style="margin:0;font-size:12px;color:#64748b;">
                © ${new Date().getFullYear()} vpnVPN. All rights reserved.
              </p>
              <p style="margin:8px 0 0;font-size:12px;color:#475569;">
                Secure, private, no-logging VPN service.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Primary button style
const buttonStyle = `
  display:inline-block;
  background:linear-gradient(135deg,#10b981 0%,#14b8a6 100%);
  color:#ffffff;
  font-size:14px;
  font-weight:600;
  text-decoration:none;
  padding:14px 28px;
  border-radius:8px;
  text-align:center;
`.replace(/\s+/g, "");

// Secondary button style
const secondaryButtonStyle = `
  display:inline-block;
  background-color:#1e293b;
  color:#e2e8f0;
  font-size:14px;
  font-weight:500;
  text-decoration:none;
  padding:12px 24px;
  border-radius:8px;
  border:1px solid #334155;
  text-align:center;
`.replace(/\s+/g, "");

function buildEmailContent(
  template: EmailTemplate,
  data: Record<string, any>,
): { subject: string; html: string; text: string } {
  switch (template) {
    case "welcome": {
      const name = data.name || "there";
      const dashboardUrl = data.dashboardUrl || `${getBaseUrl()}/dashboard`;

      const content = `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;">Welcome to vpnVPN!</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;">
          Hi ${name}, thank you for signing up! Your account has been created successfully.
        </p>
        
        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#10b981;text-transform:uppercase;letter-spacing:0.05em;">Getting Started</p>
          <ul style="margin:0;padding:0 0 0 16px;color:#cbd5e1;font-size:14px;line-height:1.8;">
            <li>Subscribe to a plan that fits your needs</li>
            <li>Add your first device to get connected</li>
            <li>Enjoy secure, private browsing</li>
          </ul>
        </div>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${dashboardUrl}" style="${buttonStyle}">Go to Dashboard</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "Welcome to vpnVPN",
        html: emailWrapper(content),
        text: `Welcome to vpnVPN!\n\nHi ${name}, thank you for signing up! Your account has been created successfully.\n\nGetting Started:\n- Subscribe to a plan that fits your needs\n- Add your first device to get connected\n- Enjoy secure, private browsing\n\nGo to Dashboard: ${dashboardUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "magic_link": {
      const url = data.url as string;
      const desktopCode = (data.desktopCode as string | undefined) || "";
      const name = data.name || "there";

      // Desktop flows: send a code-only email
      if (desktopCode) {
        const content = `
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;">Your Sign-in Code</h1>
          <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;">
            Hi ${name}, use this code to sign in to the vpnVPN desktop app.
          </p>
          
          <div style="background-color:#020617;border:2px solid #1e293b;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
            <p style="margin:0;font-size:36px;font-weight:700;font-family:'SF Mono',Monaco,'Courier New',monospace;letter-spacing:0.3em;color:#10b981;">${desktopCode}</p>
          </div>
          
          <div style="background-color:#1e293b;border-radius:8px;padding:16px;margin-bottom:0;">
            <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5;">
              ⏱️ This code expires in <strong style="color:#f8fafc;">15 minutes</strong> and can only be used once.<br>
              🔒 If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        `;

        return {
          subject: "Your vpnVPN sign-in code",
          html: emailWrapper(content),
          text: `Your vpnVPN Sign-in Code\n\nHi ${name}, use this code to sign in to the vpnVPN desktop app:\n\n${desktopCode}\n\nThis code expires in 15 minutes and can only be used once.\nIf you didn't request this, you can safely ignore this email.\n\n© ${new Date().getFullYear()} vpnVPN`,
        };
      }

      // Web flows: magic link email
      const content = `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;">Sign in to vpnVPN</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;">
          Hi ${name}, click the button below to securely sign in to your account.
        </p>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
          <tr>
            <td align="center">
              <a href="${url}" style="${buttonStyle}">Sign In to vpnVPN</a>
            </td>
          </tr>
        </table>
        
        <div style="background-color:#1e293b;border-radius:8px;padding:16px;">
          <p style="margin:0 0 8px;font-size:12px;color:#64748b;">Or copy and paste this link:</p>
          <p style="margin:0;font-size:12px;color:#94a3b8;word-break:break-all;">${url}</p>
        </div>
        
        <p style="margin:24px 0 0;font-size:13px;color:#64748b;line-height:1.5;">
          This link expires shortly. If you didn't request this, you can safely ignore this email.
        </p>
      `;

      return {
        subject: "Sign in to vpnVPN",
        html: emailWrapper(content),
        text: `Sign in to vpnVPN\n\nHi ${name}, click the link below to securely sign in to your account:\n\n${url}\n\nThis link expires shortly. If you didn't request this, you can safely ignore this email.\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "otp_code": {
      const code = data.code as string;
      const expiresMinutes = (data.expiresMinutes as number) || 10;

      const content = `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;">Your Verification Code</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;">
          Use this code to sign in to the vpnVPN desktop app.
        </p>
        
        <div style="background-color:#020617;border:2px solid #10b981;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px;">
          <p style="margin:0;font-size:40px;font-weight:700;font-family:'SF Mono',Monaco,'Courier New',monospace;letter-spacing:0.4em;color:#10b981;">${code}</p>
        </div>
        
        <div style="background-color:#1e293b;border-radius:8px;padding:16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td width="24" valign="top" style="padding-right:12px;">
                <span style="font-size:16px;">⏱️</span>
              </td>
              <td style="font-size:13px;color:#94a3b8;line-height:1.5;">
                Expires in <strong style="color:#f8fafc;">${expiresMinutes} minutes</strong>
              </td>
            </tr>
            <tr>
              <td width="24" valign="top" style="padding-right:12px;padding-top:8px;">
                <span style="font-size:16px;">🔒</span>
              </td>
              <td style="font-size:13px;color:#94a3b8;line-height:1.5;padding-top:8px;">
                Can only be used <strong style="color:#f8fafc;">once</strong>
              </td>
            </tr>
          </table>
        </div>
        
        <p style="margin:24px 0 0;font-size:13px;color:#64748b;text-align:center;">
          Didn't request this code? You can safely ignore this email.
        </p>
      `;

      return {
        subject: "Your vpnVPN verification code",
        html: emailWrapper(content),
        text: `Your vpnVPN Verification Code\n\nUse this code to sign in to the vpnVPN desktop app:\n\n${code}\n\n• Expires in ${expiresMinutes} minutes\n• Can only be used once\n\nDidn't request this code? You can safely ignore this email.\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "subscription_active": {
      const name = data.name || "there";
      const plan = data.plan || "Pro";
      const deviceLimit = data.deviceLimit || "5";
      // Enterprise uses 999 as an "effectively unlimited" sentinel — render it
      // the way the pricing page does instead of "999 devices".
      const deviceLimitDisplay =
        Number(deviceLimit) >= 999
          ? "Unlimited devices"
          : `${deviceLimit} devices`;
      const nextBillingDate = data.nextBillingDate || "N/A";
      const dashboardUrl = data.dashboardUrl || `${getBaseUrl()}/dashboard`;

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#10b981;color:#020617;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">Subscription Active</span>
        </div>
        
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">You're All Set!</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, your <strong style="color:#10b981;">${plan}</strong> subscription is now active.
        </p>
        
        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #334155;">
                <span style="font-size:13px;color:#64748b;">Plan</span>
              </td>
              <td align="right" style="padding:8px 0;border-bottom:1px solid #334155;">
                <span style="font-size:14px;font-weight:600;color:#f8fafc;">${plan}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #334155;">
                <span style="font-size:13px;color:#64748b;">Device Limit</span>
              </td>
              <td align="right" style="padding:8px 0;border-bottom:1px solid #334155;">
                <span style="font-size:14px;font-weight:600;color:#f8fafc;">${deviceLimitDisplay}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;">
                <span style="font-size:13px;color:#64748b;">Next Billing</span>
              </td>
              <td align="right" style="padding:8px 0;">
                <span style="font-size:14px;font-weight:600;color:#f8fafc;">${nextBillingDate}</span>
              </td>
            </tr>
          </table>
        </div>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${dashboardUrl}" style="${buttonStyle}">Add Your First Device</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "Your vpnVPN subscription is active",
        html: emailWrapper(content),
        text: `Your vpnVPN Subscription is Active\n\nHi ${name}, your ${plan} subscription is now active!\n\nPlan: ${plan}\nDevice Limit: ${deviceLimitDisplay}\nNext Billing: ${nextBillingDate}\n\nAdd Your First Device: ${dashboardUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "subscription_cancelled": {
      const name = data.name || "there";
      const pricingUrl = data.pricingUrl || `${getBaseUrl()}/pricing`;

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#f59e0b;color:#020617;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">Subscription Cancelled</span>
        </div>
        
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">We're Sorry to See You Go</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, your vpnVPN subscription has been cancelled.
        </p>
        
        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;">
          <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
            <strong style="color:#f8fafc;">What happens now:</strong>
          </p>
          <ul style="margin:12px 0 0;padding:0 0 0 16px;color:#94a3b8;font-size:14px;line-height:1.8;">
            <li>Your VPN access has been disabled</li>
            <li>All connected devices have been disconnected</li>
            <li>Your account remains active for future resubscription</li>
          </ul>
        </div>
        
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;text-align:center;">
          Changed your mind? You can resubscribe anytime.
        </p>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${pricingUrl}" style="${secondaryButtonStyle}">View Plans</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "Your vpnVPN subscription has been cancelled",
        html: emailWrapper(content),
        text: `Your vpnVPN Subscription Has Been Cancelled\n\nHi ${name}, your vpnVPN subscription has been cancelled.\n\nWhat happens now:\n- Your VPN access has been disabled\n- All connected devices have been disconnected\n- Your account remains active for future resubscription\n\nChanged your mind? You can resubscribe anytime.\n\nView Plans: ${pricingUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "payment_failed": {
      const name = data.name || "there";
      const billingUrl = data.billingUrl || `${getBaseUrl()}/account`;
      const amount = data.amount as string | undefined;

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#ef4444;color:#ffffff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">Payment Failed</span>
        </div>

        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">We Couldn't Process Your Payment</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, we were unable to charge your payment method${amount ? ` for ${amount}` : ""}. To keep your vpnVPN subscription active, please update your billing details.
        </p>

        <div style="background-color:#0f172a;border:1px solid #ef4444;border-radius:8px;padding:16px;margin-bottom:24px;">
          <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.5;">
            ⚠️ <strong>Action required:</strong> If payment isn't received soon, your VPN access may be suspended. We'll retry automatically, but updating your card now avoids any interruption.
          </p>
        </div>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${billingUrl}" style="${buttonStyle}">Update Payment Method</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "Action required: your vpnVPN payment failed",
        html: emailWrapper(content),
        text: `Payment Failed\n\nHi ${name}, we were unable to charge your payment method${amount ? ` for ${amount}` : ""}. To keep your vpnVPN subscription active, please update your billing details.\n\n⚠️ Action required: If payment isn't received soon, your VPN access may be suspended. We'll retry automatically, but updating your card now avoids any interruption.\n\nUpdate Payment Method: ${billingUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "payment_receipt": {
      const name = data.name || "there";
      const plan = data.plan as string | undefined;
      const amount = data.amount as string | undefined;
      const invoiceNumber = data.invoiceNumber as string | undefined;
      const hostedInvoiceUrl = data.hostedInvoiceUrl as string | undefined;
      const invoicePdf = data.invoicePdf as string | undefined;
      const billingUrl = data.billingUrl || `${getBaseUrl()}/account`;
      const invoiceUrl = hostedInvoiceUrl || billingUrl;

      const rows = [
        amount ? { label: "Amount Paid", value: amount } : null,
        plan ? { label: "Plan", value: plan } : null,
        invoiceNumber ? { label: "Invoice", value: invoiceNumber } : null,
      ].filter((row): row is { label: string; value: string } => row !== null);

      const rowsHtml = rows
        .map(
          (row, idx) => `
            <tr>
              <td style="padding:8px 0;${idx < rows.length - 1 ? "border-bottom:1px solid #334155;" : ""}">
                <span style="font-size:13px;color:#64748b;">${row.label}</span>
              </td>
              <td align="right" style="padding:8px 0;${idx < rows.length - 1 ? "border-bottom:1px solid #334155;" : ""}">
                <span style="font-size:14px;font-weight:600;color:#f8fafc;">${row.value}</span>
              </td>
            </tr>`,
        )
        .join("");

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#10b981;color:#020617;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">Payment Received</span>
        </div>

        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">Thanks for Your Payment</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, we've received your payment${amount ? ` of <strong style="color:#10b981;">${amount}</strong>` : ""}${plan ? ` for your <strong style="color:#f8fafc;">${plan}</strong> plan` : ""}. No action is needed.
        </p>

        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rowsHtml}
          </table>
        </div>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${invoiceUrl}" style="${buttonStyle}">View Invoice</a>
            </td>
          </tr>
          ${
            invoicePdf
              ? `<tr>
            <td align="center" style="padding-top:12px;">
              <a href="${invoicePdf}" style="${secondaryButtonStyle}">Download PDF</a>
            </td>
          </tr>`
              : ""
          }
        </table>
      `;

      const textLines = [
        "Payment Received",
        "",
        `Hi ${name}, we've received your payment${amount ? ` of ${amount}` : ""}${plan ? ` for your ${plan} plan` : ""}. No action is needed.`,
        "",
        ...rows.map((row) => `${row.label}: ${row.value}`),
        "",
        `View Invoice: ${invoiceUrl}`,
        ...(invoicePdf ? [`Download PDF: ${invoicePdf}`] : []),
        "",
        `© ${new Date().getFullYear()} vpnVPN`,
      ];

      return {
        subject: "Your vpnVPN payment receipt",
        html: emailWrapper(content),
        text: textLines.join("\n"),
      };
    }

    case "device_added": {
      const name = data.name || "there";
      const deviceName = data.deviceName || "Unknown Device";
      const dashboardUrl = data.dashboardUrl || `${getBaseUrl()}/dashboard`;

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#10b981;color:#020617;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">New Device</span>
        </div>
        
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">Device Added</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, a new device has been added to your vpnVPN account.
        </p>
        
        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Device Name</p>
          <p style="margin:0;font-size:18px;font-weight:600;color:#f8fafc;">${deviceName}</p>
        </div>
        
        <div style="background-color:#0f172a;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin-bottom:24px;">
          <p style="margin:0;font-size:13px;color:#fbbf24;line-height:1.5;">
            ⚠️ <strong>Security Notice:</strong> If you didn't add this device, please review your account security and revoke any unknown devices immediately.
          </p>
        </div>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${dashboardUrl}" style="${buttonStyle}">View Devices</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "New device added to your vpnVPN account",
        html: emailWrapper(content),
        text: `Device Added to Your vpnVPN Account\n\nHi ${name}, a new device has been added to your vpnVPN account.\n\nDevice Name: ${deviceName}\n\n⚠️ Security Notice: If you didn't add this device, please review your account security and revoke any unknown devices immediately.\n\nView Devices: ${dashboardUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    case "device_revoked": {
      const name = data.name || "there";
      const deviceName = data.deviceName || "Unknown Device";
      const dashboardUrl = data.dashboardUrl || `${getBaseUrl()}/dashboard`;

      const content = `
        <div style="text-align:center;margin-bottom:24px;">
          <span style="display:inline-block;background-color:#ef4444;color:#ffffff;font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;">Device Removed</span>
        </div>
        
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#f8fafc;text-align:center;">Device Removed</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.6;text-align:center;">
          Hi ${name}, a device has been removed from your vpnVPN account.
        </p>
        
        <div style="background-color:#1e293b;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Device Name</p>
          <p style="margin:0;font-size:18px;font-weight:600;color:#f8fafc;">${deviceName}</p>
        </div>
        
        <div style="background-color:#0f172a;border:1px solid #ef4444;border-radius:8px;padding:16px;margin-bottom:24px;">
          <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.5;">
            🔒 <strong>Security Notice:</strong> If you didn't remove this device, please review your account security immediately and consider changing your password.
          </p>
        </div>
        
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td align="center">
              <a href="${dashboardUrl}" style="${buttonStyle}">View Account</a>
            </td>
          </tr>
        </table>
      `;

      return {
        subject: "Device removed from your vpnVPN account",
        html: emailWrapper(content),
        text: `Device Removed from Your vpnVPN Account\n\nHi ${name}, a device has been removed from your vpnVPN account.\n\nDevice Name: ${deviceName}\n\n🔒 Security Notice: If you didn't remove this device, please review your account security immediately and consider changing your password.\n\nView Account: ${dashboardUrl}\n\n© ${new Date().getFullYear()} vpnVPN`,
      };
    }

    default:
      throw new Error(`Unknown email template: ${template}`);
  }
}

export async function sendEmail(context: EmailContext): Promise<void> {
  // Respect the recipient's notification preferences (auth- and billing-
  // critical templates always send — see TEMPLATE_PREFERENCE).
  if (await isSuppressedByPreferences(context.to, context.template)) {
    return;
  }

  try {
    const content = buildEmailContent(context.template, context.data);

    await getResend().emails.send({
      from: getFromEmail(),
      to: context.to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  } catch (error) {
    console.error("[email] Failed to send", {
      template: context.template,
      to: context.to,
      error,
    });
    // Propagate failures for auth emails so they can fail visibly;
    // keep other templates as soft-fail to avoid breaking non-critical flows.
    if (context.template === "magic_link" || context.template === "otp_code") {
      throw error instanceof Error
        ? error
        : new Error("Failed to send authentication email");
    }
  }
}
