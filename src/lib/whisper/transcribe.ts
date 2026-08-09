// src/lib/whisper/transcribe.ts

// Client-only Whisper.cpp WASM wrapper.
// Loaded via dynamic import so it never lands in the server bundle.

import { toBlobURL } from "@ffmpeg/util";

export interface WhisperSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeCallbacks {
  onModelProgress?: (loaded: number, total: number) => void;
  onProgress?: (percent: number) => void;
  onSegment?: (seg: WhisperSegment) => void;
}

// Asset URLs come from src/lib/engine-assets.ts (single source of truth backed by
// the Lovable asset pointer JSON). Never hardcode `/__l5e/...` here — it drifts.
import {
  WHISPER_MODEL_URLS,
  SHOUT_WASM_JS_URL,
  ENGINE_CACHE_NAME,
} from "../engine-assets";
import { migrateLegacyEngineCaches } from "../engine-cache-migrate";
import { requestPersistentStorage } from "../persist-storage";

export type WhisperLang = "ko" | "en";
/** Model bucket: base for speech, "-music" (small) for loud instrumentation. */
export type WhisperModelKey = "ko" | "en" | "ko-music" | "en-music";

export function modelKeyFor(lang: WhisperLang, music?: boolean): WhisperModelKey {
  return (music ? `${lang}-music` : lang) as WhisperModelKey;
}

const MODEL_CACHE_NAME = ENGINE_CACHE_NAME;
const INIT_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;

function modelUrlFor(key: WhisperModelKey): string {
  return WHISPER_MODEL_URLS[key];
}

// ── Non-speech token cleanup ────────────────────────────────
// Whisper often emits music notes and bracketed sound tags during instrumental
// parts (♪, [Music], (박수), [BLANK_AUDIO]…). Strip them so SYLT output stays clean.
const MUSIC_SYMBOLS_RE = /[♪♫♬♩♭♮♯★☆*~〜]/g;
const NON_SPEECH_TAG_RE =
  /[\[\(（【]\s*(music|musik|musique|음악|노래|배경\s*음악|applause|clapping|박수|laughter|웃음|silence|무음|no\s*speech|blank_?audio|inaudible|sound\s*effects?|효과음|instrumental|간주|전주|후주|singing|humming|허밍|noise|소음)\s*[\]\)）】]/gi;
// A bracketed chunk containing no letters/digits at all is decoration, not lyrics.
const EMPTY_BRACKET_RE = /[\[\(（【][^\p{L}\p{N}]*[\]\)）】]/gu;

export function cleanSegmentText(text: string): string {
  return String(text ?? "")
    .replace(NON_SPEECH_TAG_RE, " ")
    .replace(MUSIC_SYMBOLS_RE, " ")
    .replace(EMPTY_BRACKET_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when nothing but punctuation/symbols remains after cleanup. */
export function isNoiseOnly(text: string): boolean {
  const cleaned = cleanSegmentText(text);
  if (!cleaned) return true;
  return !/[\p{L}\p{N}]/u.test(cleaned);
}


function makeAbortableTimeout(ms: number, tag: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(`${tag} timed out after ${ms}ms`), ms);
  return { controller, clear: () => window.clearTimeout(timeout) };
}

async function openModelCache() {
  if (!("caches" in globalThis)) {
    throw new Error("This browser does not support offline model caching.");
  }
  await migrateLegacyEngineCaches();
  return caches.open(MODEL_CACHE_NAME);
}

/** 캐시에 지정 언어의 Whisper 모델이 저장돼 있는지 확인 */
export async function isWhisperModelCached(key: WhisperModelKey = "ko"): Promise<boolean> {
  if (!("caches" in globalThis)) return false;
  const cache = await openModelCache();
  const hit = await cache.match(new Request(modelUrlFor(key)));
  return !!hit;
}

/** 캐시에서 지정 언어의 Whisper 모델 삭제 */
export async function deleteWhisperModel(key: WhisperModelKey = "ko"): Promise<void> {
  if (!("caches" in globalThis)) return;
  const cache = await openModelCache();
  await cache.delete(new Request(modelUrlFor(key)));
}

async function fetchAndCacheModel(
  key: WhisperModelKey,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const url = modelUrlFor(key);
  const cache = await openModelCache();
  const cacheKey = new Request(url);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("You are offline. Download the module while online first.");
  }

  const modelFetch = makeAbortableTimeout(10 * 60_000, "Whisper model download");
  const res = await fetch(url, {
    // 외부 origin(HF) — credentials 없이 CORS
    mode: "cors",
    signal: modelFetch.controller.signal,
  }).finally(modelFetch.clear);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
  }
  const blob = new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
  await cache.put(
    cacheKey,
    new Response(blob, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(blob.size),
      },
    }),
  );
  return blob;
}

/** 사용자가 명시적으로 언어별 모듈을 다운로드할 때 호출. 이미 캐시돼 있으면 no-op. */
export async function downloadWhisperModel(
  key: WhisperModelKey = "ko",
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (await isWhisperModelCached(key)) {
    onProgress?.(1, 1);
    return;
  }
  await fetchAndCacheModel(key, onProgress);
}

