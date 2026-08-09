// src/lib/sw-register.ts

// Guarded service-worker registration. Only registers in a real published
// production origin — never in Lovable preview, iframe embeds, or dev.

import { ENGINE_CACHE_NAME, ENGINE_CACHE_URLS } from "./engine-assets";
import { migrateLegacyEngineCaches } from "./engine-cache-migrate";

const APP_SW_PATH = "/sw.js";
const LEGACY_SW_PATHS = ["/service-worker.js"];


function isRefusedContext(): boolean {
  if (typeof window === "undefined") return true;
  if (!import.meta.env.PROD) return true;
  try {
    if (window.top !== window.self) return true;
  } catch {
    return true;
  }
  const host = window.location.hostname;
  const url = new URL(window.location.href);
  if (url.searchParams.get("sw") === "off") return true;
  if (host.startsWith("id-preview--") || host.startsWith("preview--")) return true;
  if (host === "lovableproject.com" || host.endsWith(".lovableproject.com")) return true;
  if (host === "lovableproject-dev.com" || host.endsWith(".lovableproject-dev.com")) return true;
  if (host === "beta.lovable.dev" || host.endsWith(".beta.lovable.dev")) return true;
  return false;
}

async function unregisterAppSW(extra: string[] = []) {
  if (!("serviceWorker" in navigator)) return;
  const targets = [APP_SW_PATH, ...LEGACY_SW_PATHS, ...extra];
  const regs = await navigator.serviceWorker.getRegistrations();
  for (const reg of regs) {
    const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || "";
    if (targets.some((p) => url.endsWith(p))) await reg.unregister();
  }
}

async function prewarmEngineCache() {
  if (!("caches" in window)) return;
  await migrateLegacyEngineCaches();
  const cache = await caches.open(ENGINE_CACHE_NAME);
  for (const url of ENGINE_CACHE_URLS) {
    const request = new Request(url, { credentials: "same-origin" });
    const cached = await cache.match(request);
    if (cached) continue;
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      await cache.put(request, response.clone());
      console.info("[audiochef:pwa] cached", url);
    } catch (err) {
      // Do not fail SW registration when a large optional engine file cannot be
      // fetched yet. The feature-specific loader will show a clear error later.
      console.warn("[audiochef:pwa] engine cache warm-up failed", url, err);
    }
  }
}


export function registerAppSW() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (isRefusedContext()) {
    void unregisterAppSW();
    return;
  }
  window.addEventListener("load", async () => {
    try {
      // Clean up any legacy /service-worker.js registered by earlier builds.
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || "";
        if (LEGACY_SW_PATHS.some((p) => url.endsWith(p))) await reg.unregister();
      }
      await navigator.serviceWorker.register(APP_SW_PATH);
      await navigator.serviceWorker.ready;
      void prewarmEngineCache();
    } catch (err) {
      console.warn("SW registration failed:", err);
    }
  });
}

// Offline verification (published app, not preview):
// 1) Load AudioChef online and wait until /sw.js is activated.
// 2) Keep the page open long enough for [audiochef:pwa] engine cache logs to finish.
// 3) Switch DevTools Network to Offline, then reload the installed app.
// 4) The app shell, MP4 conversion engine, and SYLT model should load from cache.
