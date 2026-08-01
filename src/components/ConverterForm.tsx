// src/components/ConverterForm.tsx

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { convertMp4ToMp3, type Mp3Quality } from "@/lib/convert";
import { writeId3Tags } from "@/lib/id3";
import { pickFileNative } from "@/lib/pick-file";
import { clickFileInputGuarded } from "@/lib/picker-history-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Upload, Music, Tag } from "lucide-react";
import { cn } from "@/lib/utils";


function stripExt(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

type Status = "idle" | "loading" | "converting" | "tagging" | "done";
type Preset = "1" | "2" | "3";

const PRESET_KEY = "audiofly:filename-preset";
const QUALITY_KEY = "audiofly:mp3-quality";

const QUALITY_OPTIONS: { value: Mp3Quality; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "Standard — CBR 128 kbps, smallest file" },
  { value: "high", label: "High", hint: "High — VBR ~190 kbps, best balance" },
  { value: "max", label: "Max", hint: "Max — CBR 320 kbps, largest file" },
];

const PRESET_LABELS: Record<Preset, string> = {
  "1": "Artist-Track-Title",
  "2": "Title-Artist",
  "3": "Title",
};

function buildFilename(preset: Preset, opts: { title: string; artist: string; trackNumber: string; fallback: string }) {
  const { title, artist, trackNumber, fallback } = opts;
  const parts =
    preset === "1" ? [artist, trackNumber, title]
    : preset === "2" ? [title, artist]
    : [title];
  const joined = parts.map((s) => s.trim()).filter(Boolean).join("-");
  return joined || fallback;
}

