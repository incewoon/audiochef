## 원인

락처럼 연주음이 큰 곡은 두 가지가 겹칩니다.

1. **전처리 없음** — 현재 `src/lib/whisper/chunk.ts`는 채널 평균만 내서 16kHz로 넘깁니다. 드럼·베이스·기타가 보컬을 덮은 원음 그대로라 Whisper가 음성 자체를 못 찾습니다.
2. **작은 모델** — 지금 쓰는 `base-q5_1`(약 60MB)는 조용한 음성용으로, 악기 위에 얹힌 노래에는 거의 무력합니다. 그래서 결과가 전부 걸러지고 빈 가사가 나옵니다.

## 해결 1: 보컬 강조 전처리 (기본 적용)

`src/lib/whisper/chunk.ts`의 디코딩 경로를 `OfflineAudioContext`(16kHz) 렌더링으로 교체하고, 체인을 다음과 같이 구성합니다.

- **중앙(mid) 추출**: L+R 합 — 보컬은 대개 센터에 있어 사이드로 퍼진 기타/리버브 비중을 줄임
- **하이패스 180Hz** — 킥/베이스 제거
- **로우패스 5.5kHz** — 심벌/하이햇 제거 (Whisper는 어차피 8kHz까지만 씀)
- **보컬 대역 부스트**: 1~3kHz 피킹 EQ +4dB (자음 명료도)
- **DynamicsCompressor** (threshold -28dB, ratio 6) + 피크 정규화 — 악기에 묻힌 작은 보컬을 끌어올림

렌더 결과를 기존과 동일한 Float32 PCM으로 받아 지금의 청크 분할 로직을 그대로 사용합니다. 무음 경계 탐색도 전처리된 신호 기준이라 더 잘 맞습니다.

## 해결 2: 음악용 고정밀 모델 선택

`src/lib/engine-assets.ts`에 `small` 계열 모델 추가:
- `ko-music`: `ggml-small-q5_1.bin` (약 190MB)
- `en-music`: `ggml-small.en-q5_1.bin` (약 190MB)

`LyricsDialog`의 모델 영역에 **"Music mode (high accuracy)"** 체크박스를 두고, 켜면 small 모델을 쓰도록 `WhisperLang` 선택을 확장합니다. 다운로드/캐시 상태 표시와 수동 다운로드 버튼은 기존 UI를 그대로 재사용하고, 용량이 커서 처음 한 번은 다운로드가 필요하다는 안내를 붙입니다. 인식 속도는 대략 2~3배 느려지므로 안내 문구에 명시합니다.

## 해결 3: 인식 파라미터 완화

`src/lib/whisper/transcribe.ts`의 `transcribe()` 옵션:
- 음악 모드에서는 `suppress_non_speech: false` (강한 억제가 노래를 통째로 버리는 경우가 있어, 대신 기존 `cleanSegmentText` 후처리로 음표/태그 제거)
- `no_speech_thold`를 기본보다 낮춰(0.2) 악기 구간에서 보컬을 놓치지 않게 함
- 결과가 0줄이면 실패로 두지 말고, "No lyrics detected — try Music mode / check the track" 안내 토스트 노출

## 기술 메모

- 전처리는 전부 브라우저 내장 WebAudio라 오프라인 동작·PWA 캐시에 영향 없음
- 실제 스템 분리(Demucs 등)는 브라우저에서 수백 MB 모델과 GPU가 필요해 이번 범위 제외 — 위 EQ/컴프레서 조합이 웹에서 가능한 최선의 근사
- 변경 파일: `src/lib/whisper/chunk.ts`, `src/lib/whisper/transcribe.ts`, `src/lib/engine-assets.ts`, `src/components/LyricsDialog.tsx`
