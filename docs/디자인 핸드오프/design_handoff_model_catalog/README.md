# Model Catalog — 디자인 핸드오프 (2026-08-10)

원본: claude.ai 디자인 프로젝트 `f0d5d1fe-9410-45bd-8bf0-1782e67b4a0e` 의
`Model Catalog.dc.html`. (DesignSync MCP `get_file` 로 다시 받을 수 있다. 앱 안의
멤버 세션은 대화형 재인증을 못 하므로 별도 터미널에서 `/design-login` 필요 —
[아이디어 D-3](../../아이디어/아이디어.md) 참고.)

구현: `src/renderer/workbench/ModelCatalogModal.tsx` + `styles.css` 의
`.wb-modal-catalog` 스코프. 공유 규칙(`.wb-modal`, `.wb-segmented`, `.wb-toggle-card`)은
Codex 권한·멤버 마법사 등 다른 화면도 쓰므로 **덮어쓰지 않고 카탈로그 안에서만 재정의**했다.

## 검증 방법

수치는 눈으로 보지 말고 재라. 실제 앱을 띄워 `getComputedStyle` 을 디자인 값과
대조하는 것이 유일한 근거다:

- `npm run test:e2e:catalog-list` — 실제 앱 프로세스로 카탈로그를 열어 검색창·별·
  컬럼 구조를 잰다. 상단 `MOCKUP` 상수가 이 핸드오프의 값이다.
- 전체 대조(139개 항목)는 임시 스크립트로 수행했다. 다시 필요하면 아래 표를 그대로
  `[selector, {prop: px}]` 목록으로 만들어 CDP `Runtime.evaluate` 로 재면 된다.

## 이 디자인이 고정한 수치

전부 px. 토큰이 정확히 일치할 때만 토큰을 썼고(`--radius-input` 8, `--radius-card` 10,
`--radius-panel` 11, `--space-*`), 아니면 리터럴을 뒀다.

| 영역 | 값 |
| --- | --- |
| 모달 | 폭 1000, 본문 높이 742, 좌측 컬럼 344 |
| 헤더 / 푸터 | 15·18·14·18 / 11·16, 버튼 높이 30 |
| 하네스 스트립 | padding 3, gap 3, radius 9, 탭 높이 28, radius 7 |
| Model 헤드 | 13·16·8·16 |
| 검색 | 높이 32, padding 0 8 0 9, gap 7, radius 8 |
| 목록 스크롤 | 0·10·14·10, gap 6, 그룹 gap 2 |
| provider 헤더 | padding 6 8, gap 8, radius 7 |
| 모델 행 | padding 9 10 9 13, gap 10, radius 9, 선택 시 좌측 바 2px |
| 상세 컬럼 | padding 18·22·20, gap 16 |
| 상세 헤드 | gap 12, 이름 21/600/-.3, chip 높이 22, 즐겨찾기 버튼 높이 30 |
| 통계 그리드 | 4열 한 덩어리, radius 12, 셀 14·16·15, gap 10, 값 19/600 |
| Effort/Thinking | strip padding 4 gap 4 radius 10, 세그먼트 높이 36 radius 8 |
| 토글 카드 | padding 13 15, radius 11, gap 12, 스위치 38×22 |
| 자동압축 확장부 | padding 12·14·14·43, gap 9, 상단 구분선 |

## 디자인과 의도적으로 다르게 둔 것

- **즐겨찾기 그룹 유지.** 목업에는 상단 고정 즐겨찾기 섹션이 없지만, 이건 근거를 남기고
  만든 기존 기능이다([modelCatalogGroups.ts](../../../src/renderer/workbench/modelCatalogGroups.ts)).
  새 헤더 스타일에 맞춰 재스타일만 했다.
- **미지원·베타잠금 배지, service tier, thinking budget 슬라이더 유지.** 목업의 데이터
  모델이 단순해서 없는 것이지 빠뜨린 기능이 아니다.
- **자동압축 슬라이더는 앱 쪽이 더 두껍다.** 목업은 50–95 단순 슬라이더지만 앱은 토큰
  추정치·설정 불가 구간 표시를 갖고 있다. 카드 껍데기만 목업에 맞췄다.
- **성능 미터는 4칸.** 목업 그대로다. 4와 5는 막대 수가 아니라 **색**(4 이상 green)으로
  구분되고, 숫자는 옆에 항상 표기된다.
