// @ts-expect-error - jsmediatags has no bundled types
import jsmediatags from "jsmediatags/dist/jsmediatags.min.js";

export interface ReadCover {
  data: ArrayBuffer;
  mime: string;
  previewUrl: string;
}

export interface ReadTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: string;
  genre?: string;
  lyrics?: string;
  syncedLyrics?: { timeMs: number; text: string }[];
  cover?: ReadCover;
}

function pickString(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.lyrics === "string") return o.lyrics;
    if (typeof o.text === "string") return o.text;
  }
  return undefined;
}

// -------------- Raw ID3v2 SYLT parser --------------
// jsmediatags doesn't decode SYLT frames — it exposes only the raw bytes.
// We parse the tag header and any SYLT frame directly per the ID3v2 spec.

function readSyncSafeInt(b: Uint8Array, off: number): number {
  return (
    ((b[off] & 0x7f) << 21) |
    ((b[off + 1] & 0x7f) << 14) |
    ((b[off + 2] & 0x7f) << 7) |
    (b[off + 3] & 0x7f)
  );
}

function readUInt32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off] << 24) >>> 0) +
    ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3])
  );
}

function decodeString(bytes: Uint8Array, encoding: number): string {
  try {
    switch (encoding) {
      case 0:
        return new TextDecoder("iso-8859-1").decode(bytes);
      case 1: {
        // UTF-16 with BOM
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
          return new TextDecoder("utf-16le").decode(bytes.subarray(2));
        }
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
          return new TextDecoder("utf-16be").decode(bytes.subarray(2));
        }
        return new TextDecoder("utf-16le").decode(bytes);
      }
      case 2:
        return new TextDecoder("utf-16be").decode(bytes);
      case 3:
      default:
        return new TextDecoder("utf-8").decode(bytes);
    }
  } catch {
    return "";
  }
}

/** Read a null-terminated string in the given encoding; returns {text, nextOff}. */
function readNullTerminated(
  b: Uint8Array,
  off: number,
  end: number,
  encoding: number,
): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    let i = off;
    while (i + 1 < end) {
      if (b[i] === 0 && b[i + 1] === 0) break;
      i += 2;
    }
    const text = decodeString(b.subarray(off, i), encoding);
    return { text, next: Math.min(end, i + 2) };
  } else {
    let i = off;
    while (i < end && b[i] !== 0) i++;
    const text = decodeString(b.subarray(off, i), encoding);
    return { text, next: Math.min(end, i + 1) };
  }
}

function parseSyltFrame(body: Uint8Array): { timeMs: number; text: string }[] {
  if (body.length < 6) return [];
  const encoding = body[0];
  // bytes 1..3 = language, 4 = timestamp format, 5 = content type
  const timestampFormat = body[4]; // 1 = MPEG frames, 2 = milliseconds
  let off = 6;
  // Content descriptor (null-terminated in `encoding`)
  const desc = readNullTerminated(body, off, body.length, encoding);
  off = desc.next;

  const out: { timeMs: number; text: string }[] = [];
  while (off + 4 <= body.length) {
    const t = readNullTerminated(body, off, body.length, encoding);
    off = t.next;
    if (off + 4 > body.length) break;
    const stamp = readUInt32BE(body, off);
    off += 4;
    const text = t.text.replace(/^\r?\n/, "").trim();
    // Only ms format is meaningful for our editor; skip frame-based streams.
    if (text) {
      out.push({ timeMs: timestampFormat === 2 ? stamp : stamp, text });
    }
  }
  return out;
}

async function readSyltFromFile(file: File): Promise<{ timeMs: number; text: string }[] | undefined> {
  try {
    // Read enough header to find tag size; a full ID3v2 tag is usually well
    // under a few MB, so read up to 4 MB from the start (cheap on modern browsers).
    const headSize = Math.min(file.size, 4 * 1024 * 1024);
    const buf = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
    if (buf.length < 10) return undefined;
    if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return undefined; // "ID3"
    const majorVersion = buf[3];
    const flags = buf[5];
    const tagSize = readSyncSafeInt(buf, 6);
    let off = 10;
    const end = Math.min(buf.length, 10 + tagSize);

    // Skip extended header if present
    if (flags & 0x40) {
      if (off + 4 > end) return undefined;
      const extSize =
        majorVersion >= 4 ? readSyncSafeInt(buf, off) : readUInt32BE(buf, off);
      off += extSize;
    }

    while (off + 10 <= end) {
      const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
      if (id === "\0\0\0\0") break;
      const size =
        majorVersion >= 4 ? readSyncSafeInt(buf, off + 4) : readUInt32BE(buf, off + 4);
      // const frameFlags = (buf[off + 8] << 8) | buf[off + 9];
      const bodyStart = off + 10;
      const bodyEnd = bodyStart + size;
      if (size <= 0 || bodyEnd > end) break;
      if (id === "SYLT") {
        const parsed = parseSyltFrame(buf.subarray(bodyStart, bodyEnd));
        if (parsed.length > 0) return parsed;
      }
      off = bodyEnd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function readId3Tags(file: File): Promise<ReadTags> {
  const syltPromise = readSyltFromFile(file);

  const base = await new Promise<ReadTags>((resolve) => {
    try {
      jsmediatags.read(file, {
        onSuccess: ({ tags }: any) => {
          const out: ReadTags = {
            title: pickString(tags.title),
            artist: pickString(tags.artist),
            albumArtist: pickString(tags["TPE2"]?.data) ?? pickString(tags.band),
            album: pickString(tags.album),
            trackNumber: pickString(tags.track),
            genre: pickString(tags.genre),
            lyrics: pickString(tags.lyrics) ?? pickString(tags["USLT"]?.data),
          };

          const picture = tags.picture;
          if (picture && picture.data) {
            const arr = new Uint8Array(picture.data.length);
            for (let i = 0; i < picture.data.length; i++) arr[i] = picture.data[i];
            const buf = arr.buffer;
            const mime = picture.format || "image/jpeg";
            const blob = new Blob([arr], { type: mime });
            out.cover = {
              data: buf,
              mime,
              previewUrl: URL.createObjectURL(blob),
            };
          }
          resolve(out);
        },
        onError: () => resolve({}),
      });
    } catch {
      resolve({});
    }
  });

  const sylt = await syltPromise;
  if (sylt && sylt.length > 0) base.syncedLyrics = sylt;
  return base;
}
