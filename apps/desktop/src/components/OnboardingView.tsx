import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  ChevronRight,
  ChevronLeft,
  Check,
  Loader2,
  Wifi,
  Lock,
  Settings,
  AlertTriangle,
  Info,
  RefreshCw,
} from "lucide-react";
import type { Protocol } from "../lib/types";
import {
  isDaemonAvailable,
  getDaemonStatus,
  installDaemon,
} from "../lib/tauri";

export type OnboardingStep =
  | "welcome"
  | "protocol"
  | "killswitch"
  | "install"
  | "complete";

type OnboardingState = {
  completed: boolean;
  current_step: OnboardingStep;
  selected_protocol: Protocol | null;
  kill_switch_enabled: boolean;
  allow_lan: boolean;
  daemon_installed: boolean;
};

type OnboardingViewProps = {
  onComplete: (state: OnboardingState) => void;
  initialState?: {
    completed?: boolean;
    current_step?: string;
    selected_protocol?: Protocol | null;
    kill_switch_enabled?: boolean;
    allow_lan?: boolean;
    daemon_installed?: boolean;
  };
};

const PROTOCOL_OPTIONS: {
  id: Protocol;
  name: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    id: "wireguard",
    name: "WireGuard",
    description:
      "Modern, fast protocol with excellent security. Recommended for most users.",
    recommended: true,
  },
  {
    id: "openvpn",
    name: "OpenVPN",
    description:
      "Battle-tested protocol with wide compatibility. Good for restrictive networks.",
  },
  {
    id: "ikev2",
    name: "IKEv2/IPsec",
    description:
      "Native OS support with good mobile performance. Built into macOS and Windows.",
  },
];

const STEPS: { id: OnboardingStep; title: string; icon: React.ReactNode }[] = [
  { id: "welcome", title: "Welcome", icon: <Shield className="h-5 w-5" /> },
  { id: "protocol", title: "Protocol", icon: <Wifi className="h-5 w-5" /> },
  {
    id: "killswitch",
    title: "Kill Switch",
    icon: <Lock className="h-5 w-5" />,
  },
  { id: "install", title: "Install", icon: <Settings className="h-5 w-5" /> },
  { id: "complete", title: "Complete", icon: <Check className="h-5 w-5" /> },
];

