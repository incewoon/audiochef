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

export type WhisperLang = "ko" | "en";

const MODEL_CACHE_NAME = ENGINE_CACHE_NAME;
const INIT_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;

function modelUrlFor(lang: WhisperLang): string {
  return WHISPER_MODEL_URLS[lang];
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
  return caches.open(MODEL_CACHE_NAME);
}

/** 캐시에 지정 언어의 Whisper 모델이 저장돼 있는지 확인 */
export async function isWhisperModelCached(lang: WhisperLang = "ko"): Promise<boolean> {
  if (!("caches" in globalThis)) return false;
  const cache = await openModelCache();
  const hit = await cache.match(new Request(modelUrlFor(lang)));
  return !!hit;
}

/** 캐시에서 지정 언어의 Whisper 모델 삭제 */
export async function deleteWhisperModel(lang: WhisperLang = "ko"): Promise<void> {
  if (!("caches" in globalThis)) return;
  const cache = await openModelCache();
  await cache.delete(new Request(modelUrlFor(lang)));
}

async function fetchAndCacheModel(
  lang: WhisperLang,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const url = modelUrlFor(lang);
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
  lang: WhisperLang = "ko",
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (await isWhisperModelCached(lang)) {
    onProgress?.(1, 1);
    return;
  }
  await fetchAndCacheModel(lang, onProgress);
}

async function loadModelBlob(lang: WhisperLang, cb?: TranscribeCallbacks): Promise<File> {
  const cache = await openModelCache();
  const cacheKey = new Request(modelUrlFor(lang));
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

async function assertAudioDecodable(file: File) {
  const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioCtx) throw new Error("This browser does not support audio decoding.");
  const ctx = new AudioCtx({ sampleRate: 16000 });
  try {
    const buf = await file.arrayBuffer();
    await withTimeout(ctx.decodeAudioData(buf.slice(0)), 60_000, "AudioContext.decodeAudioData()");
  } catch (err) {
    throw new Error(`Could not decode this MP3 audio. Try another file. (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    ctx.close?.();
  }
}

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

export interface TranscribeOptions extends TranscribeCallbacks {
  lang?: WhisperLang;
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
  console.log("[whisper] loading model…", lang);
  const collectedSegments: WhisperSegment[] = [];
  const model = await loadModelBlob(lang, cb);
  console.log("[whisper] model ready:", model.size, "bytes");

  console.log("[whisper] validating audio decode…");
  await assertAudioDecodable(file);

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
  // Module["mainScriptUrlOrBlob"]을 안 주면 실제 네트워크 경로
  // (new URL("shout.wasm.js", import.meta.url))로 새 Worker를 띄운다.
  // 이 정적 파일 응답엔 COOP/COEP 헤더가 안 붙어있어(Cloudflare Static
  // Assets가 Worker fetch 핸들러를 안 거치고 직접 서빙) 그 워커가 조용히
  // 차단된다(ffmpeg의 classWorkerURL과 동일한 문제). 같은 파일을 우리가
  // 미리 fetch해서 blob: URL로 만들어 mainScriptUrlOrBlob으로 넘기면,
  // 네트워크 경로를 아예 안 타므로 이 COEP 제약을 우회한다.
  const shoutBlobURL = await toBlobURL(SHOUT_WASM_JS_URL, "text/javascript");
  console.log("[whisper] pthread worker will use blob URL", shoutBlobURL);
  const createModule = (moduleArg: Record<string, unknown> = {}) =>
    rawCreateModule({ ...moduleArg, mainScriptUrlOrBlob: shoutBlobURL });

  try {
    if (!cachedTranscriber) {
      console.log("[whisper] initializing FileTranscriber…");
      cachedTranscriber = new FileTranscriber({
        createModule,
        model: model as any,
        print: (message: string) => console.log("[whisper:stdout]", message),
        printErr: (message: string) => console.warn("[whisper:stderr]", message),
        onAbort: () => console.warn("[whisper] wasm aborted"),
        onExit: (status: unknown) => console.warn("[whisper] wasm exited", status),
        onComplete: (result: unknown) => console.log("[whisper] complete callback", result),
        onSegment: (segment: unknown) => {
          console.log("[whisper] segment", segment);
          const seg = (segment as any)?.segment;
          if (seg?.text && !isNoiseOnly(seg.text)) {
            const s: WhisperSegment = {
              startMs: Math.max(0, Math.round(seg.offsets?.from ?? 0)),
              endMs: Math.max(0, Math.round(seg.offsets?.to ?? 0)),
              text: cleanSegmentText(seg.text),
            };
            collectedSegments.push(s);   // 추가: 실패 시 부분 결과 복구용
            cb.onSegment?.(s);
          }
        },

        onProgress: (p: number) => {
          console.log("[whisper] progress", p);
          cb.onProgress?.(p);
        },
      });
      await withTimeout(cachedTranscriber.init(), INIT_TIMEOUT_MS, "FileTranscriber.init()");
      console.log("[whisper] init done");
    } else {
      cachedTranscriber.onProgress = (p: number) => {
        console.log("[whisper] progress", p);
        cb.onProgress?.(p);
      };
    }

    console.log("[whisper] transcribing…", lang);
    const result: any = await withTimeout(
      cachedTranscriber.transcribe(file, {
        lang,
        threads: Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4)),
        token_timestamps: false,
        suppress_non_speech: true,
      }),
      TRANSCRIBE_TIMEOUT_MS,
      "FileTranscriber.transcribe()",
    );
    console.log("[whisper] transcribe done", result);

    const segments: WhisperSegment[] = (result.transcription ?? [])
      .map((s: any) => ({
        startMs: Math.max(0, Math.round(s.offsets?.from ?? 0)),
        endMs: Math.max(0, Math.round(s.offsets?.to ?? 0)),
        text: (s.text ?? "").trim(),
      }))
      .filter((s: WhisperSegment) => s.text.length > 0);

    return segments;
  } catch (err) {
    // Drop the cached instance so the next attempt gets a fresh worker.
    await resetTranscriber();
    console.error("[whisper] failed", err);
    // whisper.cpp WASM이 긴 오디오 후반부에서 내부적으로 멈추는 경우가 있고
    // (failed to decode/encode 이후 응답 없음), 이 실패는 JS로 전달되지
    // 않아 타임아웃까지 그냥 대기하게 된다. 이미 onSegment로 도착한
    // 세그먼트가 있다면 버리지 않고 부분 결과로라도 반환한다.
    if (collectedSegments.length > 0) {
      console.warn(`[whisper] 실패 후 부분 결과 ${collectedSegments.length}개 세그먼트 반환`);
      return collectedSegments;
    }
    throw err;
  }
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
