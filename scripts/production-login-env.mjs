import { loadEnv } from "vite";

export function assertProductionLoginEnv(mode, root) {
  const env = loadEnv(mode, root, "VITE_");
  const keys = ["VITE_DEV_EMAIL", "VITE_DEV_DISPLAY_NAME", "VITE_DEV_PASSWORD", "VITE_DEV_AUTOLOGIN"];
  const configured = keys.filter((key) => env[key]?.trim());
  if (configured.length) {
    throw new Error(`Production build refused: remove development login settings (${configured.join(", ")}) from the environment and Vite env files.`);
  }
}
