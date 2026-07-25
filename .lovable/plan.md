## 1. Bug fix — SYLT round-trip in tag editor

**Root cause (verified):** `jsmediatags` has no dedicated SYLT decoder — it only registers "SYLT" as a known frame ID and returns the raw frame bytes. `src/lib/id3-read.ts` looks for a pre-parsed `synchronisedText` array that never exists, so `syncedLyrics` always comes back empty. On re-open the dialog sees `initialSynced=[]` and falls back to USLT mode, and even when the user toggles to SYLT the box is empty.

**Fix in `src/lib/id3-read.ts`:**
- Add a raw ID3v2 SYLT parser that walks the file's ID3 header directly (read tag size from bytes 6–9, iterate 10-byte frame headers, handle v2.3/v2.4 size formats and the unsynchronisation flag) and decodes any `SYLT` frame per the ID3v2 spec: 1 byte text-encoding, 3 bytes language, 1 byte timestamp format (2 = ms), 1 byte content type, null-terminated descriptor, then repeating `<text><null><4-byte BE timestamp>` entries. Supports encodings 0 (ISO-8859-1), 1 (UTF-16 with BOM), 2 (UTF-16BE), 3 (UTF-8).
- Return `{ timeMs, text }[]` and merge it into the existing `readId3Tags` result (keep the `jsmediatags` path for the other frames so nothing else regresses).

**Fix in `src/components/TagEditorForm.tsx`:** pass `initialMode={syncedLyrics.length > 0 ? "sylt" : "uslt"}` to `<LyricsDialog>` so a file that already has SYLT opens in SYLT mode with the timestamped lines visible and editable. `LyricsDialog` already accepts `initialMode`.

## 2. Feature — "Fix lyrics with Gemini" button (SYLT dialog)

In `src/components/LyricsDialog.tsx`, add a new secondary button next to "Auto-extract from audio", enabled only when the SYLT textarea currently contains at least one `[mm:ss.xx] …` line.

Behavior on click:
- Build a prompt in code from (a) the current SYLT text in the textarea and (b) any known ID3 context passed in from the parent (title / artist / album / albumArtist / trackNumber / genre). To carry that context, extend `LyricsDialogProps` with an optional `songInfo` field and pass it from `TagEditorForm` (and, harmlessly, an empty object from `ConverterForm`).
- Prompt template (English, fixed): asks Gemini to correct misheard words in the lyrics using the song metadata as context, keep every `[mm:ss.xx]` timestamp exactly as-is, preserve line count and order, and return only the corrected SYLT block with no commentary.
- Copy the prompt to the clipboard (`navigator.clipboard.writeText`), toast "Prompt copied — paste it into Gemini", then open `https://gemini.google.com/app?q=<encoded prompt>` in a new tab via `window.open(url, "_blank", "noopener")`. Gemini's web UI reads the `q` query parameter and pre-fills the input; the clipboard copy is the guaranteed fallback if the URL is truncated or ignored.

No network call and no API key — this is a pure client-side prompt builder + deep link, so it works with the app's offline-first constraint (the button just needs the browser to reach Gemini when the user actually runs it).

## 3. Feature — "Translate to Korean" button (SYLT dialog)

Same pattern as #2, second new button, also gated on the SYLT textarea containing timestamped lines.

Prompt template (English): asks Gemini to translate each lyric line into natural Korean and return the same SYLT block with the Korean translation appended in parentheses after the original text on the same line, keeping every `[mm:ss.xx]` timestamp and line order untouched. Example line format spelled out in the prompt: `[00:12.34] original english line (한국어 번역)`.

Same delivery: copy to clipboard + `window.open("https://gemini.google.com/app?q=...")`. User runs it manually in Gemini and pastes the result back into the SYLT box.

## Technical notes

- Only three files change: `src/lib/id3-read.ts` (SYLT decoder), `src/components/TagEditorForm.tsx` (pass `initialMode` + `songInfo`), `src/components/LyricsDialog.tsx` (two new buttons + optional `songInfo` prop). `ConverterForm` gets a one-line prop pass-through (empty `songInfo`) so its call site stays type-safe.
- No changes to `id3.ts` writer, ffmpeg, service worker, engine assets, or Whisper code — writer already emits SYLT correctly (verified in `src/lib/id3.ts`), the bug is only on the read side.
- Gemini deep-link URL uses `https://gemini.google.com/app?q=<encodeURIComponent(prompt)>`. Very long prompts may be truncated by the browser URL cap, which is why we always copy to clipboard first and surface a toast telling the user to paste if the prefill is missing.
- Button labels (English, matches existing UI copy): "Fix with Gemini" and "Translate (KR) with Gemini". Both disabled while `busy !== null` or when `parseSylt(syltDraft).length === 0`.