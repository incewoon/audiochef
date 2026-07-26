## 1. Remove the trash icon from the SYLT dialog

In `src/components/LyricsDialog.tsx`, delete the ghost `Button` with the `Trash2` icon that sits at the end of the "Auto-extract from audio" row (rendered when `modelReady && busy === null`). Also drop the now-unused `handleDeleteModel` function and the `Trash2` import. The `deleteWhisperModel` helper in `src/lib/whisper/transcribe.ts` stays untouched (unused, harmless).

## 2. New audio player row above the lyrics textarea

Placement: inside the SYLT branch, directly below the Gemini buttons row and above the SYLT `<Textarea>`.

Layout (two lines, compact, mobile-first):

```text
[ ▶ ]   00:12.34 / 03:41.08
[==============o---------------------]
```

- Row 1: a small round play/pause `Button` (`Play` / `Pause` from lucide-react) plus the current time in the same `[mm:ss.xx]` format used by SYLT (reuse `formatSyltTime`) and total duration.
- Row 2: a full-width shadcn `Slider` bound to current time; dragging seeks the audio.

Behavior:
- A hidden `<audio>` element (via `useRef`) whose `src` is an object URL created from `mp3File` with `URL.createObjectURL`, recreated whenever `mp3File` changes and revoked on cleanup / dialog close.
- Track `currentTime` with a `requestAnimationFrame` loop while playing (smooth enough to read hundredths), and `duration` from the `loadedmetadata` event; reset to 0 and pause when the dialog closes or `mp3File` changes.
- Slider: `onValueChange` updates displayed time and sets `audio.currentTime`; while dragging, suppress the rAF write-back so the thumb doesn't fight the playhead.
- Pause automatically on `ended`.
- When `mp3File` is null, render the row disabled with `00:00.00 / 00:00.00` so the layout stays stable.
- Auto-extract runs on the same file but does not need to interact with the player; if a transcription starts while audio is playing, pause it (`busy !== null` disables the play button).

This is enough to scrub the track and read the exact timestamp to type into the SYLT lines.

## Technical notes

- Single file changes: `src/components/LyricsDialog.tsx`. No changes to `id3.ts`, ffmpeg, whisper, or the service worker.
- `Slider` from `@/components/ui/slider` (shadcn) — if the file isn't present in the project it gets added from the standard shadcn source.
- Time formatting reuses the existing `formatSyltTime` export so the player's readout is copy-paste compatible with the SYLT textarea format.
- No autoplay, no network use — the object URL is fully local, so this works offline.
