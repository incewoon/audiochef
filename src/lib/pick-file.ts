// File picker helper. Prefers File System Access API (`showOpenFilePicker`)
// so we get the *real* filename from the filesystem (Android Chrome's media
// picker otherwise returns MediaStore numeric names like "13952.mp4"),
// and falls back to a hidden <input type="file"> click.

import { beginPickerGuard } from "./picker-history-guard";

export type AcceptMap = Record<string, string[]>;

export async function pickFileNative(opts: {
  description: string;
  accept: AcceptMap;
}): Promise<File | null> {
  const anyWin = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  };
  if (typeof anyWin.showOpenFilePicker !== "function") return null;
  const release = beginPickerGuard();
  try {
    const [handle] = await anyWin.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [{ description: opts.description, accept: opts.accept }],
    });
    return await handle.getFile();
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "AbortError") return null;
    // Not supported / user gesture missing / etc. — silent fallback.
    return null;
  } finally {
    window.setTimeout(release, 300);
  }
}
