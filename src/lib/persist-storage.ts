// src/lib/persist-storage.ts
//
// Ask the browser to make our Cache Storage persistent so large Whisper models
// (up to ~190MB) are not evicted under storage pressure. Purely best-effort:
// unsupported browsers are a no-op and a `false` result is informational only.

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined") return false;
    const storage = navigator.storage;
    if (!storage || typeof storage.persist !== "function") return false;

    if (typeof storage.persisted === "function") {
      const already = await storage.persisted();
      if (already) return true;
    }

    const granted = await storage.persist();
    console.info("[audiochef:storage] persistent storage granted:", granted);
    return granted;
  } catch (err) {
    console.info("[audiochef:storage] persistent storage request failed", err);
    return false;
  }
}
