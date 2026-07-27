## 1. Cancelling the file picker kicks you back to the converter page

Observed behaviour: on `/tag-editor`, opening "Choose MP3 file" and then backing out of the system picker lands on `/` instead of the tag editor.

Likely cause (to confirm as the first implementation step): on Android Chrome the File System Access API is unavailable, so `pickFileNative` returns `null` and we fall back to clicking the hidden `<input type="file">`. Dismissing that system picker with the device Back gesture pops a browser history entry, so the router navigates from `/tag-editor` back to `/`.

Fix — add a history guard around every picker invocation:

- New helper (e.g. `src/lib/picker-history-guard.ts`) that, while a picker is open, pushes a sentinel history entry (`history.pushState({ afPicker: true }, "", location.href)`) and installs a `popstate` listener.
- If `popstate` fires while the guard is active, the guard just consumes the sentinel (no navigation happens) and re-arms nothing — the user stays on the current route.
- The guard is released when the picker resolves (file chosen, `change`/`cancel` event on the input, or window regains focus with a short debounce), removing the sentinel with `history.back()` only if it is still present, so normal back navigation keeps working afterwards.
- Wire the guard into `pickFileNative` (`src/lib/pick-file.ts`) and into the raw hidden-input `.click()` paths used by `TagEditorForm` (MP3 + album art inputs) and `ConverterForm` (MP4 input), so behaviour is consistent on both pages.

If a quick check shows the pop is caused by something else (e.g. a service-worker driven reload to `start_url: "/"`), the alternative fix is to persist the last route and restore it on load; the guard above is preferred because it doesn't touch the manifest.

## 2. First auto-extracted lyric line always starts at [00:00.00]

Cause: whisper.cpp reports the first segment's offset as `0` even when the track opens with an intro/silence, and `transcribeMp3` passes `offsets.from` straight through.

Fix in the extraction path (`src/components/LyricsDialog.tsx` post-processing plus a small helper in `src/lib/whisper/segment.ts`), reusing the existing `detectSilenceGaps` decoding:

- Add `findFirstVoiceOnsetMs(file)` (or derive it from the existing gap list): decode the MP3 once, find the first window whose RMS exceeds the speech threshold, and treat that as the real vocal onset.
- Add `snapSegmentStarts(segments, gaps, onsetMs)`:
  - If the first segment's `startMs` is earlier than the onset, move it to the onset (keeping `endMs`, and never letting start exceed end minus a small floor).
  - Apply the same rule to any later segment whose start falls inside a detected silence gap: shift it to the end of that gap. This also tightens mid-song lines, not just the first one.
- Run this before the existing `splitOnSilence` / `normalizeSegments` / SYLT-line mapping so both the live streaming preview and the final `SyltLine[]` use corrected times.
- Onset detection is a single extra decode of the already-loaded local file — fully offline, no new dependencies.

## Technical notes

- Files touched: `src/lib/pick-file.ts`, a new small history-guard module, `src/components/TagEditorForm.tsx`, `src/components/ConverterForm.tsx`, `src/lib/whisper/segment.ts`, `src/components/LyricsDialog.tsx`.
- No backend, manifest, ffmpeg, or ID3 format changes.
