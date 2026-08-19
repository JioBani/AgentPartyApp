/*
 * WHAT the design system documents: components, their variants, and when to use
 * them.
 *
 * Split from the capture driver so this file reads as the inventory it is. Each
 * component becomes one card showing every variant side by side — the axis a
 * design system is actually for — plus a `.prompt.md` saying when to reach for
 * it. The rationale text is lifted from the reasons already written in the
 * source; a design system that restates "this is a button" teaches nothing that
 * looking at it would not.
 *
 * `scene` names a state the app must be driven into (see the driver), `selector`
 * is what to lift, and `context` is the ancestor to keep so the app's descendant
 * selectors still apply — without it a `.wb-tab` outside `.wb-tabstrip` loses
 * most of its styling.
 */

/** One specimen inside a component card. */
const v = (label, scene, selector, options = {}) => ({ label, scene, selector, ...options });

export const COMPONENTS = [
  // ---------------------------------------------------------------- Primitives
  {
    id: "dot", group: "Primitives", name: "Status dot", subtitle: "멤버의 살아있는 상태",
    prompt: `멤버가 등장하는 모든 곳(사이드바 행, 탭, 패널 헤더)에 붙는 가장 작은 상태 표시.

색은 멤버의 **정체성 색**(\`--member\`)이고, 상태는 색이 아니라 **움직임**으로 말한다 —
작업 중이면 맥동한다. 상태별로 색을 바꾸면 멤버를 색으로 구분하는 규칙과 충돌한다.`,
    variants: [
      v("idle", "workbench", ".wb-member-row:not(.is-working) .wb-dot", { context: ".wb-member-row" }),
      v("working", "workbench", ".wb-dot.is-working", { context: ".wb-member-row" }),
    ],
  },
  {
    id: "badge", group: "Primitives", name: "Badges", subtitle: "승인 대기 · 안 읽음 · 대기열",
    prompt: `탭과 사이드바 행이 다는 세 가지 표시. **동시에 두 개를 달지 않는다** —
승인이 더 급하므로 안 읽음을 이긴다. 둘 다 붙이면 탭만 넓어지고 우선순위는 사라진다.

대기열 배지는 점선이다: 도착한 것(승인·안 읽음은 실선)이 아니라 **아직 전달되지 않은
것**이기 때문이다.`,
    variants: [
      v("승인 대기", "approval", ".wb-tab-badge", { context: ".wb-tab", width: "260px" }),
      v("안 읽음", "unread", ".wb-tab-unread", { context: ".wb-tab", width: "260px" }),
      v("대기열", "queue", ".wb-tab-queue", { context: ".wb-tab", width: "260px" }),
    ],
  },
  {
    id: "chip", group: "Primitives", name: "Chips", subtitle: "멘션 · 경로 · 토큰",
    prompt: `문장 **안에** 들어가는 조각들. 세로 정렬은 셋이 같은 규칙을 쓴다
(\`vertical-align: middle\` — 주변 글자의 중심선에 맞춘다).

- **멘션**은 사람을 가리키므로 멤버 색을 띤다.
- **경로**는 드롭된 파일/폴더. 라벨은 마지막 조각, 전체 경로는 툴팁.
- **토큰**(\`:a\` 로 넣는 모델·하네스·추론 설정)은 일부러 더 조용하다. 사람이 아니라
  대신 정확히 적어준 문자열이기 때문.`,
    variants: [
      v("멘션", "workbench", ".wb-mention-chip", { context: ".wb-msg-text" }),
      v("경로", "workbench", ".wb-ref-chip", { context: ".wb-msg-text" }),
    ],
  },
  {
    id: "button", group: "Primitives", name: "Buttons", subtitle: "accent · soft · ghost · rule",
    prompt: `주 행동은 \`accent\`, 보조는 \`soft\`, 취소·닫기는 \`ghost\`.
\`rule\`(항상 허용)은 두 줄짜리라 승인 카드에서만 쓴다.

승인 카드의 버튼 순서는 **거부 → 이번만 → 항상**으로, 되돌리기 쉬운 쪽이 왼쪽이다.`,
    variants: [
      v("accent", "modal-runtime", ".wb-modal-foot .wb-btn-accent", { context: ".wb-modal-foot" }),
      v("ghost", "modal-runtime", ".wb-modal-foot .wb-btn-ghost", { context: ".wb-modal-foot" }),
      v("승인 3종", "approval", ".wb-approval-actions", { context: ".wb-approval" }),
    ],
  },
  {
    id: "pill", group: "Primitives", name: "Pills", subtitle: "모델 · 추론 · 사용량",
    prompt: `읽기와 열기를 겸하는 작은 표시. 캐럿이 있으면 **누르면 열린다**는 뜻이고,
없으면 라벨이다. 모델 필은 좁아지면 이름을 말줄임하되 사라지지는 않는다 — 어떤 모델로
말하고 있는지는 폭과 무관하게 답할 수 있어야 한다.`,
    variants: [
      v("모델", "workbench", ".wb-model-pill", { context: ".wb-toolbar-controls" }),
      v("사용량", "workbench", ".usage-pill", { context: ".usage-wrap" }),
    ],
  },
  {
    id: "donut", group: "Primitives", name: "Context donut", subtitle: "컨텍스트 점유 + 자동 압축 지점",
    prompt: `막대가 아니라 **링**이다(시안 확정 사항). 자동 압축이 켜져 있으면 임계값
위치에 눈금이 서고, 임계값~100% 구간은 \`--compact-zone\` 으로 칠해 "압축까지 남은
활주로"가 18px 에서도 읽히게 한다. 창 크기를 모르면 수치를 지어내지 않는다.`,
    variants: [v("점유 + 임계값", "workbench", ".wb-ctx-donut", { context: ".wb-toolbar-controls" })],
  },
  {
    id: "segmented", group: "Primitives", name: "Segmented", subtitle: "추론 강도 · 모드 · 프리셋",
    prompt: `선택지가 **적고 서로 배타적이며 순서가 의미 있을 때** 쓴다(Low→Max).
드롭다운과 달리 가능한 값 전체가 항상 보이는 게 요점이라, 값이 5개를 넘으면 쓰지 않는다.`,
    variants: [v("추론 강도", "modal-runtime", ".wb-segmented", { context: ".wb-modal-body" })],
  },
  {
    id: "switch", group: "Primitives", name: "Switch & toggle card", subtitle: "즉시 적용되는 on/off",
    prompt: `누르는 즉시 적용된다(저장 버튼 없음). 설명이 필요한 스위치는 **토글 카드**로
감싸 제목·부연을 함께 둔다 — 스위치 옆 한 줄로는 위험한 설정을 설명할 수 없다.`,
    variants: [
      v("스위치", "settings-general", ".set-switch", { context: ".set-toggle" }),
      v("토글 카드", "modal-runtime", ".wb-toggle-card", { context: ".wb-modal-body" }),
    ],
  },
  {
    id: "field", group: "Primitives", name: "Field & select", subtitle: "라벨 + 컨트롤 + 부연",
    prompt: `라벨은 항상 컨트롤 **위**에, 부연은 아래. 좌우 배치는 좁은 패널에서 먼저
깨진다. 설정 화면과 모달이 같은 필드를 쓰므로, 어디서 바꾸든 같은 것을 바꾸는 느낌이 된다.`,
    variants: [v("셀렉트 필드", "settings-harness", ".set-harness-card .set-field", { context: ".set-harness-card" })],
  },
  {
    id: "inline-note", group: "Primitives", name: "Inline note", subtitle: "설명 · 경고 · 오류",
    prompt: `카드 안에서 규칙을 설명하는 한 줄. 실패를 숨기지 않는 것이 이 프로젝트의
원칙이라, 오류는 조용히 사라지는 대신 여기로 나온다(\`is-error\`).`,
    variants: [v("설명", "settings-general", ".set-inline-note", { context: ".set-card" })],
  },

  // ---------------------------------------------------------------- Navigation
  {
    id: "tab", group: "Navigation", name: "Member tab", subtitle: "활성 · 작업 중 · 표시 · 드래그",
    prompt: `탭 하나가 멤버 하나다. 왼쪽 강조선과 점은 멤버 색을 쓰고, 하네스 칩은 좁아지면
먼저 사라진다(이름이 마지막까지 남는다).

**순서 바꾸기**: 탭을 끌면 커서가 대상 탭의 중앙선 어느 쪽이냐로 앞/뒤가 정해지고,
그 자리에 삽입선이 선다. 빈 작업 영역으로 끌면 새 패널이 된다.`,
    variants: [
      v("활성", "workbench", ".wb-tab.is-active", { context: ".wb-tabstrip", width: "300px" }),
      v("비활성", "workbench", ".wb-tab:not(.is-active)", { context: ".wb-tabstrip", width: "300px" }),
      v("작업 중", "queue", ".wb-tab.is-working", { context: ".wb-tabstrip", width: "300px" }),
      v("승인 대기", "approval", ".wb-tab", { context: ".wb-tabstrip", width: "300px" }),
    ],
  },
  {
    id: "tabstrip", group: "Navigation", name: "Tab strip", subtitle: "탭 줄 + 넘침(+N)",
    prompt: `패널의 탭 줄. 자리가 모자라면 탭을 **접어** \`+N\` 으로 보내고, 접힌 탭 중에
승인 대기나 안 읽음이 있으면 그 멤버의 색 점을 \`+N\` 에 찍는다 — 접혔다고 조용해지면
안 되기 때문이다. 탭을 더하는 버튼은 없다(멤버는 사이드바에서 연다).`,
    variants: [v("기본", "workbench", ".wb-tabstrip", { context: ".wb-panel", width: "640px" })],
  },
  {
    id: "settings-tabs", group: "Navigation", name: "Settings tabs", subtitle: "상위 탭 + 하네스 하위 탭",
    prompt: `상단 탭은 화면을 가르고, 그 안의 **하위 탭**은 같은 종류의 대상을 하나씩
고른다(하네스 기본값). 하위 탭 패널은 전부 mount 된 채 숨겨지므로, 저장 안 한 편집이
탭을 바꿨다고 사라지지 않는다. 미저장이면 하위 탭에 점이 붙는다.`,
    variants: [
      v("상위 탭", "settings-general", ".set-tabs", { context: ".app-body" }),
      v("하위 탭", "settings-harness", ".set-subtabs", { context: ".set-tab-panel" }),
    ],
  },

  // ------------------------------------------------------------------ Surfaces
  {
    id: "card", group: "Surfaces", name: "Card", subtitle: "설정 카드 · 하네스 카드",
    prompt: `설정 한 묶음을 담는 기본 면. 라벨은 대문자 소형 제목, 내용은 필드의 세로 나열.
카드 안의 커밋 버튼은 카드 폭을 꽉 채운다 — 좁은 칼럼에서 왼쪽에 붙은 버튼은 카드의
행동이 아니라 떠 있는 것으로 읽힌다.`,
    variants: [
      v("설정 카드", "settings-general", ".set-card", { context: ".set-tab-panel" }),
      v("하네스 카드", "settings-harness", ".set-harness-card", { context: ".set-subtab-panel" }),
    ],
  },
  {
    id: "modal", group: "Surfaces", name: "Modal", subtitle: "머리 · 본문 · 바닥",
    prompt: `**바깥 클릭으로 닫히지 않는다**(스크림도 Escape 도). 닫기는 ✕ 또는 바닥의
명시적 버튼뿐 — 설정을 만지다 실수로 날리는 쪽이 훨씬 비싸기 때문이다. 머리에는 대상
멤버를 그 색으로 적고, 바닥 왼쪽에는 변경 여부를 정직하게 적는다("변경 사항 없음").`,
    variants: [
      v("머리", "modal-runtime", ".wb-modal-head", { context: ".wb-modal" }),
      v("바닥", "modal-runtime", ".wb-modal-foot", { context: ".wb-modal" }),
    ],
  },
  {
    id: "menu", group: "Surfaces", name: "Menu & dropdown", subtitle: "권한 드롭다운 · 탭 넘침 목록",
    prompt: `떠 있는 목록. 그림자는 테마 토큰(\`--shadow\`)을 쓴다 — 밝은 배경 위의
검정 그림자는 깊이가 아니라 더러운 테두리로 보인다. 선택된 항목은 체크로 표시하고,
목록 아래에는 그 목록의 규칙을 한 줄로 적는다("선택한 탭은 맨 앞으로 이동합니다").`,
    variants: [v("드롭다운", "menu-open", ".wb-dd-menu", { context: ".wb-dd" })],
  },

  // -------------------------------------------------------------------- Blocks
  {
    id: "block-message", group: "Blocks", name: "Message blocks", subtitle: "사용자 · 어시스턴트 · 채널",
    prompt: `대화의 기본 단위. 사용자 메시지는 오른쪽 정렬 말풍선이고 보낸 그대로의 칩을
유지한다. 어시스턴트 본문은 마크다운(코드·표·목록)을 렌더하고, 링크는 앱이 아니라 OS
브라우저로 나간다. 긴 본문은 잘라 보여주고 "전체 보기"로 연다.`,
    variants: [
      v("사용자", "workbench", ".wb-user", { context: ".wb-transcript" }),
      v("어시스턴트", "workbench", ".wb-assistant", { context: ".wb-transcript" }),
    ],
  },
  {
    id: "block-tool", group: "Blocks", name: "Tool call", subtitle: "명령 · 결과 · exit/소요",
    prompt: `도구 실행 하나. 접힌 상태에서도 **무엇을 했는지**(이름 + 인자 요약)는 보이고,
긴 명령/출력은 미리보기만 인라인으로 둔 뒤 전체는 팝업에서 본다.
\`Read\` 처럼 파일을 모델 컨텍스트로 읽는 도구는 결과가 이미지여도 그림을 그리지 않는다 —
사용자가 보자고 한 게 아니기 때문. 네이티브 \`image_view\`도 모델의 참고용이므로 펼칠 때만 그리고, 사용자 표시가 목적인 AgentParty \`attach-image\`만 즉시 그린다.`,
    variants: [v("완료", "workbench", ".wb-tool", { context: ".wb-transcript" })],
  },
  {
    id: "block-plan", group: "Blocks", name: "Plan", subtitle: "단계 체크리스트",
    prompt: `모델이 세운 계획. 단계마다 상태(완료·진행 중·대기)를 아이콘으로 들고 있고,
갱신될 때 카드를 새로 쌓지 않고 **같은 카드가 변한다** — 계획은 목록이 아니라 상태다.`,
    variants: [v("진행 중", "workbench", ".wb-plan", { context: ".wb-transcript" })],
  },
  {
    id: "block-approval", group: "Blocks", name: "Approval card", subtitle: "하네스별 · 결정 후 상태",
    prompt: `모델이 권한을 요구하는 순간. 실제 하네스 기록에서 나온 페이로드만 그린다 —
Codex 는 사유·규칙을 주고, Claude 는 막힌 경로를 준다. **없는 필드는 지어내지 않는다**
(예: 실제 요청에 파일 diff 가 오지 않으면 diff 자리를 만들지 않는다).

결정한 뒤에는 한 줄로 접혀 무엇을 어떤 범위로 허락했는지 남긴다.`,
    variants: [
      v("Codex · 명령", "gallery:01-codex-명령", ".wb-approval", { context: ".wb-transcript" }),
      v("Codex · 사유 없음", "gallery:02-codex-사유없음", ".wb-approval", { context: ".wb-transcript" }),
      v("Codex · 파일 변경", "gallery:03-codex-파일변경", ".wb-approval", { context: ".wb-transcript" }),
      v("Claude · 명령", "gallery:04-claude-명령", ".wb-approval", { context: ".wb-transcript" }),
      v("Claude · 파일 편집", "gallery:05-claude-파일변경", ".wb-approval", { context: ".wb-transcript" }),
      v("Claude · 작업공간 밖", "gallery:06-claude-작업공간밖", ".wb-approval", { context: ".wb-transcript" }),
      v("승인함", "gallery:09-claude-승인함", ".wb-approval", { context: ".wb-transcript" }),
      v("거부함", "gallery:10-claude-거부함", ".wb-approval", { context: ".wb-transcript" }),
    ],
  },
  {
    id: "block-question", group: "Blocks", name: "Question card", subtitle: "단일 · 다중 · 자유 · 비밀 · 답변 후",
    prompt: `모델이 사람에게 묻는 카드(AskUserQuestion). 선택지가 없으면 자유 입력,
\`secret\` 이면 마스킹한다. 다중 선택은 표시를 **네모**로 바꿔 단일 선택과 구분하고
"복수 선택" 안내를 붙인다 — 모양만 다르면 규칙을 모른다.`,
    variants: [
      v("단일 선택", "gallery:11-질문-단일선택", ".wb-question", { context: ".wb-transcript" }),
      v("다중 선택", "gallery:12-질문-다중선택", ".wb-question", { context: ".wb-transcript" }),
      v("자유 입력", "gallery:13-질문-자유입력", ".wb-question", { context: ".wb-transcript" }),
      v("비밀 입력", "gallery:14-질문-비밀입력", ".wb-question", { context: ".wb-transcript" }),
      v("답변함", "gallery:16-답변함-한건", ".wb-approval", { context: ".wb-transcript" }),
    ],
  },
  {
    id: "block-compact", group: "Blocks", name: "Compaction card", subtitle: "진행 중 · 완료 · 수치 없음 · 실패",
    prompt: `대화 압축의 시작과 끝을 말한다. 압축은 컨텍스트 숫자를 조용히 떨어뜨리는
일이라, 카드가 없으면 설명되지 않은 변화로 보인다.
**하네스가 준 수치만** 적는다 — Codex 는 토큰 수를 보내지 않으므로 그 카드에는 수치가
없다(0 이라고 쓰지 않는다). 실패는 이유와 함께 다시 시도를 제안한다.`,
    variants: [
      v("진행 중", "gallery:18-압축-진행중", ".wb-compact", { context: ".wb-transcript" }),
      v("완료", "gallery:19-압축-완료", ".wb-compact", { context: ".wb-transcript" }),
      v("수치 없음(Codex)", "gallery:20-압축-수치없음", ".wb-compact", { context: ".wb-transcript" }),
      v("실패", "gallery:21-압축-실패", ".wb-compact", { context: ".wb-transcript" }),
    ],
  },
  {
    id: "block-environment", group: "Blocks", name: "Environment card", subtitle: "미설치 · 미로그인 · 버전 차이 · 해결됨",
    prompt: `하네스를 못 띄웠을 때. 원인마다 **할 수 있는 행동**이 다르므로 버튼이 다르다
(설치 / 로그인 / 그냥 경고). 같은 실패가 반복돼도 카드는 하나로 유지한다.
고쳐지면 같은 카드가 초록으로 바뀌고, 못 보낸 메시지를 **자동으로 보내지 않고**
"다시 시도"를 제안한다.`,
    variants: [
      v("미설치", "gallery:22-환경-미설치", ".wb-env", { context: ".wb-transcript" }),
      v("미로그인", "gallery:23-환경-미로그인", ".wb-env", { context: ".wb-transcript" }),
      v("버전 차이", "gallery:24-환경-버전차이", ".wb-env", { context: ".wb-transcript" }),
      v("해결됨", "gallery:25-환경-해결됨", ".wb-env", { context: ".wb-transcript" }),
    ],
  },
  {
    id: "queue", group: "Blocks", name: "Message queue", subtitle: "대기 중인 메시지",
    prompt: `멤버가 작업 중일 때 보낸 메시지가 쌓이는 곳. 대화에 섞지 않고 여기 세워두는
이유는, 아직 **읽히지 않았기** 때문이다 — 전달되는 순간 대화에 들어간다.
행은 순서를 바꿀 수 있고, 편집하면 입력창으로 돌아온다.`,
    variants: [v("2건 대기", "queue", ".wb-queue", { context: ".wb-panel" })],
  },
  {
    id: "subagent-dock", group: "Blocks", name: "Subagent dock", subtitle: "서브에이전트 목록 + 현재 동작",
    prompt: `멤버가 띄운 서브에이전트들. 각 줄은 지금 무엇을 하는지 한 줄로 말하고,
클릭하면 그 에이전트의 대화로 들어간다. 부모 대화와 **분리된 슬라이스**로 보관하므로
서브에이전트의 출력이 부모 트랜스크립트를 밀어내지 않는다.`,
    variants: [v("5개 실행 중", "workbench", ".wb-subdock", { context: ".wb-panel" })],
  },

  // ---------------------------------------------------------------- Composites
  {
    id: "composer", group: "Composites", name: "Composer", subtitle: "입력 + 전송 + 권한",
    prompt: `보내는 곳. Stop 은 전송 슬롯을 **빼앗지 않고 옆에 선다** — 작업 중에도
대기열에 넣는 것이 가능해야 하기 때문이다. 권한 컨트롤이 여기 있는 이유는 지금 말을
거는 대상의 권한이기 때문이고, 이 멤버의 권한을 바꿀 수 있는 **유일한 자리**라 좁아져도
숨기지 않는다(좁으면 줄이 접힌다).`,
    variants: [v("기본", "workbench", ".wb-composer", { context: ".wb-panel" })],
  },
  {
    id: "panel", group: "Composites", name: "Panel", subtitle: "탭 + 툴바 + 대화 + 입력",
    prompt: `멤버 하나를 보는 단위. 폭에 따라 안쪽이 줄어들되(상태 필 → 추론 필 → 하네스
칩 순으로 사라진다) **어떤 컨트롤도 도달 불가능해지지 않는다.** 아주 좁아지면 툴바의
멤버 이름은 생략한다 — 바로 위 탭이 같은 이름을 이미 말하고 있기 때문.`,
    variants: [v("기본", "workbench", ".wb-panel", { context: ".wb-workarea", height: "620px" })],
  },
  {
    id: "sidebar", group: "Composites", name: "Party sidebar", subtitle: "파티 · 멤버 목록",
    prompt: `무엇이 존재하는지 아는 목록. 멤버를 클릭하면 패널로 열리고, 우클릭으로
슬립/유지/삭제 같은 수명 조작을 한다. 각 행은 멤버 색 점 + 하네스 + 상태를 들고 있어
목록만 보고도 누가 일하는지 알 수 있다.`,
    variants: [v("기본", "workbench", ".wb-sidebar", { context: ".app-body", height: "560px" })],
  },
];

/** Groups in the order the pane should list them. */
export const GROUP_ORDER = ["Foundations", "Primitives", "Navigation", "Surfaces", "Blocks", "Composites"];
