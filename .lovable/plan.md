## 목표

MP3 태그 편집 화면의 앨범 아트 팝업에서, 이미 입력된 ID3 값(노래 제목·아티스트·앨범)으로 구글 이미지 검색을 바로 열어 적정 사이즈 자켓 이미지를 찾을 수 있게 합니다.

## 동작

앨범 아트 다이얼로그(`src/components/TagEditorForm.tsx`의 Album Art 팝업) 안, "Choose image" 버튼 위에 검색 버튼 추가:

- 버튼: "Search album art on Google" (돋보기 아이콘)
- 쿼리: 입력된 값 중 존재하는 것만 조합 → `"{artist} {album} {title} album cover"` (앨범이 비어있으면 제목 사용, 둘 다 비면 제목만, 셋 다 비면 버튼 비활성 + 안내문구)
- URL: `https://www.google.com/search?tbm=isch&q=<encoded>&tbs=isz:lt,islt:svga` — 이미지 탭 + 최소 800×600 이상 크기 필터로 저해상도 결과 배제
- 새 탭(`window.open(url, "_blank", "noopener,noreferrer")`)으로 열기 — 앱 상태 유지
- 버튼 아래 작은 안내: 이미지를 길게 눌러 저장한 뒤 "Choose image"로 불러오라는 한 줄 영문 안내 (모바일 흐름)

기존 안내 문구(500×500–1000×1000, 1MB, JPEG/PNG)와 업로드/삭제 로직은 그대로 둡니다.

## 기술 메모

- 변경 파일: `src/components/TagEditorForm.tsx` 한 곳 (프레젠테이션 레이어만)
- 검색어 조합은 컴포넌트 내 작은 헬퍼로 처리, 중복 단어 제거(예: 앨범명 == 제목이면 한 번만)
- 외부 API 키 불필요, 단순 링크 이동이라 오프라인 상태에선 자연히 동작하지 않음 (오프라인 시 버튼은 그대로 두되 별도 처리 없음)
