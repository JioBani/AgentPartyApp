# 디자인 미러 — 앱 UI를 claude.ai/design 으로 그대로 올리기

앱의 **실제 UI** 를 claude.ai/design 으로 옮기는 파이프라인이다.
핵심 규칙 하나: **다시 그리지 않는다.** 토큰은 `themes.ts` 에서 생성하고, 스타일시트는
바이트 그대로 복사하고, 마크업은 실행 중인 앱에서 떠온다.

산출물은 **둘**이고 성격이 다르다.

| 대상 | 무엇 | id |
| --- | --- | --- |
| `AgentParty Design System (as built)` | **디자인 시스템** — 파운데이션 3 + 컴포넌트 28 (변형 + `.prompt.md`) | `18fbdba3-0e2b-4008-9606-4c6b11063246` |
| `AgentParty Desktop` | **프로젝트** — 그 시스템으로 만들어진 단일 페이지 앱 목업 (화면 6 · 대화상자 4 · 인라인 패널 2, 각 한 벌씩) | `8082a168-4a3c-4140-a895-f25ad44aa2c2` |

디자인 시스템이 문서화하는 단위는 **컴포넌트와 그 변형, 그리고 언제 쓰는지**다.
화면은 시스템의 산출물이지 시스템이 아니라서 프로젝트로 뺐다(처음 한 번은 화면만
잔뜩 올렸다가 "디자인 시스템이 아니라 프로젝트 같다"는 지적을 받았다).

프로젝트 쪽은 자기 CSS 사본을 갖지 않고 `_ds/<시스템>/…` 을 링크한다 — 그래야 시스템이
움직이면 화면도 같이 움직이고, 토큰 사본이 둘로 갈라지지 않는다.

프로젝트는 **한 장짜리 목업**이다. 처음엔 상태마다 한 페이지씩 19장으로 만들었는데,
워크벤치가 8장·설정 화면이 7장·창 크롬이 19장에 복사돼 "하나 고치면 전부 손봐야 하는"
물건이 됐다. 앱 자신은 창 하나에서 화면을 갈아끼우므로, 목업도 그 이음매를 따라
조립해 **모든 조각이 정확히 한 벌**이 되게 했다.

> ## ⚠️ 이 파이프라인은 **씨딩 전용**이다 — 다시 돌려 올리지 말 것
>
> 앱의 현재 모습을 클로드 디자인에 **한 번 심는 것**이 목적이다. 심은 뒤로는
> **클로드 디자인이 디자인의 정본**이고, 거기서 한 작업이 앱으로 내려온다.
>
> 그래서 캡처 스크립트를 다시 돌려 업로드하면 **그 사이 한 디자인 작업을 덮어쓴다.**
> 앱 구조가 크게 바뀌어 처음부터 다시 심어야 할 때만, 그 사실을 알고 다시 돌린다.
>
> 방향이 반대인 작업(디자인 → 앱)은 아래 "내려받기" 절을 볼 것.

일반 프로젝트는 DesignSync 로 **만들 수 없다**(`create_project` 는 design-system 타입만
만든다). `AgentParty Desktop` 은 사용자가 claude.ai/design 에서 만들고 id 를 넘겨줬다.
기존 `# AgentParty UI 디자인`(`f0d5d1fe-…`)도 일반 프로젝트라 카드 인덱스를 못 만든다.

## 왜 생성·캡처인가

손으로 옮긴 사본은 반드시 어긋난다. 실제로 기존 핸드오프 `.dc.html` 들은 팔레트를
직접 박아놨고, 그 사이 앱은 폰트가 Geist → **Maplestory** 로 바뀌었고 토큰도
`warning-*`, `compact-zone`, `live-bd`, `shadow-strong` 이 늘었다. 그 사본은 이미
앱과 다른 것을 설명하고 있었다.

## 한 사이클

```bash
npm run build                                # dist/ 가 최신이어야 캡처가 현재 UI를 뜬다
node scripts/build-design-bundle.mjs         # 토큰 생성 + 스타일시트/폰트 복사 + Foundations 카드

# 디자인 시스템 (컴포넌트)
node scripts/capture-design-components.mjs   # 컴포넌트 변형 카드 + prompt.md
node scripts/verify-design-bundle.mjs        # 페이지 실측 + 카드 크기 측정
node scripts/build-design-manifest.mjs       # _ds_manifest.json (없으면 창이 비어 보인다)

# 프로젝트 (단일 페이지 앱 목업)
node scripts/capture-mockup-parts.mjs        # 창 크롬·화면·대화상자를 조각으로 한 번씩만
node scripts/build-mockup-page.mjs           # 한 장으로 조립 + data 속성 배선
node scripts/verify-mockup.mjs               # (electron) 조각이 한 벌인지 + 배선이 도는지 클릭 실측
```

`split-design-bundle.mjs` · `capture-design-surfaces.mjs` · `link-design-project.mjs` 는
페이지-당-화면이던 옛 구조의 잔재다(19장 목업). 지금 구조에서는 쓰지 않는다.

산출물은 `build/design-bundle/`(시스템)과 `build/design-project/`(화면). git 에는
넣지 않는다 — 언제든 재생성되고, 절반이 복사된 폰트다.

### 1. `build-design-bundle.mjs`
- `src/renderer/theme/themes.ts` 를 esbuild 로 컴파일해 **import** 한 뒤
  `foundations/tokens.css` 를 만든다. 앱의 ThemeProvider 가 런타임에 주입하는 것과
  같은 내용이며, 정적 페이지에는 이게 없으면 모든 `var(--token)` 이 빈 값이 된다.
