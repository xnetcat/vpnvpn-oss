import { useEffect } from "react";
import { X, AlertCircle, CheckCircle, Info, ExternalLink } from "lucide-react";
import type { ToastMessage } from "../lib/useToasts";

// Re-export types for convenience
export type { ToastType, ToastAction, ToastMessage } from "../lib/useToasts";
export { useToasts } from "../lib/useToasts";

type ToastProps = {
  toast: ToastMessage;
  onClose: (id: string) => void;
};

function Toast({ toast, onClose }: ToastProps) {
  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => {
        onClose(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.duration, onClose]);

  const icons = {
    success: <CheckCircle className="h-5 w-5 text-emerald-400" />,
    error: <AlertCircle className="h-5 w-5 text-red-400" />,
    warning: <AlertCircle className="h-5 w-5 text-yellow-400" />,
    info: <Info className="h-5 w-5 text-blue-400" />,
  };

  const colors = {
    success: "border-emerald-500/30 bg-emerald-500/10",
    error: "border-red-500/30 bg-red-500/10",
    warning: "border-yellow-500/30 bg-yellow-500/10",
    info: "border-blue-500/30 bg-blue-500/10",
  };

  const textColors = {
    success: "text-emerald-300",
    error: "text-red-300",
    warning: "text-yellow-300",
    info: "text-blue-300",
  };

  const actionColors = {
    success: "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30",
    error: "bg-red-500/20 text-red-300 hover:bg-red-500/30",
    warning: "bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30",
    info: "bg-blue-500/20 text-blue-300 hover:bg-blue-500/30",
  };

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border ${colors[toast.type]} px-4 py-3 shadow-lg backdrop-blur-sm animate-in slide-in-from-top-2 fade-in duration-200`}
    >
      <div className="flex items-start gap-3">
        {icons[toast.type]}
        <p className={`flex-1 text-sm ${textColors[toast.type]}`}>
          {toast.message}
        </p>
        <button
          type="button"
          onClick={() => onClose(toast.id)}
          className="text-slate-400 transition-colors hover:text-slate-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onClose(toast.id);
          }}
          className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${actionColors[toast.type]}`}
        >
          <ExternalLink className="h-3 w-3" />
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

type ToastContainerProps = {
  toasts: ToastMessage[];
  onClose: (id: string) => void;
};

export function ToastContainer({ toasts, onClose }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={onClose} />
      ))}
    </div>
  );
}
