// src/lib/whisper/chunk.ts
// Splits an audio file into fixed-length (default 60s) 16kHz mono WAV chunks.
// Whisper.cpp WASM keeps the whole PCM buffer plus decoder state in the WASM
// heap, so long files abort silently. Feeding it one minute at a time keeps
// memory flat and lets us report progress / recover per chunk.

export const CHUNK_SEC = 60;
/** Prepended context so a sentence spanning a boundary isn't cut mid-word. */
export const OVERLAP_SEC = 1;
/** How far from the nominal boundary we may move to land on silence. */
const BOUNDARY_SEARCH_SEC = 3;
const TARGET_SR = 16000;

export interface AudioChunk {
  /** 16kHz mono WAV file ready for the transcriber. */
  file: File;
  /** Absolute start of this chunk's *content* in the source audio (ms). */
  offsetMs: number;
  /** Milliseconds of leading overlap included before `offsetMs`. */
  leadInMs: number;
  index: number;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, bytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Decode any browser-supported audio file to mono Float32 PCM at 16kHz, with a
 * vocal-emphasis chain so loud instrumentation (rock/metal) doesn't bury the
 * singing: mid (L+R) sum → 180Hz high-pass (kick/bass) → 5.5kHz low-pass
 * (cymbals) → 1–3kHz presence boost → compression → peak normalize.
 */
export async function decodeToMono16k(
  file: File,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  const OfflineCtx =
    (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  if (!AudioCtx) throw new Error("This browser does not support audio decoding.");

  const ctx = new AudioCtx({ sampleRate: TARGET_SR });
  let audio: AudioBuffer;
  try {
    const buf = await file.arrayBuffer();
    audio = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close?.();
  }

  if (OfflineCtx) {
    try {
      return { pcm: await renderVocalEmphasis(OfflineCtx, audio), sampleRate: TARGET_SR };
    } catch (err) {
      console.warn("[whisper] vocal-emphasis preprocessing failed, using raw mix", err);
    }
  }

  // Fallback: plain channel average.
  const ch = audio.numberOfChannels;
  const len = audio.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  if (ch > 1) for (let i = 0; i < len; i++) out[i] /= ch;
  return { pcm: out, sampleRate: audio.sampleRate };
}

async function renderVocalEmphasis(OfflineCtx: any, audio: AudioBuffer): Promise<Float32Array> {
  const offline = new OfflineCtx(1, audio.length, TARGET_SR);

  const src = offline.createBufferSource();
  src.buffer = audio;

  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 180;
  hp.Q.value = 0.7;

  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5500;
  lp.Q.value = 0.7;

  const presence = offline.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2000;
  presence.Q.value = 0.9;
  presence.gain.value = 4;

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -28;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  src.connect(hp).connect(lp).connect(presence).connect(comp).connect(offline.destination);
  src.start(0);

  const rendered: AudioBuffer = await offline.startRendering();
  const data = rendered.getChannelData(0);
  const out = new Float32Array(data.length);
  out.set(data);

  // Peak-normalize to ~0.95 so quiet vocals reach a usable level.
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.0001 && peak < 0.95) {
    const g = 0.95 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

/**
 * Pick a cut point near `nominal` (sample index) that sits in the quietest
 * spot within ±BOUNDARY_SEARCH_SEC, so we avoid slicing mid-syllable.
 */
function findQuietBoundary(pcm: Float32Array, nominal: number, sr: number): number {
  const search = Math.floor(BOUNDARY_SEARCH_SEC * sr);
  const from = Math.max(0, nominal - search);
  const to = Math.min(pcm.length, nominal + search);
  if (to - from < sr / 2) return nominal;
  const win = Math.max(1, Math.floor(0.02 * sr)); // 20ms
  let bestIdx = nominal;
  let bestRms = Infinity;
  for (let i = from; i + win <= to; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += pcm[j] * pcm[j];
    const rms = Math.sqrt(sum / win);
    // Prefer quiet windows; break ties towards the nominal boundary.
    const penalty = Math.abs(i - nominal) / (search * 40);
    const score = rms + penalty;
    if (score < bestRms) {
      bestRms = score;
      bestIdx = i + Math.floor(win / 2);
    }
  }
  return bestIdx;
}

/** Split a decoded track into ~CHUNK_SEC WAV chunks with silence-aware cuts. */
export function chunkPcm(
  pcm: Float32Array,
  sampleRate: number,
  chunkSec: number = CHUNK_SEC,
): AudioChunk[] {
  const chunkSamples = Math.floor(chunkSec * sampleRate);
  const overlapSamples = Math.floor(OVERLAP_SEC * sampleRate);
  const chunks: AudioChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < pcm.length) {
    const nominalEnd = start + chunkSamples;
    const end =
      nominalEnd >= pcm.length - Math.floor(sampleRate * 2)
        ? pcm.length
        : findQuietBoundary(pcm, nominalEnd, sampleRate);
    const leadIn = index === 0 ? 0 : Math.min(overlapSamples, start);
    const slice = pcm.subarray(start - leadIn, end);
    const copy = new Float32Array(slice.length);
    copy.set(slice);
    chunks.push({
      file: new File([encodeWav(copy, sampleRate)], `chunk-${index}.wav`, { type: "audio/wav" }),
      offsetMs: Math.round((start / sampleRate) * 1000),
      leadInMs: Math.round((leadIn / sampleRate) * 1000),
      index,
    });
    index++;
    start = end;
  }
  return chunks;
}

/** Convenience: decode + chunk in one call. */
export async function chunkAudioFile(file: File, chunkSec: number = CHUNK_SEC): Promise<AudioChunk[]> {
  const { pcm, sampleRate } = await decodeToMono16k(file);
  if (pcm.length === 0) throw new Error("Could not decode this audio file. Try another file.");
  return chunkPcm(pcm, sampleRate, chunkSec);
}
