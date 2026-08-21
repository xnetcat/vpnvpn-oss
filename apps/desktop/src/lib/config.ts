import { DESKTOP_ENV } from "./env";

export const API_BASE_URL = DESKTOP_ENV.API_BASE_URL;

export const DASHBOARD_URL =
  import.meta.env.VITE_DASHBOARD_URL ?? `${API_BASE_URL}/dashboard`;

export const IS_PRODUCTION = import.meta.env.PROD;

export const APP_CHANNEL = (DESKTOP_ENV.APP_CHANNEL || "prod").toLowerCase();