async function loadModelBlob(key: WhisperModelKey, cb?: TranscribeCallbacks): Promise<File> {
  const cache = await openModelCache();
  const cacheKey = new Request(modelUrlFor(key));
  const cached = await cache.match(cacheKey);
  if (cached) {
    const buf = await cached.arrayBuffer();
    cb?.onModelProgress?.(buf.byteLength, buf.byteLength);
    return new File([buf], "model.bin", { type: "application/octet-stream" });
  }
  // 캐시가 없다면 — 자동추출 호출 시점에서는 사용자가 미리 다운로드해야 한다.
  throw new Error(
    "Speech module for the selected language is not installed. Run 'Download module' while online first.",
  );
}


let cachedTranscriber: any = null;


function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${tag} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Audio decoding now happens in ./chunk.ts (decode + 1-minute chunking), so
// there's no separate decodability probe here.



// Do NOT wrap the shout module in a blob: URL. Its default export creates a
// pthread WASM instance that internally does `new URL(import.meta.url)` to
// spawn workers, which throws "Failed to construct 'URL': Invalid URL" when
// the module was loaded from a blob: URL. Import the real same-origin path
// directly; the SW's CacheFirst rule already caches it for offline use.

async function resetTranscriber() {
  const current = cachedTranscriber;
  cachedTranscriber = null;
  try { await current?.cancel?.(); } catch {}
  try { current?.destroy?.(); } catch {}
}

/** Release any live engine instance (called on dialog save/cancel). */
export async function releaseTranscriber() {
  await resetTranscriber();
}

export interface TranscribeOptions extends TranscribeCallbacks {
  lang?: WhisperLang;
  /** Use the larger "music" model + relaxed thresholds for loud tracks. */
  music?: boolean;
  /** Chunk length in seconds (default 60). */
  chunkSec?: number;
  /** Reports chunk-level progress: 1-based index and total chunk count. */
  onChunk?: (index: number, total: number) => void;
  /** Abort the whole run between/inside chunks. */
  signal?: AbortSignal;
}

async function buildCreateModule() {
  console.log("[whisper] importing transcriber + local shout wasm module…");
  const [{ FileTranscriber }, shoutMod] = await Promise.all([
    import("@transcribe/transcriber"),
    import(/* @vite-ignore */ SHOUT_WASM_JS_URL),
  ]);
  const rawCreateModule = (shoutMod as any).default;
  if (typeof rawCreateModule !== "function") {
    throw new Error("Failed to load Whisper WASM module: @transcribe/shout default export is not a function");
  }

  // shout.wasm.js는 실제 연산 시작 시 pthread 워커를 하나 더 스폰하는데,
  // Module["mainScriptUrlOrBlob"]을 안 주면 실제 네트워크 경로로 새 Worker를
  // 띄우고, 그 응답엔 COOP/COEP 헤더가 없어 조용히 차단된다. 같은 파일을
  // 미리 fetch해 blob: URL로 넘겨 이 제약을 우회한다.
  const shoutBlobURL = await toBlobURL(SHOUT_WASM_JS_URL, "text/javascript");
  const createModule = (moduleArg: Record<string, unknown> = {}) =>
    rawCreateModule({ ...moduleArg, mainScriptUrlOrBlob: shoutBlobURL });

  return { FileTranscriber, createModule };
}

/** Per-chunk timeout — a single minute of audio should never take this long. */
const CHUNK_TIMEOUT_MS = 3 * 60_000;

/**
 * Transcribe one already-chunked WAV. Creates a fresh engine instance and
 * destroys it before returning so WASM memory never accumulates across chunks.
 */
