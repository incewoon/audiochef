// scripts/generate-sw.mjs
import { generateSW } from "workbox-build";
import { existsSync } from "node:fs";
import path from "node:path";

// Lovable/nitro 최종 산출물 우선, 로컬 dist는 후순위
const TARGET_DIRS = ["dist/client", ".output/public", "dist"];
let PUBLIC_DIR = "";

const startTime = Date.now();
const timeout = 20000;

console.log("[generate-sw] 최종 빌드 폴더를 탐색 중...");

while (Date.now() - startTime < timeout) {
  for (const dir of TARGET_DIRS) {
    const full = path.resolve(process.cwd(), dir);
    if (existsSync(full)) {
      // 최소한 index.html이나 assets 폴더가 있는 폴더를 우선 선택
    if (
      existsSync(path.join(full, "index.html")) ||
      existsSync(path.join(full, "assets")) ||
      existsSync(path.join(full, "offline.html")) ||
      existsSync(path.join(full, "ffmpeg")) ||
      existsSync(path.join(full, "manifest.json"))
    ) {
        PUBLIC_DIR = dir;
        break;
      }
    }
  }
  if (PUBLIC_DIR) break;
  const stop = Date.now() + 500;
  while (Date.now() < stop) {}
}

if (!PUBLIC_DIR) {
  console.error(`[generate-sw] 에러: 유효한 빌드 폴더를 찾을 수 없습니다.`);
  process.exit(1);
}

console.log(`[generate-sw] 대상 폴더 확정: "${PUBLIC_DIR}"`);

const { count, size, warnings } = await generateSW({
  swDest: `${PUBLIC_DIR}/sw.js`,
  globDirectory: PUBLIC_DIR,
  globPatterns: [
    "**/*.{js,mjs,cjs,css,html,svg,png,ico,webmanifest,json,wasm}",
    "offline.html",
    "ffmpeg/**/*",
    "whisper/**/*",
    "icons/**/*",
    "manifest.json",
  ],
  globIgnores: [
    "sw.js",
    "workbox-*.js",
    "**/server/**",
    "server/**",
    "**/_worker.js",
    "_worker.js",
    "**/wrangler.json",
    ".well-known/**",
  ],
  cleanupOutdatedCaches: true,
  skipWaiting: true,
  clientsClaim: true,
  maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
  runtimeCaching: [
    // Navigation requests: always try the network first so online users get
    // the real app shell. Only fall back to the precached offline.html when
    // the network genuinely fails.
    {
        urlPattern: ({ url }) =>
          url.origin === self.location.origin &&
          (url.pathname === "/ffmpeg/ffmpeg-core.js" ||
           url.pathname === "/whisper/shout.wasm.js"),
        handler: "CacheFirst",
      options: {
        plugins: [
          {
            handlerDidError: async () => {
              const cached = await caches.match("/offline.html");
              if (cached) return cached;
              return new Response(
                "<!doctype html><meta charset='utf-8'><title>Offline</title><p>오프라인 상태입니다.</p>",
                { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
              );
            },
          },
        ],
      },
    },
    {
      urlPattern: ({ url }) =>
        url.origin === self.location.origin &&
        (url.pathname === "/ffmpeg/ffmpeg-core.js" ||
          url.pathname === "/whisper/shout.wasm.js"),
      handler: "CacheFirst",
      options: {
        cacheName: "audiochef-media-engines-v1",
        expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: ({ url }) =>
        url.origin === self.location.origin &&
        /^\/__l5e\/assets-v1\//.test(url.pathname),
      handler: "CacheFirst",
      options: {
        cacheName: "audiochef-media-engines-v1",
        expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
        cacheableResponse: { statuses: [0, 200] },
        rangeRequests: true,
      },
    },
  ],
});

console.log(
  `[generate-sw] sw.js 생성 완료: ${count}개 파일, ${(size / 1024 / 1024).toFixed(1)}MB precache`
);
if (warnings.length) console.warn("[generate-sw] 경고:", warnings);
