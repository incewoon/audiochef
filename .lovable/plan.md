## 목표

MP4 → MP3 변환 페이지에서 **Album Artist 입력창을 제거**하고, 그 자리에 **음질(변환율) 선택 토글**을 배치합니다. 선택값은 localStorage에 저장되어 초기화·재방문 후에도 유지됩니다.

## 음질 옵션 (3가지)

| 버튼 | 설정 | 대략 크기/특징 |
|---|---|---|
| Standard | `-b:a 128k` (CBR) | 가장 작은 용량 |
| **High (기본)** | `-q:a 2` (VBR ~190kbps) | 현재 쓰는 값 = 기본값 |
| Max | `-b:a 320k` (CBR) | 최고 음질, 용량 큼 |

기본 선택은 현재 세팅인 High이며, 사용자가 바꾸면 그 값이 계속 유지됩니다.

## UI

`src/components/ConverterForm.tsx`
- `albumArtist` state와 Album Artist 입력 필드 삭제 (ID3 태그 기록에서도 제거)
- 그 자리에 `Quality` 라벨 + 3분할 세그먼트 토글(파일명 프리셋 버튼과 동일한 스타일 톤) 배치, 아래에 선택된 옵션 설명(예: "High — VBR ~190 kbps") 표기
- 선택값을 `audiofly:mp3-quality` 키로 localStorage 저장, 마운트 시 복원
- 변환 완료 후 폼 초기화(`resetAll`) 시에도 **음질 선택값은 지우지 않음** (요청대로 유지)

## 변환 로직

`src/lib/convert.ts`
- `convertMp4ToMp3`에 `quality` 옵션 추가 (`"standard" | "high" | "max"`, 기본 `"high"`)
- ffmpeg 인자를 옵션에 따라 분기: `-q:a 2` 또는 `-b:a 128k` / `-b:a 320k`
- 나머지 로직(타임아웃, 진행률, 파일 정리)은 그대로

## 기술 메모

- Album Artist 제거는 변환 페이지에만 적용하고, `/tag-editor`의 Album Artist 편집 기능은 그대로 둡니다.
- 변경 파일: `src/components/ConverterForm.tsx`, `src/lib/convert.ts`
