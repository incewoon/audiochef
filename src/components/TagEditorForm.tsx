// src/components/TagEditorForm.tsx

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, Upload, Music, FileText, Image as ImageIcon, ArrowLeftRight, Search } from "lucide-react";
import { tagExistingMp3, type Id3Cover, type SyltLine } from "@/lib/id3";
import { readId3Tags } from "@/lib/id3-read";
import { pickFileNative } from "@/lib/pick-file";
import { clickFileInputGuarded } from "@/lib/picker-history-guard";
import { LyricsDialog } from "@/components/LyricsDialog";

type Status = "idle" | "reading" | "saving";

/** Build a Google Images query from available ID3 values, skipping empties/duplicates. */
function buildCoverQuery(parts: Array<string | undefined>): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const p of parts) {
    const v = (p ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(v);
  }
  return words.join(" ");
}


export function TagEditorForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [album, setAlbum] = useState("");
  const [trackNumber, setTrackNumber] = useState("");
  const [genre, setGenre] = useState("");

  const [lyrics, setLyrics] = useState("");
  const [syncedLyrics, setSyncedLyrics] = useState<SyltLine[]>([]);
  const [lyricsOpen, setLyricsOpen] = useState(false);

  const [cover, setCover] = useState<Id3Cover | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverOpen, setCoverOpen] = useState(false);

  const busy = status !== "idle";

  useEffect(() => {
    return () => {
      if (coverPreview) URL.revokeObjectURL(coverPreview);
    };
  }, [coverPreview]);

  const resetAll = () => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setTitle("");
    setArtist("");
    setAlbumArtist("");
    setAlbum("");
    setTrackNumber("");
    setGenre("");
    setLyrics("");
    setSyncedLyrics([]);
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCover(null);
    setCoverPreview(null);
    setStatus("idle");
  };

  const handleFile = async (f: File | null) => {
    if (!f) return;
    // clear previous cover preview
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCover(null);
    setCoverPreview(null);

    setFile(f);
    setStatus("reading");
    const tags = await readId3Tags(f);
    setTitle(tags.title ?? "");
    setArtist(tags.artist ?? "");
    setAlbumArtist(tags.albumArtist ?? "");
    setAlbum(tags.album ?? "");
    setTrackNumber(tags.trackNumber ?? "");
    setGenre(tags.genre ?? "");
    setLyrics(tags.lyrics ?? "");
    setSyncedLyrics(tags.syncedLyrics ?? []);
    if (tags.cover) {
      setCover({ data: tags.cover.data, mime: tags.cover.mime });
      setCoverPreview(tags.cover.previewUrl);
    }
    setStatus("idle");
    toast.success("Existing tags loaded.");
  };

  const openMp3Picker = async () => {
    const f = await pickFileNative({
      description: "MP3 Audio",
      accept: { "audio/mpeg": [".mp3"] },
    });
    if (f) {
      handleFile(f);
      return;
    }
    clickFileInputGuarded(fileRef.current);
  };


  const handleCoverPick = async (f: File | null) => {
    if (!f) return;
    if (!["image/jpeg", "image/png"].includes(f.type)) {
      toast.error("Only JPEG or PNG images are supported.");
      return;
    }
    if (f.size > 1024 * 1024) {
      toast.warning("Image is larger than 1MB. Some players may not display it.");
    }
    const buf = await f.arrayBuffer();
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCover({ data: buf, mime: f.type });
    setCoverPreview(URL.createObjectURL(f));
  };

  const clearCover = () => {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCover(null);
    setCoverPreview(null);
  };

  const coverQuery = buildCoverQuery([artist, album, title]);

  const openCoverSearch = () => {
    if (!coverQuery) return;
    const q = encodeURIComponent(`${coverQuery} album cover`);
    window.open(
      `https://www.google.com/search?tbm=isch&q=${q}&tbs=isz:lt,islt:svga`,
      "_blank",
      "noopener,noreferrer",
    );
  };


  const handleSave = async () => {
    if (!file) {
      toast.error("Please choose an MP3 file first.");
      return;
    }
    try {
      setStatus("saving");
      const buffer = await file.arrayBuffer();
      const blob = tagExistingMp3(buffer, {
        title: title || undefined,
        artist: artist || undefined,
        albumArtist: albumArtist || undefined,
        album: album || undefined,
        trackNumber: trackNumber || undefined,
        genre: genre || undefined,
        lyrics: lyrics || undefined,
        syncedLyrics: syncedLyrics.length > 0 ? syncedLyrics : undefined,
        cover: cover ?? undefined,
      });

      const originalName = file.name;
      // Try File System Access API for real overwrite
      const anyWin = window as any;
      let saved = false;
      if (typeof anyWin.showSaveFilePicker === "function") {
        try {
          const handle = await anyWin.showSaveFilePicker({
            suggestedName: originalName,
            types: [{ description: "MP3 Audio", accept: { "audio/mpeg": [".mp3"] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          saved = true;
          toast.success("Tags saved.");
        } catch (err: any) {
          if (err?.name !== "AbortError") console.warn("showSaveFilePicker failed", err);
        }
      }
      if (!saved) {
        // Fallback: download with original filename
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = originalName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success("Tags saved. Overwrite the original with the file in your Downloads folder.");
      }
      resetAll();
    } catch (err) {
      console.error(err);
      setStatus("idle");
      toast.error("Failed to save tags.");
    }
  };

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
            <Music className="h-5 w-5 shrink-0" />
            <span className="truncate">Edit MP3 Tags</span>
          </CardTitle>
          <Link
            to="/"
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            MP4 → MP3
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept=".mp3"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          className="w-full min-h-11 justify-start gap-2 overflow-hidden px-3"
          onClick={openMp3Picker}
          disabled={busy}
        >
          <Upload className="h-4 w-4 shrink-0" />
          <span className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {file ? file.name : "Choose MP3 file"}
          </span>
          {status === "reading" && <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin" />}
        </Button>

        <div className="space-y-2.5">
          <div className="space-y-1">
            <Label htmlFor="t-title" className="text-xs">Title</Label>
            <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-artist" className="text-xs">Artist</Label>
            <Input id="t-artist" value={artist} onChange={(e) => setArtist(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-albumArtist" className="text-xs">Album Artist</Label>
            <Input id="t-albumArtist" value={albumArtist} onChange={(e) => setAlbumArtist(e.target.value)} className="h-9" />
          </div>
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <div className="space-y-1 min-w-0">
              <Label htmlFor="t-album" className="text-xs">Album</Label>
              <Input id="t-album" value={album} onChange={(e) => setAlbum(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-track" className="text-xs">Track #</Label>
              <Input id="t-track" inputMode="numeric" value={trackNumber} onChange={(e) => setTrackNumber(e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-genre" className="text-xs">Genre</Label>
            <Input id="t-genre" value={genre} onChange={(e) => setGenre(e.target.value)} className="h-9" />
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setLyricsOpen(true)}
            >
              <FileText className="mr-1.5 h-4 w-4" />
              Lyrics{lyrics || syncedLyrics.length > 0 ? " ✓" : ""}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setCoverOpen(true)}
            >
              <ImageIcon className="mr-1.5 h-4 w-4" />
              Album art{cover ? " ✓" : ""}
            </Button>
          </div>
        </div>

        <Button
          type="button"
          className="w-full min-h-12 text-base"
          onClick={handleSave}
          disabled={busy || !file}
        >
          {status === "saving" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {status === "saving" ? "Saving…" : "Save tags (overwrite source)"}
        </Button>

        <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
          All editing happens in your browser. Files are never uploaded to any server.
        </p>
      </CardContent>

      {/* Lyrics editor dialog (USLT/SYLT toggle + speech recognition) */}
      <LyricsDialog
        open={lyricsOpen}
        onOpenChange={setLyricsOpen}
        mp3File={file}
        initialLyrics={lyrics}
        initialSynced={syncedLyrics}
        initialMode={syncedLyrics.length > 0 ? "sylt" : undefined}
        songInfo={{ title, artist, albumArtist, album, trackNumber, genre }}
        onSave={({ lyrics: l, syncedLyrics: sl }) => {
          setLyrics(l);
          setSyncedLyrics(sl);
        }}
      />



      {/* Album art dialog */}
      <Dialog open={coverOpen} onOpenChange={setCoverOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Album Art (APIC)</DialogTitle>
            <DialogDescription>
              Recommended 500×500–1000×1000 px square · max 1MB · JPEG or PNG
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => handleCoverPick(e.target.files?.[0] ?? null)}
            />

            <Button
              type="button"
              variant="secondary"
              className="w-full min-h-11"
              disabled={!coverQuery}
              onClick={openCoverSearch}
            >
              <Search className="mr-2 h-4 w-4" /> Search album art on Google
            </Button>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {coverQuery
                ? "Long-press an image to save it, then load it with “Choose image”."
                : "Enter a title, artist, or album first to search."}
            </p>

            {coverPreview ? (
              <div className="flex items-center gap-3">
                <img src={coverPreview} alt="cover preview" className="h-24 w-24 rounded object-cover border" />
                <div className="flex flex-col gap-2">
                  <Button size="sm" variant="outline" onClick={() => clickFileInputGuarded(coverInputRef.current)}>Change image</Button>
                  <Button size="sm" variant="ghost" onClick={clearCover}>Remove</Button>
                </div>
              </div>
            ) : (
              <Button variant="outline" className="w-full min-h-11" onClick={() => clickFileInputGuarded(coverInputRef.current)}>
                <Upload className="mr-2 h-4 w-4" /> Choose image
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setCoverOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
