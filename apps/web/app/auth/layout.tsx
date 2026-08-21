import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign In - vpnVPN",
  description: "Sign in to your vpnVPN account",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