export function ConverterForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);

  const [filename, setFilename] = useState("");
  const [filenameEdited, setFilenameEdited] = useState(false);
  const [preset, setPreset] = useState<Preset>("1");

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [trackNumber, setTrackNumber] = useState("");
  const [album, setAlbum] = useState("");
  const [quality, setQuality] = useState<Mp3Quality>("high");

  // Load saved preset + quality on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PRESET_KEY);
      if (saved === "1" || saved === "2" || saved === "3") setPreset(saved);
      const q = localStorage.getItem(QUALITY_KEY);
      if (q === "standard" || q === "high" || q === "max") setQuality(q);
    } catch {
      /* ignore */
    }
  }, []);

  // Auto-fill filename when preset or source fields change (unless user has manually edited)
  useEffect(() => {
    if (!file) return;
    if (filenameEdited) return;
    const fallback = stripExt(file.name);
    setFilename(buildFilename(preset, { title, artist, trackNumber, fallback }));
  }, [preset, title, artist, trackNumber, file, filenameEdited]);

  const busy = status === "loading" || status === "converting" || status === "tagging";

  const statusLabel = useMemo(() => {
    switch (status) {
      case "loading": return "Loading engine…";
      case "converting": return `Converting… ${Math.round(progress * 100)}%`;
      case "tagging": return "Writing tags…";
      case "done": return "Done!";
      default: return "";
    }
  }, [status, progress]);

  const handleFile = (f: File | null) => {
    if (!f) return;
    setFile(f);
    const base = stripExt(f.name);
    setTitle(base);
    setFilename(base);
    setFilenameEdited(false);
    setStatus("idle");
    setProgress(0);
  };

  const handlePresetChange = (p: Preset) => {
    setPreset(p);
    setFilenameEdited(false);
    try {
      localStorage.setItem(PRESET_KEY, p);
    } catch {
      /* ignore */
    }
  };

  const handleConvert = async () => {
    if (!file) {
      toast.error("Please choose an MP4 file first.");
      return;
    }
    try {
      setStatus("loading");
      setProgress(0);
      const mp3 = await convertMp4ToMp3({
        file,
        onProgress: (r) => {
          setStatus("converting");
          setProgress(r);
        },
      });
      setStatus("tagging");
      const blob = writeId3Tags(mp3, {
        title: title || undefined,
        artist: artist || undefined,
        albumArtist: albumArtist || undefined,
        album: album || undefined,
        trackNumber: trackNumber || undefined,
      });
      const outName = `${(filename || stripExt(file.name)).trim() || "output"}.mp3`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus("done");
      setProgress(1);
      toast.success("Download complete", {
        action: {
          label: "Open",
          onClick: () => {
            // Web has no API to open the OS Downloads folder; open the file itself in a new tab.
            window.open(url, "_blank", "noopener");
          },
        },
        // Revoke after the toast disappears so the "Open" action still works.
        onAutoClose: () => URL.revokeObjectURL(url),
        onDismiss: () => URL.revokeObjectURL(url),
        duration: 10000,
      });
      // Full reset after successful download
      resetAll();
    } catch (err) {
      console.error(err);
      setStatus("idle");
      toast.error("Conversion failed. Check the console.");
    }
  };

  const resetAll = () => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setTitle("");
    setArtist("");
    setAlbumArtist("");
    setAlbum("");
    setTrackNumber("");
    setFilename("");
    setFilenameEdited(false);
    setPreset("1");
    try { localStorage.removeItem(PRESET_KEY); } catch { /* ignore */ }
    setProgress(0);
    setStatus("idle");
  };

  const openVideoPicker = async () => {
    const f = await pickFileNative({
      description: "MP4 Video",
      accept: { "video/mp4": [".mp4", ".m4v", ".mov"] },
    });
    if (f) {
      handleFile(f);
      return;
    }
    clickFileInputGuarded(fileRef.current);
  };


  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
            <Music className="h-5 w-5 shrink-0" />
            <span className="truncate">MP4 → MP3 Converter</span>
          </CardTitle>
          <Link
            to="/tag-editor"
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            <Tag className="h-3.5 w-3.5" />
            Edit MP3 Tags
          </Link>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Video file</Label>
          <input
            ref={fileRef}
            type="file"
            accept=".mp4,.m4v,.mov,video/mp4"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full min-h-12 justify-start gap-2 overflow-hidden px-3"
            onClick={openVideoPicker}
            disabled={busy}
          >
            <Upload className="h-4 w-4 shrink-0" />
            <span className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {file ? file.name : "Choose MP4 file"}
            </span>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="artist">Artist</Label>
            <Input id="artist" value={artist} onChange={(e) => setArtist(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="albumArtist">Album Artist</Label>
            <Input id="albumArtist" value={albumArtist} onChange={(e) => setAlbumArtist(e.target.value)} />
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="album">Album</Label>
              <Input id="album" value={album} onChange={(e) => setAlbum(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="track">Track #</Label>
              <Input id="track" inputMode="numeric" value={trackNumber} onChange={(e) => setTrackNumber(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="filename">Filename</Label>
            <Input
              id="filename"
              value={filename}
              onChange={(e) => {
                setFilename(e.target.value);
                setFilenameEdited(true);
              }}
              placeholder="output"
            />
            <div className="flex items-center gap-2 pt-1">
              {(["1", "2", "3"] as Preset[]).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => handlePresetChange(n)}
                  className={cn(
                    "h-11 w-11 shrink-0 rounded-md border text-base font-bold transition-colors",
                    preset === n
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background hover:bg-accent hover:text-accent-foreground",
                  )}
                  aria-pressed={preset === n}
                >
                  {n}
                </button>
              ))}
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                Preset: {PRESET_LABELS[preset]}
              </span>
            </div>
          </div>
        </div>

        <Button
          type="button"
          className="w-full min-h-12 text-base"
          onClick={handleConvert}
          disabled={busy || !file}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {busy ? statusLabel : "Convert & Download"}
        </Button>

        {(status === "converting" || status === "tagging" || status === "done") && (
          <div className="space-y-2">
            <Progress value={Math.round(progress * 100)} />
            <p className="text-xs text-muted-foreground text-center">{statusLabel}</p>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
          Everything runs in your browser. Files are never uploaded to any server.
        </p>
      </CardContent>
    </Card>
  );
}
