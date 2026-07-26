// src/components/LyricsDialog.tsx

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2, Mic, Download, Check, Sparkles, Languages, Play, Pause } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import {
  serializeSylt,
  parseSylt,
  formatSyltTime,
  type SyltLine,
} from "@/lib/id3";
import type { WhisperLang } from "@/lib/whisper/transcribe";
import { WHISPER_MODEL_SIZE_LABELS } from "@/lib/engine-assets";

type Mode = "uslt" | "sylt";

const LANG_STORAGE_KEY = "audiofly.whisper.lang";
const MODE_STORAGE_KEY = "audiofly.lyrics.mode";

const readSavedMode = (): Mode => {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "uslt" || saved === "sylt") return saved;
  } catch {}
  return "sylt";
};

export interface LyricsSongInfo {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: string;
  genre?: string;
}

export interface LyricsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mp3File: File | null;
  initialLyrics: string;
  initialSynced: SyltLine[];
  initialMode?: Mode;
  songInfo?: LyricsSongInfo;
  onSave: (payload: { lyrics: string; syncedLyrics: SyltLine[]; mode: Mode }) => void;
}


export function LyricsDialog({
  open,
  onOpenChange,
  mp3File,
  initialLyrics,
  initialSynced,
  initialMode,
  songInfo,
  onSave,
}: LyricsDialogProps) {

  const [mode, setMode] = useState<Mode>(initialMode ?? (initialSynced.length > 0 ? "sylt" : "sylt"));
  const [usltDraft, setUsltDraft] = useState(initialLyrics);
  const [syltDraft, setSyltDraft] = useState(serializeSylt(initialSynced));
  const [busy, setBusy] = useState<null | "model" | "transcribe" | "download">(null);
  const [modelPct, setModelPct] = useState(0);
  const [asrPct, setAsrPct] = useState(0);
  const [lang, setLang] = useState<WhisperLang>("ko");
  const [modelReady, setModelReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsltDraft(initialLyrics);
    setSyltDraft(serializeSylt(initialSynced));
    setMode(initialMode ?? (initialSynced.length > 0 ? "sylt" : "uslt"));
    setBusy(null);
    setModelPct(0);
    setAsrPct(0);
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "ko" || saved === "en") setLang(saved);
    } catch {}
  }, [open, initialLyrics, initialSynced, initialMode]);

  // 언어가 바뀔 때마다 해당 언어 모델의 캐시 상태를 재조회
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setModelReady(null);
      try {
        const { isWhisperModelCached } = await import("@/lib/whisper/transcribe");
        const ok = await isWhisperModelCached(lang);
        if (!cancelled) setModelReady(ok);
      } catch {
        if (!cancelled) setModelReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, lang]);

  const persistLang = (v: WhisperLang) => {
    setLang(v);
    try { localStorage.setItem(LANG_STORAGE_KEY, v); } catch {}
  };

  const handleDownloadModel = async () => {
    setBusy("download");
    setModelPct(0);
    try {
      const { downloadWhisperModel } = await import("@/lib/whisper/transcribe");
      await downloadWhisperModel(lang, (loaded, total) => {
        setModelPct(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
      });
      setModelReady(true);
      toast.success(`${lang === "ko" ? "Korean" : "English"} speech module installed.`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ?? "Failed to download module.");
    } finally {
      setBusy(null);
    }
  };

  // ---- Local audio player (offline, object URL only) ----
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const seekingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setCurrentMs(0);
    setDurationMs(0);
    if (!mp3File) {
      audioRef.current = null;
      return;
    }
    const url = URL.createObjectURL(mp3File);
    const audio = new Audio(url);
    audio.preload = "metadata";
    audioRef.current = audio;

    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDurationMs(audio.duration * 1000);
    };
    const onEnded = () => {
      setPlaying(false);
      setCurrentMs(0);
    };
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnded);
      audioRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [mp3File, open]);

  // Smooth playhead updates while playing
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      const audio = audioRef.current;
      if (audio && !seekingRef.current) setCurrentMs(audio.currentTime * 1000);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  // Pause when the dialog closes or a heavy task starts
  useEffect(() => {
    if (!open || busy !== null) {
      audioRef.current?.pause();
      setPlaying(false);
    }
  }, [open, busy]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const onSeekChange = (vals: number[]) => {
    seekingRef.current = true;
    setCurrentMs(vals[0] ?? 0);
  };

  const onSeekCommit = (vals: number[]) => {
    const ms = vals[0] ?? 0;
    const audio = audioRef.current;
    if (audio) audio.currentTime = ms / 1000;
    setCurrentMs(ms);
    seekingRef.current = false;
  };


  const runTranscription = async () => {
    if (!mp3File) {
      toast.error("Please choose an MP3 file first.");
      return;
    }
    if (!modelReady) {
      toast.error("Please run 'Download module' first.");
      return;
    }
    setBusy("model");
    setModelPct(0);
    setAsrPct(0);
    setSyltDraft("");
    try {
      const [{ transcribeMp3 }, { detectSilenceGaps, splitOnSilence, normalizeSegments }] = await Promise.all([
        import("@/lib/whisper/transcribe"),
        import("@/lib/whisper/segment"),
      ]);

      const gapsPromise = detectSilenceGaps(mp3File).catch(() => []);

      const raw = await transcribeMp3(mp3File, {
        lang,
        onModelProgress: (loaded, total) => {
          setBusy("model");
          setModelPct(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
        },
        onProgress: (p) => {
          setBusy("transcribe");
          setAsrPct(Math.min(100, Math.round(p)));
        },
        onSegment: (seg) => {
          setSyltDraft((prev) => `${prev}${prev ? "\n" : ""}[${formatSyltTime(seg.startMs)}] ${seg.text}`);
        },
      });

      const gaps = await gapsPromise;
      const merged = normalizeSegments(splitOnSilence(raw, gaps));
      const syltLines: SyltLine[] = merged.map((s) => ({ timeMs: s.startMs, text: s.text }));
      setSyltDraft(serializeSylt(syltLines));
      setMode("sylt");
      toast.success(`Extracted ${syltLines.length} lines.`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ?? "Speech recognition failed.");
    } finally {
      setBusy(null);
    }
  };

  const handleSave = () => {
    const parsed = mode === "sylt" ? parseSylt(syltDraft) : [];
    const usltFromSylt = parsed.map((l) => l.text).join("\n");
    onSave({
      lyrics: mode === "sylt" ? usltFromSylt : usltDraft,
      syncedLyrics: parsed,
      mode,
    });
    onOpenChange(false);
  };

  const buildSongInfoBlock = (): string => {
    const s = songInfo ?? {};
    const rows: string[] = [];
    if (s.title) rows.push(`Title: ${s.title}`);
    if (s.artist) rows.push(`Artist: ${s.artist}`);
    if (s.albumArtist) rows.push(`Album Artist: ${s.albumArtist}`);
    if (s.album) rows.push(`Album: ${s.album}`);
    if (s.trackNumber) rows.push(`Track #: ${s.trackNumber}`);
    if (s.genre) rows.push(`Genre: ${s.genre}`);
    return rows.length > 0 ? rows.join("\n") : "(no metadata available)";
  };

  const openGeminiWithPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("Prompt copied to clipboard.");
    } catch {
      toast.message("Open Gemini and paste the prompt if it isn't pre-filled.");
    }
    const url = `https://gemini.google.com/app?q=${encodeURIComponent(prompt)}`;
    window.open(url, "_blank", "noopener");
  };

  const hasSyltLines = parseSylt(syltDraft).length > 0;

  const handleFixWithGemini = () => {
    if (!hasSyltLines) {
      toast.error("No timestamped lyrics to fix yet.");
      return;
    }
    const prompt =
      `You are an expert lyric transcription editor. The following are auto-transcribed song lyrics in SYLT format (one line per entry, each starting with a [mm:ss.xx] timestamp). Some words are misheard or incorrect.\n\n` +
      `Using the song metadata below as context, correct only the misheard or wrong words. Requirements:\n` +
      `- Keep EVERY [mm:ss.xx] timestamp exactly as-is (do not shift, add, or remove any).\n` +
      `- Keep the same number of lines and the same order.\n` +
      `- Do not merge or split lines.\n` +
      `- Return ONLY the corrected SYLT block. No commentary, no code fences, no extra text.\n\n` +
      `Song metadata:\n${buildSongInfoBlock()}\n\n` +
      `Current SYLT lyrics:\n${syltDraft.trim()}\n`;
    void openGeminiWithPrompt(prompt);
  };

  const handleTranslateWithGemini = () => {
    if (!hasSyltLines) {
      toast.error("No timestamped lyrics to translate yet.");
      return;
    }
    const prompt =
      `Translate the following SYLT-format song lyrics into natural Korean. For each line, keep the original text and append the Korean translation in parentheses on the same line.\n\n` +
      `Requirements:\n` +
      `- Keep EVERY [mm:ss.xx] timestamp exactly as-is (do not shift, add, or remove any).\n` +
      `- Keep the same number of lines and the same order.\n` +
      `- Output line format: [mm:ss.xx] original line (한국어 번역)\n` +
      `- Return ONLY the resulting SYLT block. No commentary, no code fences, no extra text.\n\n` +
      `Song metadata (for context):\n${buildSongInfoBlock()}\n\n` +
      `Current SYLT lyrics:\n${syltDraft.trim()}\n`;
    void openGeminiWithPrompt(prompt);
  };



  const insertTimestampAtCursor = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const now = formatSyltTime(0);
    const s = el.selectionStart;
    const before = syltDraft.slice(0, s);
    const after = syltDraft.slice(s);
    setSyltDraft(before + now + " " + after);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Lyrics</DialogTitle>
          <DialogDescription>
            {mode === "uslt"
              ? "Saved to the standard lyrics (USLT) frame."
              : "Saved as timestamped lyrics (SYLT + USLT). Line format: [mm:ss.xx] lyric"}
          </DialogDescription>
        </DialogHeader>

        {mode === "uslt" ? (
          <Textarea
            value={usltDraft}
            onChange={(e) => setUsltDraft(e.target.value)}
            placeholder="Paste lyrics here"
            className="min-h-[38vh]"
          />
        ) : (
          <div className="space-y-2">
            {/* Module status + language toggle */}
            <div className="flex items-center justify-between gap-2 rounded-md border p-2">
              <div className="flex items-center gap-2 text-[12px]">
                {modelReady ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                    <Check className="h-3.5 w-3.5" /> Module: installed
                  </span>
                ) : (
                  <span className="text-muted-foreground">Module: not installed ({WHISPER_MODEL_SIZE_LABELS[lang]})</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => persistLang("ko")}
                  className={`px-2 py-1 rounded text-[12px] border ${lang === "ko" ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}
                  disabled={busy !== null}
                >
                  Korean
                </button>
                <button
                  type="button"
                  onClick={() => persistLang("en")}
                  className={`px-2 py-1 rounded text-[12px] border ${lang === "en" ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}
                  disabled={busy !== null}
                >
                  English
                </button>
              </div>
            </div>

            {/* Module download / delete */}
            {!modelReady && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleDownloadModel}
                  disabled={busy !== null}
                >
                  {busy === "download" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-1.5 h-4 w-4" />
                  )}
                  Download speech module
                </Button>
                {busy === "download" && (
                  <div className="flex-1 flex items-center gap-2">
                    <Progress value={modelPct} className="h-2" />
                    <span className="text-[11px] text-muted-foreground w-14 text-right">{modelPct}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={runTranscription}
                disabled={!mp3File || busy !== null || !modelReady}
              >
                {busy === "model" || busy === "transcribe" ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Mic className="mr-1.5 h-4 w-4" />
                )}
                Auto-extract from audio
              </Button>
              {busy === "model" && (
                <div className="flex-1 flex items-center gap-2">
                  <Progress value={modelPct} className="h-2" />
                  <span className="text-[11px] text-muted-foreground w-14 text-right">Model {modelPct}%</span>
                </div>
              )}
              {busy === "transcribe" && (
                <div className="flex-1 flex items-center gap-2">
                  <Progress value={asrPct} className="h-2" />
                  <span className="text-[11px] text-muted-foreground w-14 text-right">ASR {asrPct}%</span>
                </div>
              )}
            </div>

            {/* Gemini-assisted helpers (use current SYLT + ID3 context) */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleFixWithGemini}
                disabled={busy !== null || !hasSyltLines}
                title="Build a prompt to fix misheard words and open Gemini"
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                Fix with Gemini
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleTranslateWithGemini}
                disabled={busy !== null || !hasSyltLines}
                title="Build a prompt to translate lyrics into Korean and open Gemini"
              >
                <Languages className="mr-1.5 h-4 w-4" />
                Translate (KR) with Gemini
              </Button>
            </div>

            {/* Audio player: scrub the track and read exact timestamps */}
            <div className="space-y-1.5 rounded-md border p-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="h-8 w-8 rounded-full shrink-0"
                  onClick={togglePlay}
                  disabled={!mp3File || busy !== null}
                  title={playing ? "Pause" : "Play"}
                >
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <span className="font-mono text-[12px] tabular-nums">
                  {formatSyltTime(Math.round(currentMs))}
                  <span className="text-muted-foreground"> / {formatSyltTime(Math.round(durationMs))}</span>
                </span>
              </div>
              <Slider
                value={[Math.min(currentMs, durationMs || 0)]}
                max={durationMs || 1}
                step={10}
                disabled={!mp3File || durationMs <= 0}
                onValueChange={onSeekChange}
                onValueCommit={onSeekCommit}
              />
            </div>


            <Textarea
              value={syltDraft}
              onChange={(e) => setSyltDraft(e.target.value)}
              onDoubleClick={(e) => insertTimestampAtCursor(e.currentTarget)}
              placeholder="[00:00.00] first line&#10;[00:03.42] second line"
              className="min-h-[30vh] font-mono text-[13px]"
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Download the module once while online — it then works offline.
              Recognition uses the selected language (Korean/English) and the result is editable.
            </p>
          </div>
        )}

        <DialogFooter className="!justify-between">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="uslt">USLT</TabsTrigger>
              <TabsTrigger value="sylt">SYLT</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={busy !== null}>
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
