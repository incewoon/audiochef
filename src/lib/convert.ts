//src/lib/convert.ts

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

import workerURL from "@ffmpeg/ffmpeg/worker?worker&url";

const LOAD_TIMEOUT_MS = 90_000;
const CONVERT_TIMEOUT_MS = 5 * 60_000;

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

const withTimeout = <T,>(p: Promise<T>, ms: number, tag: string) =>
  Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${tag} timed out after ${ms}ms`)), ms),
    ),
  ]);

export async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  const ff = new FFmpeg();
  const log = (msg: string) => {
    onLog?.(msg);
    console.log("[ffmpeg]", msg);
  };
  ff.on("log", ({ message }: { message: string }) => log(message));

  loadPromise = Promise.resolve()
    .then(async () => {
      log("loading single-thread ffmpeg core...");
      const coreBlobURL = await toBlobURL(coreURL, "text/javascript");
      const wasmBlobURL = await toBlobURL(wasmURL, "application/wasm");
      const classWorkerBlobURL = await toBlobURL(workerURL, "text/javascript");
      console.log("[ffmpeg] loading worker from blob URL", classWorkerBlobURL);
      
      await withTimeout(
        ff.load({
          coreURL: coreBlobURL,
          wasmURL: wasmBlobURL,
          classWorkerURL: classWorkerBlobURL,
        }),
        LOAD_TIMEOUT_MS,
        "ffmpeg.load()",
      );
    })
    .then(() => {
      log("ffmpeg core loaded (single-thread)");
      ffmpegInstance = ff;
      return ff;
    })
    .catch((err) => {
      loadPromise = null;
      try { ff.terminate(); } catch {}
      console.error("[ffmpeg] load failed", err);
      throw new Error(
        `Failed to load the conversion engine. (${err instanceof Error ? err.message : String(err)})`,
      );
    });

  return loadPromise;
}

export type Mp3Quality = "standard" | "high" | "max";

const QUALITY_ARGS: Record<Mp3Quality, string[]> = {
  standard: ["-b:a", "128k"],
  high: ["-q:a", "2"],
  max: ["-b:a", "320k"],
};

export interface ConvertOptions {
  file: File;
  quality?: Mp3Quality;
  onProgress?: (ratio: number) => void;
  onLog?: (msg: string) => void;
}

export async function convertMp4ToMp3({ file, quality = "high", onProgress, onLog }: ConvertOptions): Promise<Uint8Array> {
  const ff = await getFFmpeg(onLog);

  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  const inputName = "input.mp4";
  const outputName = "output.mp3";

  try {
    await ff.writeFile(inputName, await fetchFile(file));
    const exitCode = await withTimeout(
      ff.exec(
        ["-i", inputName, "-vn", "-codec:a", "libmp3lame", ...(QUALITY_ARGS[quality] ?? QUALITY_ARGS.high), outputName],
        CONVERT_TIMEOUT_MS,
      ),
      CONVERT_TIMEOUT_MS + 5_000,
      "ffmpeg.exec()",
    );
    if (typeof exitCode === "number" && exitCode !== 0) {
      throw new Error(`ffmpeg conversion failed (exit ${exitCode})`);
    }
    const data = await ff.readFile(outputName);
    try { await ff.deleteFile(inputName); } catch {}
    try { await ff.deleteFile(outputName); } catch {}
    return data as Uint8Array;
  } finally {
    ff.off("progress", progressHandler);
  }
}
