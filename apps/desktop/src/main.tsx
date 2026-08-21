import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

import "./index.css";

// Override console methods to forward logs to Tauri backend
const setupConsoleForwarding = () => {
  const logToBackend = async (level: string, ...args: unknown[]) => {
    try {
      // Convert args to string, handling objects and arrays
      const message = args
        .map((arg) => {
          if (typeof arg === "object" && arg !== null) {
            try {
              return JSON.stringify(arg, null, 2);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(" ");
      await invoke("log_from_frontend", { level, message });
    } catch (e) {
      // Silently fail if backend logging is unavailable
      // This prevents infinite loops if the backend itself has issues
    }
  };

  // Store original console methods
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  // Override console.log
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    void logToBackend("log", ...args);
  };

  // Override console.error
  console.error = (...args: unknown[]) => {
    originalError(...args);
    void logToBackend("error", ...args);
  };

  // Override console.warn
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    void logToBackend("warn", ...args);
  };

  // Override console.info
  console.info = (...args: unknown[]) => {
    originalInfo(...args);
    void logToBackend("info", ...args);
  };

  // Override console.debug
  console.debug = (...args: unknown[]) => {
    originalDebug(...args);
    void logToBackend("debug", ...args);
  };
};

// Setup console forwarding before rendering
setupConsoleForwarding();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
