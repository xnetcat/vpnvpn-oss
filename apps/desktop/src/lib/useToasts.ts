import { useState } from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastMessage = {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: ToastAction;
};

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (
    type: ToastType,
    message: string,
    duration: number = 5000,
    action?: ToastAction,
  ) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setToasts((prev) => [...prev, { id, type, message, duration, action }]);
    return id;
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const clearToasts = () => {
    setToasts([]);
  };

  return {
    toasts,
    addToast,
    removeToast,
    clearToasts,
    success: (message: string, duration?: number, action?: ToastAction) =>
      addToast("success", message, duration ?? 5000, action),
    error: (message: string, duration?: number, action?: ToastAction) =>
      addToast("error", message, duration ?? 0, action),
    warning: (message: string, duration?: number, action?: ToastAction) =>
      addToast("warning", message, duration ?? 5000, action),
    info: (message: string, duration?: number, action?: ToastAction) =>
      addToast("info", message, duration ?? 5000, action),
  };
}
