## 목표

Capacitor·네이티브 코드 없이, 웹/PWA 쪽만 Google Play TWA 준비 상태로 정리합니다. COOP/COEP, Service Worker 가드, ffmpeg/Whisper 로딩 경로는 손대지 않습니다.

## A. 영속 저장소 (storage.persist)

새 헬퍼 `src/lib/persist-storage.ts`
- `requestPersistentStorage()`: `navigator.storage?.persist` 없으면 no-op, 이미 persisted면 즉시 반환, 결과가 false여도 `console.info`만 남기고 throw 하지 않음.
- 호출 위치 두 곳(둘 다 `void`로 비차단 호출):
  1. `src/lib/whisper/transcribe.ts`의 `fetchAndCacheModel()` 안 `cache.put(...)` 성공 직후 (= `downloadWhisperModel` 성공 경로)
  2. `migrateLegacyEngineCaches()`가 legacy 엔트리를 새 캐시로 복사한 직후

## B. 캐시 / 브랜드 이름 정리

- `src/lib/engine-assets.ts`: `ENGINE_CACHE_NAME`을 `audiochef-media-engines-v1`로 변경하고, 구 이름 배열 `LEGACY_ENGINE_CACHE_NAMES = ["audiofly-media-engines-v2"]`를 export.
- `scripts/generate-sw.mjs`: 런타임 캐시 이름 2곳을 동일한 새 이름으로 변경.
- **공통 마이그레이션 헬퍼** `migrateLegacyEngineCaches()` (`src/lib/engine-assets.ts` 혹은 `src/lib/engine-cache-migrate.ts`):
  - 각 legacy 캐시를 열어 `keys()` 전체를 새 `ENGINE_CACHE_NAME` 캐시로 `cache.put(request, response)` 복사 (새 캐시에 이미 있는 항목은 건너뜀)
  - 복사 완료 후 `caches.delete(legacyName)`
  - 하나라도 복사했으면 직후에 `void requestPersistentStorage()`
  - **모듈 레벨 Promise 락**으로 감싸 세션당 1회만 실행 (동시 호출은 같은 Promise 공유), 실패해도 조용히 무시(그 경우 사용자가 재다운로드)
  - 호출처: `transcribe.ts`의 `openModelCache()`와 `sw-register.ts`의 `prewarmEngineCache()` — 둘 다 캐시를 열기 전에 `await`
- `public/service-worker.js`(구 경로 kill-switch)의 정규식이 `audiofly-`를 지우게 되어 있으므로 그대로 두되, 새 `audiochef-` 캐시는 절대 지우지 않도록 패턴을 확인/유지.
- `package.json`의 `"name"`을 `"audiochef"`로 변경.
- localStorage 키(`audiofly:*`, `audiofly.*`)와 히스토리 가드 sentinel은 사용자 설정 초기화를 피하려고 그대로 둡니다(원하시면 마이그레이션 포함 가능).


## C. TWA / Digital Asset Links

- `public/.well-known/assetlinks.json` 신규 추가 (placeholder):

```text
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.audiochef.app",
    "sha256_cert_fingerprints": ["REPLACE_WITH_RELEASE_CERT_SHA256"]
  }
}]
```

- `public/` 전체가 빌드 산출물로 복사되므로 별도 설정 없이 `/.well-known/assetlinks.json`으로 서빙됩니다. `generate-sw.mjs` precache glob에 잡히지 않도록(항상 네트워크에서 최신값을 읽도록) `globIgnores`에 `.well-known/**` 추가.

## D. manifest / 오프라인 폴백 점검

- `public/manifest.json`은 이미 AudioChef / standalone / start_url `/` / scope `/` / 192·512 아이콘 / theme_color `#0f172a` 로 TWA 요건 충족 — 변경 없음.
- `public/offline.html`과 SW 폴백 동작도 그대로 유지, 리라이트 없음.

## 변경 파일

- 신규: `src/lib/persist-storage.ts`, `public/.well-known/assetlinks.json`
- 수정: `src/lib/engine-assets.ts`, `src/lib/whisper/transcribe.ts`, `scripts/generate-sw.mjs`, `package.json`

vite-plugin-pwa는 계속 비활성 유지(workbox `generate-sw.mjs` 단일 경로), preview/iframe/dev SW 차단 가드도 그대로 둡니다.