export function OnboardingView({
  onComplete,
  initialState,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(
    (initialState?.current_step as OnboardingStep) || "welcome",
  );
  const [selectedProtocol, setSelectedProtocol] = useState<Protocol | null>(
    initialState?.selected_protocol || "wireguard",
  );
  const [killSwitchEnabled, setKillSwitchEnabled] = useState(
    initialState?.kill_switch_enabled ?? false,
  );
  const [allowLan, setAllowLan] = useState(initialState?.allow_lan ?? true);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [verificationAttempts, setVerificationAttempts] = useState(0);

  const currentStepIndex = STEPS.findIndex((s) => s.id === step);

  // Verify daemon is running after installation
  const verifyDaemonConnection = useCallback(async (): Promise<boolean> => {
    setIsVerifying(true);
    setVerificationFailed(false);

    // Try multiple times with delays (daemon may take time to start)
    for (let attempt = 0; attempt < 5; attempt++) {
      setVerificationAttempts(attempt + 1);

      try {
        const available = await isDaemonAvailable();
        if (available) {
          // Double-check by getting status
          const status = await getDaemonStatus();
          if (status?.running) {
            setIsVerifying(false);
            return true;
          }
        }
      } catch (e) {
        console.error("Daemon verification attempt failed:", e);
      }

      // Wait before retry (increasing delay)
      await new Promise((resolve) => setTimeout(resolve, 1000 + attempt * 500));
    }

    setIsVerifying(false);
    setVerificationFailed(true);
    return false;
  }, []);

  const handleNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < STEPS.length) {
      setStep(STEPS[nextIndex].id);
    }
  };

  const handleBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setStep(STEPS[prevIndex].id);
    }
  };

  const handleInstall = async () => {
    setIsInstalling(true);
    setInstallError(null);
    setVerificationFailed(false);

    try {
      await installDaemon();

      // Verify daemon is actually running
      const isRunning = await verifyDaemonConnection();

      if (isRunning) {
        setInstallSuccess(true);
        // Wait a moment then proceed
        setTimeout(() => {
          setStep("complete");
        }, 1500);
      } else {
        setInstallError(
          "Service installed but failed to start. Click 'Retry Connection' or try reinstalling.",
        );
      }
    } catch (error: any) {
      console.error("Install failed:", error);
      setInstallError(
        error.message || "Installation failed. Please try again.",
      );
    } finally {
      setIsInstalling(false);
    }
  };

  const handleRetryVerification = async () => {
    setVerificationFailed(false);
    setInstallError(null);

    const isRunning = await verifyDaemonConnection();
    if (isRunning) {
      setInstallSuccess(true);
      setTimeout(() => {
        setStep("complete");
      }, 1500);
    } else {
      setInstallError(
        "Service is still not responding. Try restarting the app or reinstalling the service.",
      );
    }
  };

  const handleComplete = () => {
    const state: OnboardingState = {
      completed: true,
      current_step: "complete",
      selected_protocol: selectedProtocol,
      kill_switch_enabled: killSwitchEnabled,
      allow_lan: allowLan,
      daemon_installed: installSuccess,
    };
    onComplete(state);
  };

  const handleSkipInstall = () => {
    // Allow skipping daemon install (VPN will work but without kill-switch)
    setStep("complete");
  };

  return (
    <div className="flex h-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* Progress Bar */}
      <div className="border-b border-slate-800/50 bg-slate-900/50 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          {STEPS.slice(0, -1).map((s, index) => (
            <div key={s.id} className="flex items-center">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
                  index < currentStepIndex
                    ? "bg-emerald-500 text-white"
                    : index === currentStepIndex
                      ? "bg-emerald-500/20 text-emerald-400 ring-2 ring-emerald-500"
                      : "bg-slate-800 text-slate-500"
                }`}
              >
                {index < currentStepIndex ? (
                  <Check className="h-5 w-5" />
                ) : (
                  s.icon
                )}
              </div>
              {index < STEPS.length - 2 && (
                <div
                  className={`mx-2 h-0.5 w-16 transition-all ${
                    index < currentStepIndex ? "bg-emerald-500" : "bg-slate-800"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <div className="w-full max-w-xl">
          {/* Welcome Step */}
          {step === "welcome" && (
            <div className="text-center">
              <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25">
                <Shield className="h-12 w-12 text-white" />
              </div>
              <h1 className="mb-4 text-3xl font-bold text-slate-50">
                Welcome to vpnVPN
              </h1>
              <p className="mb-8 text-lg text-slate-400">
                Let's set up your secure VPN connection. This wizard will guide
                you through configuring your preferred settings and installing
                the necessary components.
              </p>
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-left">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                  What we'll configure
                </h3>
                <ul className="space-y-3">
                  <li className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full bg-emerald-500/20 p-1">
                      <Check className="h-3 w-3 text-emerald-400" />
                    </div>
                    <span className="text-sm text-slate-300">
                      Choose your preferred VPN protocol
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full bg-emerald-500/20 p-1">
                      <Check className="h-3 w-3 text-emerald-400" />
                    </div>
                    <span className="text-sm text-slate-300">
                      Configure kill-switch and privacy settings
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-full bg-emerald-500/20 p-1">
                      <Check className="h-3 w-3 text-emerald-400" />
                    </div>
                    <span className="text-sm text-slate-300">
                      Install the VPN helper service (requires admin privileges)
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          )}

          {/* Protocol Selection Step */}
          {step === "protocol" && (
            <div>
              <h2 className="mb-2 text-2xl font-bold text-slate-50">
                Choose Your Protocol
              </h2>
              <p className="mb-6 text-slate-400">
                Select the VPN protocol that best fits your needs. You can
                change this later in settings.
              </p>
              <div className="space-y-3">
                {PROTOCOL_OPTIONS.map((protocol) => (
                  <label
                    key={protocol.id}
                    className={`flex cursor-pointer items-start gap-4 rounded-xl border p-4 transition-all ${
                      selectedProtocol === protocol.id
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "border-slate-800 bg-slate-900/50 hover:border-slate-700"
                    }`}
                  >
                    <input
                      type="radio"
                      name="protocol"
                      value={protocol.id}
                      checked={selectedProtocol === protocol.id}
                      onChange={() => setSelectedProtocol(protocol.id)}
                      className="mt-1 h-4 w-4 border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-100">
                          {protocol.name}
                        </span>
                        {protocol.recommended && (
                          <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
                            Recommended
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-slate-400">
                        {protocol.description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Kill Switch Step */}
          {step === "killswitch" && (
            <div>
              <h2 className="mb-2 text-2xl font-bold text-slate-50">
                Kill Switch Settings
              </h2>
              <p className="mb-6 text-slate-400">
                The kill switch protects your privacy by blocking internet
                access if the VPN connection drops unexpectedly.
              </p>

              <div className="space-y-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                  <label className="flex cursor-pointer items-start justify-between">
                    <div className="flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <Lock className="h-5 w-5 text-emerald-400" />
                        <span className="font-medium text-slate-100">
                          Enable Kill Switch
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-400">
                        Block all internet traffic if the VPN disconnects
                        unexpectedly. Highly recommended for privacy.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={killSwitchEnabled}
                      onClick={() => setKillSwitchEnabled(!killSwitchEnabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        killSwitchEnabled ? "bg-emerald-500" : "bg-slate-700"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                          killSwitchEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </label>
                </div>

                {killSwitchEnabled && (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                    <label className="flex cursor-pointer items-start justify-between">
                      <div className="flex-1 pr-4">
                        <span className="font-medium text-slate-100">
                          Allow Local Network Access
                        </span>
                        <p className="mt-1 text-sm text-slate-400">
                          Allow connections to local devices (printers, file
                          shares, etc.) even when kill switch is active.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={allowLan}
                        onClick={() => setAllowLan(!allowLan)}
                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                          allowLan ? "bg-emerald-500" : "bg-slate-700"
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                            allowLan ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </label>
                  </div>
                )}

                <div className="flex items-start gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
                  <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
                  <p className="text-sm text-blue-300">
                    The kill switch requires the VPN helper service to be
                    installed. You'll set this up in the next step.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Install Step */}
          {step === "install" && (
            <div>
              <h2 className="mb-2 text-2xl font-bold text-slate-50">
                Install VPN Service
              </h2>
              <p className="mb-6 text-slate-400">
                vpnVPN needs to install a helper service with administrator
                privileges to manage VPN connections and the kill switch.
              </p>

              {!installSuccess ? (
                <>
                  {!isVerifying && !verificationFailed && (
                    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                        <div>
                          <p className="font-medium text-amber-300">
                            Administrator privileges required
                          </p>
                          <p className="mt-1 text-sm text-amber-300/80">
                            You'll be prompted to enter your password to install
                            the service. This is a one-time setup.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {isVerifying && (
                    <div className="mb-6 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
                      <div className="flex items-center gap-3">
                        <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                        <div>
                          <p className="font-medium text-blue-300">
                            Verifying service connection...
                          </p>
                          <p className="mt-1 text-sm text-blue-300/80">
                            Attempt {verificationAttempts} of 5 - Please wait
                            while we confirm the service is running.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {installError && (
                    <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                      <p className="text-sm text-red-300">{installError}</p>
                    </div>
                  )}

                  <div className="space-y-3">
                    {verificationFailed ? (
                      <>
                        <button
                          onClick={handleRetryVerification}
                          disabled={isVerifying}
                          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 px-6 py-3 font-semibold text-white transition-all hover:from-blue-400 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isVerifying ? (
                            <>
                              <Loader2 className="h-5 w-5 animate-spin" />
                              Checking...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-5 w-5" />
                              Retry Connection
                            </>
                          )}
                        </button>
                        <button
                          onClick={handleInstall}
                          disabled={isInstalling || isVerifying}
                          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 px-6 py-3 font-semibold text-slate-200 transition-all hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Settings className="h-5 w-5" />
                          Reinstall Service
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleInstall}
                        disabled={isInstalling || isVerifying}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 font-semibold text-white transition-all hover:from-emerald-400 hover:to-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isInstalling ? (
                          <>
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Installing...
                          </>
                        ) : (
                          <>
                            <Settings className="h-5 w-5" />
                            Install Service
                          </>
                        )}
                      </button>
                    )}

                    <button
                      onClick={handleSkipInstall}
                      disabled={isInstalling || isVerifying}
                      className="w-full rounded-xl border border-slate-700 px-6 py-3 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
                    >
                      Skip for now (kill switch won't work)
                    </button>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
                    <Check className="h-8 w-8 text-emerald-400" />
                  </div>
                  <p className="text-lg font-medium text-emerald-300">
                    Service installed and connected!
                  </p>
                  <p className="mt-2 text-sm text-emerald-300/80">
                    Proceeding to finish setup...
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Complete Step */}
          {step === "complete" && (
            <div className="text-center">
              <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25">
                <Check className="h-12 w-12 text-white" />
              </div>
              <h2 className="mb-4 text-3xl font-bold text-slate-50">
                You're All Set!
              </h2>
              <p className="mb-8 text-lg text-slate-400">
                vpnVPN is configured and ready to use. Connect to a server to
                start browsing securely.
              </p>

              <div className="mb-8 rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-left">
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Your Configuration
                </h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Protocol</span>
                    <span className="text-sm font-medium text-slate-200">
                      {
                        PROTOCOL_OPTIONS.find((p) => p.id === selectedProtocol)
                          ?.name
                      }
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Kill Switch</span>
                    <span
                      className={`text-sm font-medium ${killSwitchEnabled ? "text-emerald-400" : "text-slate-500"}`}
                    >
                      {killSwitchEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  {killSwitchEnabled && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-400">LAN Access</span>
                      <span
                        className={`text-sm font-medium ${allowLan ? "text-emerald-400" : "text-slate-500"}`}
                      >
                        {allowLan ? "Allowed" : "Blocked"}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Service</span>
                    <span
                      className={`text-sm font-medium ${installSuccess ? "text-emerald-400" : "text-amber-400"}`}
                    >
                      {installSuccess ? "Installed" : "Not Installed"}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleComplete}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3 font-semibold text-white transition-all hover:from-emerald-400 hover:to-teal-400"
              >
                Start Using vpnVPN
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      {step !== "complete" && (
        <div className="border-t border-slate-800/50 bg-slate-900/50 px-6 py-4">
          <div className="mx-auto flex max-w-xl items-center justify-between">
            <button
              onClick={handleBack}
              disabled={step === "welcome"}
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:invisible"
            >
              <ChevronLeft className="h-5 w-5" />
              Back
            </button>

            {step !== "install" && (
              <button
                onClick={handleNext}
                disabled={step === "protocol" && !selectedProtocol}
                className="flex items-center gap-2 rounded-lg bg-emerald-500 px-6 py-2 font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Continue
                <ChevronRight className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
