// Absolute API base URL. In dev, VITE_API_URL is unset → empty string,
// which means "/api/..." resolves relatively (Vite proxy handles it).
// In prod (GH Pages build), VITE_API_URL is baked in at build time and
// points at the Fly.io backend.
export const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

// Prefix a "/api/..." path with the base URL.
export const api = (path: string): string => `${API_URL}${path}`;
