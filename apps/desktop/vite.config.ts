import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => {
  const tailwindcss = (await import("@tailwindcss/vite")).default;

  return {
    plugins: [react(), tailwindcss()],
    build: {
      sourcemap: true,
    },
    server: {
      port: 5173,
    },
  };
});