- `styles.css` · `design-system.css` · Maplestory woff2 를 **그대로 복사**한다.
- 색/모양/타입 Foundations 카드 3장을 토큰에서 생성한다.

### 2. `capture-mockup-parts.mjs` + `build-mockup-page.mjs` (프로젝트)
앱을 **조각 단위로 한 번씩만** 뜬다: 창 크롬(타이틀바·레일), 화면 6종(`.program-main`),
대화상자 4종, 인라인 패널 2종(멤버 만들기·명령 팔레트 — 앱이 제자리에 렌더하는 것들).
런타임 화면은 **한 번의 캡처로 7개 탭이 전부** 딸려온다(앱이 비활성 탭 패널을 unmount
하지 않고 숨기기 때문).

조립본은 `data-goto`/`data-open`/`data-close`/`data-tab`/`data-theme-toggle` 로만 동작하고,
스크립트는 40줄이다. 화면을 추가해도 스크립트는 건드릴 필요가 없다. 다크 테마 사본은
없다 — 토큰이 바뀔 뿐이다.

`verify-mockup.mjs` 가 **조각이 한 벌인지**(워크벤치 1, 크롬 1, 설정 탭 줄 1)와
**배선이 실제로 도는지**(레일·탭·대화상자·테마를 클릭해 DOM 확인)를 실측한다.

### 2b. `capture-design-surfaces.mjs` (옛 구조)
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

### 3b. `capture-design-components.mjs` + `design-components.mjs`
디자인 시스템의 본체. `design-components.mjs` 가 **인벤토리**(컴포넌트 28개와 각각의
변형·선택자·필요한 상태)이고, 드라이버는 상태(scene)별로 앱을 **한 번씩만** 몰아넣은 뒤
그 상태에서 필요한 표본을 전부 떠서 카드 한 장으로 합친다.

표본은 `context`(CSS 가 필요로 하는 가장 가까운 조상)까지만 감싼다 — 여기까지가
`.wb-tabstrip .wb-tab` 같은 후손 선택자를 살리면서도 28px 짜리 필이 900px 카드가 되지
않게 하는 선이다.

QA 갤러리 26장은 여기서 **컴포넌트 4개(승인·질문·압축·환경)의 변형**으로 접힌다.

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

## 내려받기 — 디자인 → 앱

씨딩이 끝난 뒤의 정상 방향. 바뀐 것의 성격에 따라 경로가 다르다.

| 바뀐 것 | 경로 | 자동화 |
| --- | --- | --- |
| **토큰**(색·radius·border 등) | 디자인 시스템의 `foundations/tokens.css` → `src/renderer/theme/themes.ts` | 가능 (아직 미구현) |
| **컴포넌트 스타일**(패딩·크기·상태색) | 컴포넌트 카드의 규칙 ↔ `src/renderer/styles.css` 비교 → 바뀐 선언만 반영 | 반자동 (diff 추출) |
| **구조·플로우**(새 화면, 배치 변경) | 목업의 해당 섹션이 곧 핸드오프 문서 — 사람이 구현 | 수동 |

### 실제로 한 번 내려받아 보니 (2026-08-20 · 파티 그룹 + 멤버 cwd)

목업이 `index.html` 한 장일 때는 260KB 라 DesignSync `get_file` 의 256KiB 상한에
걸려 **뒷부분(대화상자 전체)을 읽을 수 없었다.** 화면별로 쪼갠 뒤에야 전부 읽혔다 —
목업을 한 장으로 유지할 때의 실제 비용이다.

내려받은 새 규칙(`shared/mock.css` 의 "새 기능 스타일" 블록)은 **값을 고치지 않고**
`src/renderer/styles.css` 로 그대로 옮겼다. 여기서 숫자를 "정리"하면 목업과 앱이
갈라지고, 다음 핸드오프가 어느 쪽이 정본인지 알 수 없게 된다.

일치 여부는 눈이 아니라 **실측**으로 확인했다. 목업 페이지와 앱의
`dist-renderer/preview/index.html` 을 각각 헤드리스 크롬으로 열어 같은 선택자의
`getBoundingClientRect` · `getComputedStyle` 을 읽어 비교하면, 어느 상자가 몇 px
다른지가 바로 나온다(캡처 육안 비교로는 16px 차이를 "같아 보인다"로 넘긴다).

목업 자체에서 발견한 결함 하나: `workbench.html` 의 `<div class="mock-overlay">`
11개가 **닫히지 않아** 대화상자들이 서로 중첩된다. 그래서 `#overlay-new-group` 을
열면 그 조상인 `#overlay-new-party` 가 숨겨진 상태라 아무것도 보이지 않는다.
각 오버레이 끝에 부족한 `</div>` 를 채우면 해결된다.

토큰이 제일 값싸다. 앱 전체가 토큰 기반이라 `themes.ts` 하나만 갱신하면 리테마가 끝나고,
목업/시스템은 그 토큰을 링크하고 있으므로 양쪽이 같은 값을 보게 된다.

내려받을 때 지켜야 할 것 하나: **클래스 이름을 바꾸지 않는다.** 디자인 쪽 마크업이
앱과 같은 클래스를 쓰는 덕분에 "여기가 바뀌었다 → 앱의 이 규칙"이 성립한다.
