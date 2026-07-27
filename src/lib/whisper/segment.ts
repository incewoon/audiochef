// Silence-based post-processor: splits/aligns Whisper segments on silent gaps.
import type { WhisperSegment } from "./transcribe";

interface SilenceOptions {
  /** RMS threshold below which a frame counts as silent, 0..1 */
  threshold?: number;
  /** Minimum silence duration to count as a gap (ms) */
  minSilenceMs?: number;
  /** Analysis window size in ms */
  windowMs?: number;
}

export interface SilenceGap {
  startMs: number;
  endMs: number;
}

/** Decode an MP3 file into mono PCM and find silent gaps. */
export async function detectSilenceGaps(file: File, opts: SilenceOptions = {}): Promise<SilenceGap[]> {
  const threshold = opts.threshold ?? 0.012;
  const minSilenceMs = opts.minSilenceMs ?? 600;
  const windowMs = opts.windowMs ?? 20;

  const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioCtx) return [];
  const ctx = new AudioCtx();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const sr = audio.sampleRate;
    const ch0 = audio.getChannelData(0);
    const winSamples = Math.max(1, Math.floor((windowMs / 1000) * sr));
    const gaps: SilenceGap[] = [];
    let silentStart: number | null = null;
    for (let i = 0; i < ch0.length; i += winSamples) {
      let sum = 0;
      const end = Math.min(i + winSamples, ch0.length);
      for (let j = i; j < end; j++) sum += ch0[j] * ch0[j];
      const rms = Math.sqrt(sum / (end - i));
      const isSilent = rms < threshold;
      const tMs = (i / sr) * 1000;
      if (isSilent) {
        if (silentStart === null) silentStart = tMs;
      } else if (silentStart !== null) {
        const dur = tMs - silentStart;
        if (dur >= minSilenceMs) gaps.push({ startMs: silentStart, endMs: tMs });
        silentStart = null;
      }
    }
    return gaps;
  } finally {
    ctx.close?.();
  }
}

/** Split long Whisper segments on silence gaps that fall inside them. */
export function splitOnSilence(segments: WhisperSegment[], gaps: SilenceGap[]): WhisperSegment[] {
  if (gaps.length === 0) return segments;
  const out: WhisperSegment[] = [];
  for (const seg of segments) {
    const inside = gaps.filter((g) => g.startMs > seg.startMs + 800 && g.endMs < seg.endMs - 400);
    if (inside.length === 0) {
      out.push(seg);
      continue;
    }
    // Rough split: divide text proportionally by time weights.
    const boundaries = [seg.startMs, ...inside.map((g) => (g.startMs + g.endMs) / 2), seg.endMs];
    const pieces = boundaries.length - 1;
    // Split text by sentence delimiters if possible, else evenly.
    const parts = splitTextIntoParts(seg.text, pieces);
    for (let i = 0; i < pieces; i++) {
      const text = parts[i]?.trim();
      if (!text) continue;
      out.push({ startMs: Math.round(boundaries[i]), endMs: Math.round(boundaries[i + 1]), text });
    }
  }
  return out;
}

function splitTextIntoParts(text: string, n: number): string[] {
  if (n <= 1) return [text];
  // Prefer sentence boundaries
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  if (sentences.length >= n) {
    // Group sentences into n roughly equal buckets by char length.
    const target = text.length / n;
    const out: string[] = [];
    let cur = "";
    let cumLen = 0;
    let bucket = 0;
    for (const s of sentences) {
      cur += (cur ? " " : "") + s;
      cumLen += s.length + 1;
      if (cumLen >= target * (bucket + 1) && bucket < n - 1) {
        out.push(cur);
        cur = "";
        bucket++;
      }
    }
    if (cur) out.push(cur);
    while (out.length < n) out.push("");
    return out;
  }
  // Fallback: character split
  const chunk = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push(text.slice(i, i + chunk));
  while (out.length < n) out.push("");
  return out;
}

/** Clamp segment duration and merge tiny ones. */
export function normalizeSegments(segments: WhisperSegment[]): WhisperSegment[] {
  const MIN = 800;
  const MAX = 12000;
  const out: WhisperSegment[] = [];
  for (const s of segments) {
    if (s.endMs - s.startMs < MIN && out.length > 0) {
      const prev = out[out.length - 1];
      prev.text = (prev.text + " " + s.text).trim();
      prev.endMs = s.endMs;
      continue;
    }
    if (s.endMs - s.startMs > MAX) {
      out.push({ ...s, endMs: s.startMs + MAX });
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/**
 * First moment in the file where the signal rises above the silence threshold.
 * Whisper reports the first segment as starting at 0 even when the track opens
 * with an intro, so we use this to move it to the real vocal onset.
 */
export async function findFirstVoiceOnsetMs(
  file: File,
  opts: SilenceOptions = {},
): Promise<number> {
  const threshold = opts.threshold ?? 0.012;
  const windowMs = opts.windowMs ?? 20;
  const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioCtx) return 0;
  const ctx = new AudioCtx();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const sr = audio.sampleRate;
    const ch0 = audio.getChannelData(0);
    const winSamples = Math.max(1, Math.floor((windowMs / 1000) * sr));
    for (let i = 0; i < ch0.length; i += winSamples) {
      let sum = 0;
      const end = Math.min(i + winSamples, ch0.length);
      for (let j = i; j < end; j++) sum += ch0[j] * ch0[j];
      if (Math.sqrt(sum / (end - i)) >= threshold) return Math.round((i / sr) * 1000);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    ctx.close?.();
  }
}

/**
 * Move segment starts off silence: the first segment snaps to the real audio
 * onset, and any later segment starting inside a silent gap snaps to that
 * gap's end.
 */
export function snapSegmentStarts(
  segments: WhisperSegment[],
  gaps: SilenceGap[],
  onsetMs: number,
): WhisperSegment[] {
  const FLOOR = 200;
  return segments.map((s, idx) => {
    let start = s.startMs;
    if (idx === 0 && onsetMs > start) start = onsetMs;
    const gap = gaps.find((g) => start >= g.startMs && start < g.endMs);
    if (gap && gap.endMs > start) start = gap.endMs;
    if (start > s.endMs - FLOOR) start = Math.max(s.startMs, s.endMs - FLOOR);
    return { ...s, startMs: Math.max(0, Math.round(start)) };
  });
}
