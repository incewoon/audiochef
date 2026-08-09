// src/lib/engine-cache-migrate.ts
//
// One-shot migration from the legacy "audiofly-*" engine cache to the current
// "audiochef-*" cache so already-downloaded Whisper models / ffmpeg core files
// survive the rename. Runs at most once per session (module-level promise lock).

import { ENGINE_CACHE_NAME, LEGACY_ENGINE_CACHE_NAMES } from "./engine-assets";
import { requestPersistentStorage } from "./persist-storage";

let migrationPromise: Promise<void> | null = null;

async function runMigration(): Promise<void> {
  if (typeof caches === "undefined") return;

  const existing = await caches.keys();
  const legacyNames = LEGACY_ENGINE_CACHE_NAMES.filter(
    (name) => name !== ENGINE_CACHE_NAME && existing.includes(name),
  );
  if (legacyNames.length === 0) return;

  const target = await caches.open(ENGINE_CACHE_NAME);
  let copied = 0;

  for (const name of legacyNames) {
    try {
      const legacy = await caches.open(name);
      for (const request of await legacy.keys()) {
        if (await target.match(request)) continue;
        const response = await legacy.match(request);
        if (!response) continue;
        await target.put(request, response.clone());
        copied += 1;
      }
      await caches.delete(name);
      console.info("[audiochef:cache] migrated legacy cache", name);
    } catch (err) {
      console.warn("[audiochef:cache] legacy cache migration failed", name, err);
    }
  }

  if (copied > 0) void requestPersistentStorage();
}

export function migrateLegacyEngineCaches(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigration().catch((err) => {
      console.warn("[audiochef:cache] migration error", err);
    });
  }
  return migrationPromise;
}
