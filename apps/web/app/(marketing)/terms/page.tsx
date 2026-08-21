import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service · vpnVPN",
  description: "The terms that govern your use of the vpnVPN service.",
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

export default function TermsPage() {
  return (
    <main className="relative mx-auto max-w-3xl px-4 pb-20 pt-14 text-slate-50 sm:px-6">
      <div className="inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
        Legal · vpnVPN
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Terms of Service
      </h1>
      <p className="mt-3 text-sm text-slate-400">
        Last updated: {LAST_UPDATED}
      </p>

      <p className="mt-6 text-sm leading-relaxed text-slate-300">
        These Terms of Service (the &ldquo;Terms&rdquo;) form a binding
        agreement between you and vpnVPN (&ldquo;vpnVPN&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;) and govern your access to and use of
        our virtual private network service, websites, desktop applications, and
        APIs (together, the &ldquo;Service&rdquo;). By creating an account or
        using the Service, you agree to these Terms. If you do not agree, do not
        use the Service.
      </p>

      <Section title="1. Eligibility and accounts">
        <p>
          You must be at least 18 years old, or the age of majority in your
          jurisdiction, to use the Service. You are responsible for the activity
          that occurs under your account and for keeping your sign-in method
          (magic link, one-time code, or OAuth provider) secure. Notify us
          promptly of any unauthorized use.
        </p>
      </Section>

      <Section title="2. The Service">
        <p>
          vpnVPN provides encrypted network tunnels over WireGuard, OpenVPN, and
          IKEv2 across a fleet of VPN nodes. The number of devices you may
          connect simultaneously depends on your plan. The Free plan permits one
          device; paid plans permit more, as described on our{" "}
          <Link
            href="/pricing"
            className="text-emerald-400 hover:text-emerald-300"
          >
            pricing page
          </Link>
          .
        </p>
        <p>
          We operate a strict no-logging policy: we do not record your browsing
          history, DNS queries, traffic content, or connection-level activity
          logs. We retain only the minimal account and billing metadata needed
          to operate the Service, as detailed in our{" "}
          <Link
            href="/privacy"
            className="text-emerald-400 hover:text-emerald-300"
          >
            Privacy Policy
          </Link>
          . Aggregate, non-identifying fleet health metrics may be displayed on
          our{" "}
          <Link
            href="/transparency"
            className="text-emerald-400 hover:text-emerald-300"
          >
            transparency page
          </Link>
          .
        </p>
      </Section>

      <Section title="3. Acceptable use">
        <p>
          You agree not to use the Service to: (a) break any applicable law or
          regulation; (b) send spam, launch denial-of-service attacks, scan or
          intrude into systems you do not own, or distribute malware; (c)
          infringe intellectual property or privacy rights; (d) transmit
          material that sexually exploits minors; or (e) resell or share access
          beyond your plan&rsquo;s device limit. Because we do not log your
          traffic, enforcement is based on credible abuse reports, billing
          signals, and network-level abuse indicators. We may suspend or
          terminate accounts that violate this section.
        </p>
      </Section>

      <Section title="4. Subscriptions, billing, and payments">
        <p>
          Paid plans are billed in advance on a recurring basis through our
          payment processor, Stripe. By subscribing, you authorize us and Stripe
          to charge your payment method for the applicable fees until you
          cancel. You can cancel at any time from your account; cancellation
          takes effect at the end of the current billing period and you retain
          access until then. If a payment fails, we may retry the charge and
          will email you so you can update your payment details; continued
          failure may result in downgrade to the Free plan or suspension.
        </p>
        <p>
          Except where required by law, payments are non-refundable. If we
          materially reduce the Service you have paid for, we will offer a
          pro-rated refund or credit at our discretion.
        </p>
      </Section>

      <Section title="5. Plan changes and device limits">
        <p>
          You may upgrade or downgrade your plan at any time. When a change
          lowers your device limit below the number of devices currently
          registered, we will revoke your most recently added devices to bring
          you within the new limit, keeping your oldest registered devices
          connected. Revoked devices lose VPN access immediately and must be
          re-added if you upgrade again.
        </p>
      </Section>

      <Section title="6. Your content and conduct">
        <p>
          You retain all rights to the data you transmit through the Service. We
          do not claim ownership of your traffic and, consistent with our
          no-logging policy, we do not inspect or store it.
        </p>
      </Section>

      <Section title="7. Service availability">
        <p>
          We work to keep the Service available and performant but do not
          guarantee uninterrupted operation. We may modify, suspend, or
          discontinue features, perform maintenance, or take nodes offline for
          security or operational reasons. The Service is provided on an
          &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis.
        </p>
      </Section>

      <Section title="8. Disclaimers and limitation of liability">
        <p>
          To the maximum extent permitted by law, vpnVPN disclaims all implied
          warranties, including merchantability, fitness for a particular
          purpose, and non-infringement. To the maximum extent permitted by law,
          our total liability arising out of or relating to the Service is
          limited to the amount you paid us in the twelve months preceding the
          event giving rise to the claim. We are not liable for indirect,
          incidental, special, consequential, or punitive damages.
        </p>
      </Section>

      <Section title="9. Termination">
        <p>
          You may stop using the Service and delete your account at any time
          from your account settings, which permanently erases your data and
          revokes all VPN access. We may suspend or terminate your access if you
          breach these Terms or if required to protect the Service or other
          users.
        </p>
      </Section>

      <Section title="10. Changes to these Terms">
        <p>
          We may update these Terms from time to time. When we make material
          changes, we will update the &ldquo;last updated&rdquo; date and, where
          appropriate, notify you by email or in-product. Your continued use of
          the Service after changes take effect constitutes acceptance.
        </p>
      </Section>

      <Section title="11. Contact">
        <p>
          Questions about these Terms? Email us at{" "}
          <a
            href="mailto:support@vpnvpn.dev"
            className="text-emerald-400 hover:text-emerald-300"
          >
            support@vpnvpn.dev
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
