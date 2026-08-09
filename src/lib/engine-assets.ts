// src/lib/engine-assets.ts
//
// Single source of truth for large engine asset URLs.
// The Lovable assets integration re-hashes asset IDs on re-upload, so any
// hardcoded copy of these URLs will silently drift. Every runtime module and
// the service worker MUST import from this file — never inline the URL.
//
// The pointer JSON files (public/**/*.asset.json) are written by
// `lovable-assets create`; they are the authoritative source. Update ONE file
// (the pointer) and every consumer stays in sync automatically.

import ffmpegCoreWasm from "../../public/ffmpeg/ffmpeg-core.wasm.asset.json";

export const CORE_JS_URL = "/ffmpeg/ffmpeg-core.js";
export const CORE_WASM_URL = ffmpegCoreWasm.url;
// Whisper 모델은 사용자가 SYLT 화면에서 언어별로 수동 1회 다운로드한다.
// 앱 최초 접속/SW prewarm에서는 절대 자동 다운로드하지 않는다.
// - ko / en: base 계열 (~60MB) — 말소리 위주, 빠름
// - *-music: small 계열 (~190MB) — 연주음이 큰 음악(락 등)에서 가사 인식용
export const WHISPER_MODEL_URLS = {
  ko: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
  en: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
  "ko-music": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
  "en-music": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin",
} as const;
export const WHISPER_MODEL_SIZE_LABELS = {
  ko: "approx. 60MB",
  en: "approx. 60MB",
  "ko-music": "approx. 190MB",
  "en-music": "approx. 190MB",
} as const;
export const SHOUT_WASM_JS_URL = "/whisper/shout.wasm.js";

export const ENGINE_CACHE_NAME = "audiochef-media-engines-v1";
// Older AudioFly-branded cache; entries are migrated once then deleted.
export const LEGACY_ENGINE_CACHE_NAMES: readonly string[] = ["audiofly-media-engines-v2"];

// SW prewarm 대상 — Whisper 모델은 여기에 포함하지 않는다.
export const ENGINE_CACHE_URLS: readonly string[] = [
  CORE_JS_URL,
  SHOUT_WASM_JS_URL,
  CORE_WASM_URL,
];
