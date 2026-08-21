import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · vpnVPN",
  description:
    "How vpnVPN handles your data, our no-logging policy, and your privacy rights.",
};

const LAST_UPDATED = "June 9, 2026";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-300">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="relative mx-auto max-w-3xl px-4 pb-20 pt-14 text-slate-50 sm:px-6">
      <div className="inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
        Legal · vpnVPN
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Privacy Policy
      </h1>
      <p className="mt-3 text-sm text-slate-400">
        Last updated: {LAST_UPDATED}
      </p>

      <p className="mt-6 text-sm leading-relaxed text-slate-300">
        This Privacy Policy explains what data vpnVPN (&ldquo;vpnVPN&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, why, and the choices you
        have. We built vpnVPN around a simple principle: a VPN should not become
        a record of your life. We keep the bare minimum needed to run the
        Service and never log your traffic.
      </p>

      <Section title="Our no-logging commitment">
        <p>
          We do <strong>not</strong> log or store: the websites you visit, your
          DNS queries, the contents of your traffic, your originating IP address
          tied to browsing, bandwidth-per-destination, or connection timestamps
          linked to activity. Our VPN nodes route encrypted traffic without
          recording it. This commitment is reflected in the aggregate, non-
          identifying metrics shown on our{" "}
          <Link
            href="/transparency"
            className="text-emerald-400 hover:text-emerald-300"
          >
            transparency page
          </Link>
          .
        </p>
      </Section>

      <Section title="Data we do collect">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Account data:</strong> your email address and, optionally,
            your display name. Authentication is handled via magic-link email,
            one-time codes, or OAuth providers (GitHub, Google); we store the
            provider account identifiers needed to sign you in.
          </li>
          <li>
            <strong>Device records:</strong> the public keys, device names, and
            assigned tunnel IPs for devices you register, so we can provision
            and revoke VPN access. We never store device private keys.
          </li>
          <li>
            <strong>Billing data:</strong> subscription status, plan, and
            billing period. Card details are handled entirely by Stripe; we
            store only a Stripe customer identifier and never see your full card
            number.
          </li>
          <li>
            <strong>Notification preferences:</strong> your choices for
            marketing, transactional, and security emails.
          </li>
          <li>
            <strong>Operational metrics:</strong> aggregate, non-identifying
            fleet health data (server load, online status, total session counts)
            that contains no user-identifying information.
          </li>
        </ul>
      </Section>

      <Section title="How we use your data">
        <p>
          We use the data above to: authenticate you and operate your account;
          provision, configure, and revoke your VPN devices; process payments
          and manage subscriptions; send service communications; and protect the
          Service against abuse and fraud. We do not sell your personal data.
        </p>
      </Section>

      <Section title="Service providers (sub-processors)">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Stripe</strong> — payment processing and billing.
          </li>
          <li>
            <strong>Resend</strong> — transactional and account email delivery.
          </li>
          <li>
            <strong>OAuth providers (GitHub, Google)</strong> — optional
            sign-in, used only if you choose them.
          </li>
        </ul>
        <p>
          These providers process data on our behalf under their own data
          protection commitments and only to deliver their function.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          We use cookies strictly to keep you signed in: a session cookie that
          holds your authentication token. We do not use advertising or
          cross-site tracking cookies. Clearing this cookie signs you out.
        </p>
      </Section>

      <Section title="Email communications">
        <p>
          You control which emails you receive from your account&rsquo;s
          notification preferences (marketing, transactional, and security
          categories). Certain messages are essential to the Service and are
          always sent regardless of preferences: sign-in links and one-time
          codes (without them you could not log in) and payment-failure notices
          (so you do not unexpectedly lose access).
        </p>
      </Section>

      <Section title="Data retention and deletion">
        <p>
          We retain account, device, and billing metadata for as long as your
          account is active. You can permanently delete your account at any time
          from your account settings; deletion revokes all VPN access, cancels
          any active subscription, and erases your stored data. We may retain
          limited billing records where required by law (for example, tax and
          accounting obligations).
        </p>
      </Section>

      <Section title="Your privacy rights (including GDPR)">
        <p>
          Depending on where you live, you have rights to access, correct,
          export, restrict, or delete your personal data, and to object to
          certain processing. vpnVPN supports these directly:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Access &amp; portability:</strong> export a complete copy of
            your account data as JSON from your account settings.
          </li>
          <li>
            <strong>Erasure:</strong> delete your account and all associated
            data from your account settings.
          </li>
          <li>
            <strong>Rectification:</strong> update your profile details at any
            time.
          </li>
        </ul>
        <p>
          To exercise any other right, or if you have a complaint, contact us
          using the details below. EU/EEA users also have the right to lodge a
          complaint with their local data protection authority.
        </p>
      </Section>

      <Section title="Children">
        <p>
          The Service is not directed to children under 16, and we do not
          knowingly collect their personal data. If you believe a child has
          provided us data, contact us and we will delete it.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this Privacy Policy from time to time. We will revise
          the &ldquo;last updated&rdquo; date above and, for material changes,
          notify you by email or in-product.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          For privacy questions or to exercise your rights, email{" "}
          <a
            href="mailto:privacy@vpnvpn.dev"
            className="text-emerald-400 hover:text-emerald-300"
          >
            privacy@vpnvpn.dev
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
