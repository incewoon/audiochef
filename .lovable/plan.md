## 문제

Whisper가 노래 구간에서 `♪`, `[Music]`, `(음악)` 같은 비음성 토큰을 라인으로 뱉어, SYLT 결과에 음표만 있는 줄이 잔뜩 생깁니다. 현재 코드에는 `suppress_non_speech: true` 옵션만 있고 결과 텍스트에 대한 후처리 필터가 없습니다 (`src/lib/whisper/transcribe.ts` 275–281줄, 스트리밍 `onSegment` 235–247줄).

## 해결 방안

`src/lib/whisper/transcribe.ts`에 정리 함수를 추가합니다.

1. `cleanSegmentText(text)`
   - 음표 문자 제거: `♪ ♫ ♬ ♩ ★ ~` 등
   - 대괄호/괄호로만 이루어진 비음성 표기 제거: `[Music]`, `[음악]`, `(music)`, `(applause)`, `(박수)`, `[BLANK_AUDIO]`, `[Sound effect]` 등
   - 남은 문자열의 공백 정리
2. `isNoiseOnly(text)` — 정리 후 남은 것이 없거나 문장부호/기호뿐이면 해당 세그먼트를 버림
3. 적용 위치 두 곳 (동일 함수 재사용)
   - 실시간 `onSegment` 콜백: 음표만 있는 줄은 텍스트박스에 아예 표시하지 않음
   - 최종 `result.transcription` 매핑: 정리 후 빈 줄 제거
4. 반복 음표 줄이 이미 병합/스냅 로직(`splitOnSilence`, `normalizeSegments`)에 들어가지 않도록, 필터는 그 이전 단계에서 수행

UI/저장 로직 변경은 없고, 사용자는 자동 추출 결과에서 음표 줄이 사라진 것만 보게 됩니다.

## 기술 메모

- 필터는 순수 문자열 유틸이라 `transcribe.ts` 상단에 정의하고 export 하여 테스트/재사용 가능하게 합니다.
- `suppress_non_speech: true`는 그대로 유지 (1차 방어), 후처리는 2차 방어.
- 가사 자체가 "라라라" 같은 실제 발성인 경우는 문자로 남으므로 삭제되지 않습니다.