async function transcribeChunk(
  FileTranscriber: any,
  createModule: any,
  model: File,
  chunkFile: File,
  lang: WhisperLang,
  music: boolean,
  offsetMs: number,
  leadInMs: number,
  onLiveSegment: (seg: WhisperSegment) => void,
  onChunkProgress: (p: number) => void,
): Promise<WhisperSegment[]> {
  const collected: WhisperSegment[] = [];
  const toAbs = (ms: number) => Math.max(0, Math.round(ms - leadInMs + offsetMs));

  const transcriber = new FileTranscriber({
    createModule,
    model: model as any,
    print: (message: string) => console.log("[whisper:stdout]", message),
    printErr: (message: string) => console.warn("[whisper:stderr]", message),
    onAbort: () => console.warn("[whisper] wasm aborted"),
    onExit: (status: unknown) => console.warn("[whisper] wasm exited", status),
    onSegment: (segment: unknown) => {
      const seg = (segment as any)?.segment;
      if (!seg?.text || isNoiseOnly(seg.text)) return;
      const startMs = toAbs(seg.offsets?.from ?? 0);
      // Drop anything that lands inside the overlap region — the previous
      // chunk already produced it.
      if (startMs < offsetMs - 50) return;
      const s: WhisperSegment = {
        startMs,
        endMs: toAbs(seg.offsets?.to ?? 0),
        text: cleanSegmentText(seg.text),
      };
      collected.push(s);
      onLiveSegment(s);
    },
    onProgress: (p: number) => onChunkProgress(p),
  });

  cachedTranscriber = transcriber;
  try {
    await withTimeout(transcriber.init(), INIT_TIMEOUT_MS, "FileTranscriber.init()");
    const result: any = await withTimeout(
      transcriber.transcribe(chunkFile, {
        lang,
        threads: Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4)),
        token_timestamps: false,
        // Aggressive non-speech suppression throws away sung lines over loud
        // backing; in music mode we rely on cleanSegmentText() instead.
        suppress_non_speech: !music,
        no_speech_thold: music ? 0.2 : 0.6,
      }),
      CHUNK_TIMEOUT_MS,
      "FileTranscriber.transcribe()",
    );

    const segments: WhisperSegment[] = (result?.transcription ?? [])
      .map((s: any) => ({
        startMs: toAbs(s.offsets?.from ?? 0),
        endMs: toAbs(s.offsets?.to ?? 0),
        text: cleanSegmentText(s.text ?? ""),
      }))
      .filter(
        (s: WhisperSegment) =>
          s.text.length > 0 && !isNoiseOnly(s.text) && s.startMs >= offsetMs - 50,
      );

    return segments.length > 0 ? segments : collected;
  } catch (err) {
    console.warn("[whisper] chunk failed", err);
    // Keep whatever streamed in before the failure.
    if (collected.length > 0) return collected;
    throw err;
  } finally {
    if (cachedTranscriber === transcriber) cachedTranscriber = null;
    try { await transcriber.cancel?.(); } catch {}
    try { transcriber.destroy?.(); } catch {}
  }
}

export async function transcribeMp3(
  file: File,
  cb: TranscribeOptions = {},
): Promise<WhisperSegment[]> {
  if (!(globalThis as any).crossOriginIsolated) {
    throw new Error(
      "Speech recognition requires the page to be cross-origin isolated. Please reload and try again.",
    );
  }

  const lang: WhisperLang = cb.lang ?? "ko";
  const music = cb.music === true;
  const key = modelKeyFor(lang, music);
  console.log("[whisper] loading model…", key);
  const model = await loadModelBlob(key, cb);
  console.log("[whisper] model ready:", model.size, "bytes");

  console.log("[whisper] decoding + chunking audio…");
  const { chunkAudioFile, CHUNK_SEC } = await import("./chunk");
  const chunks = await chunkAudioFile(file, cb.chunkSec ?? CHUNK_SEC);
  console.log(`[whisper] ${chunks.length} chunk(s) of ~${cb.chunkSec ?? CHUNK_SEC}s`);

  const { FileTranscriber, createModule } = await buildCreateModule();

  const all: WhisperSegment[] = [];
  let failures = 0;

  for (const chunk of chunks) {
    if (cb.signal?.aborted) break;
    cb.onChunk?.(chunk.index + 1, chunks.length);
    const base = (chunk.index / chunks.length) * 100;
    const span = 100 / chunks.length;
    cb.onProgress?.(base);

    try {
      const segs = await transcribeChunk(
        FileTranscriber,
        createModule,
        model,
        chunk.file,
        lang,
        music,
        chunk.offsetMs,
        chunk.leadInMs,
        (seg) => cb.onSegment?.(seg),
        (p) => cb.onProgress?.(Math.min(100, base + (Math.max(0, Math.min(100, p)) / 100) * span)),
      );
      all.push(...segs);
    } catch (err) {
      failures++;
      console.error(`[whisper] chunk ${chunk.index + 1}/${chunks.length} skipped`, err);
      // A single bad minute shouldn't kill the whole run.
      if (failures >= 3 && all.length === 0) throw err;
    }
    cb.onProgress?.(Math.min(100, base + span));
  }

  await resetTranscriber();

  // Chunk boundaries can produce duplicate/near-duplicate lines; drop them.
  all.sort((a, b) => a.startMs - b.startMs);
  const deduped: WhisperSegment[] = [];
  for (const s of all) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.startMs - s.startMs) < 300 && prev.text === s.text) continue;
    deduped.push(s);
  }
  return deduped;
}


// ─────────────────────────────────────────────────────────────
// Offline verification (published site only — SW is disabled in preview):
//   1) Load app once online and wait for engine warm-up logs.
//   2) Convert one MP4 → MP3 to verify ffmpeg-core cache.
//   3) Open lyrics editor → SYLT → "음성인식으로 자동추출" once online to
//      verify the Whisper model (~57MB) under "audiofly-media-engines-v2".
//   4) DevTools → Application → Service Workers: /sw.js activated.
//   5) DevTools → Network → Offline, reload the app.
//   6) MP4→MP3 conversion should still work (ffmpeg-core cache hit).
//   7) SYLT auto-extract should still work (model + shout.wasm.js cache hit).
// ─────────────────────────────────────────────────────────────
