# 디자인 미러 — 앱 UI를 claude.ai/design 으로 그대로 올리기

앱의 **실제 화면**을 claude.ai/design 의 design-system 프로젝트에 옮기는 파이프라인이다.
핵심 규칙 하나: **다시 그리지 않는다.** 토큰은 `themes.ts` 에서 생성하고, 스타일시트는
바이트 그대로 복사하고, 마크업은 실행 중인 앱에서 떠온다.

> 이 프로젝트는 **as built**(구현된 결과의 사본)다. 시안 정본이 아니다.
> 새 화면을 *디자인*할 때는 기존 핸드오프 흐름(`docs/디자인 핸드오프/`)을 쓰고,
> 여기는 "지금 앱이 실제로 이렇게 생겼다"를 보여주는 용도로만 갱신한다.

| 대상 | 값 |
| --- | --- |
| 프로젝트 | `AgentParty Design System (as built)` |
| projectId | `18fbdba3-0e2b-4008-9606-4c6b11063246` |
| 카드 수 | 59 (Foundations 3 · Workbench 8 · Transcript 4 · Cards 26 · Modals 6 · Screens/Settings 12) |

기존 `# AgentParty UI 디자인`(`f0d5d1fe-…`)은 **일반 프로젝트**라 design-system 카드
인덱스를 못 만든다(타입은 생성 시 고정). 그래서 새 프로젝트를 만들었다.

## 왜 생성·캡처인가

손으로 옮긴 사본은 반드시 어긋난다. 실제로 기존 핸드오프 `.dc.html` 들은 팔레트를
직접 박아놨고, 그 사이 앱은 폰트가 Geist → **Maplestory** 로 바뀌었고 토큰도
`warning-*`, `compact-zone`, `live-bd`, `shadow-strong` 이 늘었다. 그 사본은 이미
앱과 다른 것을 설명하고 있었다.

## 세 단계

```bash
npm run build                                # dist/ 가 최신이어야 캡처가 현재 UI를 뜬다
node scripts/build-design-bundle.mjs         # 토큰 생성 + 스타일시트/폰트 복사 + Foundations 카드
node scripts/capture-design-surfaces.mjs     # 실제 앱을 띄워 화면·컴포넌트 마크업 캡처
node scripts/verify-design-bundle.mjs        # (electron 으로) 모든 페이지가 단독으로 렌더되는지 실측 + 카드 크기 측정
node scripts/build-design-manifest.mjs       # _ds_manifest.json 생성 (이게 없으면 창이 비어 보인다)
```

산출물은 `build/design-bundle/` (git 에 넣지 않는다 — 언제든 재생성된다).

### 1. `build-design-bundle.mjs`
- `src/renderer/theme/themes.ts` 를 esbuild 로 컴파일해 **import** 한 뒤
  `foundations/tokens.css` 를 만든다. 앱의 ThemeProvider 가 런타임에 주입하는 것과
  같은 내용이며, 정적 페이지에는 이게 없으면 모든 `var(--token)` 이 빈 값이 된다.
- `styles.css` · `design-system.css` · Maplestory woff2 를 **그대로 복사**한다.
- 색/모양/타입 Foundations 카드 3장을 토큰에서 생성한다.

### 2. `capture-design-surfaces.mjs`
QA 모드로 진짜 앱을 띄우고(모의 하네스 — 모델 호출 없음), 자동화 API 로 각 상태를
만든 뒤 DevTools 프로토콜로 렌더된 DOM 을 떠온다. 두 가지가 중요하다.

- **조상 체인**: 앱 CSS 는 `.wb-tabstrip .wb-tab` 같은 후손 선택자 투성이라, 노드만
  떼면 스타일 대부분을 잃는다. 그래서 조상들을 클래스/인라인 스타일만 남긴 빈
  래퍼로 복제해 다시 감싼다.
- **높이**: 체인 끝은 `height:100vh` 인 앱 셸이라 그대로 두면 64px 짜리 탭 스트립도
  900px 카드가 된다. 컴포넌트는 체인 전체를 `height:auto` 로, 화면·모달은 무대 높이를
  지정한다. **가장 바깥 래퍼에만 걸면 안 된다** — 체인 끝은 React 루트 div 라
  앱 셸이 한 겹 안쪽에서 계속 이긴다.

카드 상태는 대부분 이미 있는 픽스처에서 나온다: `src/shared/designGallery.ts`
(승인·질문·압축·환경 26종), `src/shared/subagentScenarios.ts`(서브에이전트 독).

### 3. `verify-design-bundle.mjs`
업로드 **전에** 모든 페이지를 Electron 으로 열어 실측한다: `--bg-0` 이 비어있지 않은지
(토큰 로드), body 폰트가 Maplestory 인지(woff2 로드), 내용이 실제 크기로 그려지는지,
첫 줄에 `@dsCard` 마커가 있는지. `--shots` 로 PNG 도 남기고, 잰 크기를 `_sizes.json`
으로 내보낸다(카드 viewport 의 근거).

### 4. `build-design-manifest.mjs`
`_ds_manifest.json` 을 만든다. **Design System 창은 이 파일을 읽는다** — 파일을 다
올려도 매니페스트가 없으면 창이 비어 보인다(첫 업로드에서 실제로 그랬다). 카드 목록은
각 페이지의 `@dsCard` 마커에서만 만들고, viewport 는 `_sizes.json` 의 실측값을 쓴다.
`globalCssPaths`·`themes`·`fonts` 도 여기서 앱 값 그대로 채운다.

## 업로드

카드 목록의 원천은 각 HTML 첫 줄의 `<!-- @dsCard group="…" name="…" -->` 이고,
그것을 모아 `_ds_manifest.json` 으로 올린다(`register_assets` 는 불필요). DesignSync 순서:

1. `list_files` (기존 상태 확인)
2. `finalize_plan` — `writes` 글롭 + `localDir: build/design-bundle`
3. `write_files` — `localPath` 로 올린다(파일 본문이 모델 컨텍스트를 거치지 않는다)

갱신할 때도 같은 순서로 덮어쓰면 된다. 앱이 바뀌면 세 스크립트를 다시 돌리는 것이
곧 동기화다.

## 캡처하며 드러난 것

- `POST /api/parties/:id/select` 는 `?window=<id>` 없이 부르면 **ok 를 반환하고도
  창을 옮기지 않는다**(선택은 창 단위로 기록되는데 HTTP 호출자에게는 포커스된 창이
  해석되지 않는다). 이 때문에 첫 캡처에서 갤러리 카드 26장이 전부 빈 채로 나왔다.
  스크립트는 창 id 를 명시해 우회하고 있다. → FEEDBACK 항목.
- 모달은 scrim 클릭도 Escape 도 닫히지 않는다(의도된 설계). 캡처 사이에 명시적으로
  닫지 않으면 다음 캡처가 **앞 모달을 다시 떠온다** — 실제로 4장이 같은 모달이었다.
  지금은 닫은 뒤 열린 모달이 남았는지 검사한다.
