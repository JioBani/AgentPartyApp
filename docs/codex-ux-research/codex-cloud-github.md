# Codex Cloud · GitHub 코드리뷰 · 모바일 · 크로스 서페이스 조사

이 문서는 Codex의 **클라우드/원격 표면**을 다룬다. AgentParty가 Codex 하네스에
"클라우드 위임"을 붙일 때의 요구사항. 로컬 CLI 표면은 `codex-cli.md`.

웹 검증일: 2026-07-01. 출처 하단.

## 1. Codex Cloud 개요

- **무엇**: `chatgpt.com/codex`(ChatGPT 좌측 사이드바 "Codex")의 클라우드 호스팅
  SW 엔지니어링 에이전트. 각 작업은 연결된 GitHub 저장소에 대해 격리된 클라우드
  샌드박스 컨테이너에서 백그라운드 실행. OpenAI 비유: "백그라운드로 돌다가 결정이
  필요할 때 돌아오는 주니어 개발자에게 위임". Plus/Pro/Business/Edu/Enterprise 포함.
- **작업 위임(composer)**:
  1. 저장소/환경 선택(환경 = repo + 선택적 branch에 묶인 워크스페이스).
  2. 자연어 프롬프트 입력.
  3. 모드 버튼: **Code**(파일 변경 → diff/PR) / **Ask**(읽기전용 질의응답).
  4. 선택적으로 다중 시도(§4).
- 같은 클라우드 작업을 만드는 진입점: IDE 확장(composer의 클라우드 아이콘),
  GitHub `@codex` mention, 데스크톱 앱의 Cloud 스레드 모드, `codex cloud` CLI.
- **대시보드**: 현재+과거 작업 리스트(프롬프트/제목, 대상 repo, 상태 배지).
  행 클릭 → 상세. 백그라운드·병렬 실행이라 리스트가 멀티플렉서.
- **작업 상태**(openai/codex 세션 상태): `QUEUED → PLANNING →
  AWAITING_PLAN_APPROVAL → IN_PROGRESS → AWAITING_USER_FEEDBACK →
  COMPLETED / FAILED`. 사용자 용어로 queued / running / **needs-input**
  (plan 승인·피드백 대기) / done(diff 준비) / failed.
- **진행 표시**: 실시간 로그(실행 명령/테스트 출력) + 단계별 reasoning. 무시하고
  백그라운드로 둬도 됨. 모바일 앱이 같은 진행을 미러(§7).

## 2. 환경(Environments)

Codex settings의 환경 구성 페이지:

- **repo 연결**: "Connect your GitHub account"(repo 읽기 + PR 열기 권한).
  환경마다 repo(+선택 branch)에 바인딩.
- **컨테이너 이미지**: 기본 `universal`(공통 언어/툴 사전 설치). "Set package
  versions"로 Python/Node 등 런타임 버전 고정.
- **setup 스크립트**: npm/yarn/pnpm/pip/pipenv/poetry는 자동 설치, 그 외는 커스텀
  Bash. **주의**: setup은 agent와 별도 Bash 세션 → `export`가 agent 단계로
  전파 안 됨(`~/.bashrc`/환경설정으로 영속).
- **maintenance 스크립트**: 캐시 컨테이너 재개 시 실행(커밋 간 deps 갱신 등).
- **환경변수 vs Secrets**(별도 UI 필드): 환경변수는 setup+agent 전체, **Secrets는
  추가 암호화 + agent 단계 시작 전 제거**(보안). private repo git 토큰은 setup에서
  소비해야 함.
- **네트워크**: setup 단계 인터넷 on, **agent 단계 기본 off**(별도 설정으로 제한/
  무제한 상향). 모든 트래픽 HTTP/HTTPS 프록시.
- **캐싱**: 컨테이너 상태 최대 **12시간** 캐시(follow-up 가속). setup/maintenance/
  env/secrets 변경 시 자동 무효화. 수동 reset 컨트롤.

## 3. 작업 결과 UX

- **diff 뷰**: git 스타일(추가 녹색/삭제 빨강), 파일별.
- **Logs 탭**: 단계별 행동/명령/테스트 출력 + reasoning, **터미널 로그/테스트
  출력 인용**(검증 가능 증거).
- **적용 3경로**:
  1. **클라우드에서 PR 열기** — 버튼으로 GitHub PR 생성 → GitHub에서 리뷰/머지.
  2. **로컬 적용(CLI)** — `codex cloud list` → `codex cloud apply <task-id>`가
     최근 diff를 워킹트리에 적용. 패치 파일 출력, **`git apply` 실패 시 비정상
     종료(non-zero)** — 가시 실패. `codex cloud`(무인자)는 인터랙티브 picker.
  3. **follow-up 후 적용** — 수정 요청 후 apply/PR.
  - 스크립트: `codex cloud exec --env <ID> "<prompt>"`,
    `codex cloud wait <id>`, `codex cloud logs <id> --json`,
    `codex cloud output <id> --json`, `codex cloud message <id>`,
    `codex cloud status <id>`, `codex cloud diff <id>`.
  - 참고: 로컬 `codex apply <TASK_ID>`도 agent가 낸 최신 diff를 `git apply`.

## 4. 병렬 / best-of-N / follow-up

- **병렬**: 여러 클라우드 작업이 독립 컨테이너에서 동시 실행(대시보드가 병렬 뷰).
- **best-of-N**: `--attempts N`(**1~4**)로 같은 프롬프트를 N회 독립 실행 → 비교
  선택. 웹 UI에서는 후보 해답으로 노출.
- **follow-up**: 작업에 추가 프롬프트로 반복(클라우드는 같은 스레드 context 유지).

## 5. GitHub 통합 — PR 코드리뷰

- **활성화**: repo에 Codex cloud 설정 → `chatgpt.com/codex/settings/code-review`
  에서 "Code review" 토글. "Automatic reviews"로 새 PR 전부 자동 리뷰 옵션.
- **수동 트리거**: PR에 `@codex review` 코멘트. Codex가 **👀** 이모지로 ack 후
  리뷰 게시. 가이드 변형: `@codex review for security vulnerabilities` 등.
- **리뷰 모습**: 라인별 인라인 코멘트 + 요약. **P0/P1만 flag**(노이즈 억제).
- **리뷰 가이드라인**: repo의 `AGENTS.md` `## Review guidelines` 섹션 반영(수정
  파일에 가장 가까운 AGENTS.md).
- **후속**: `@codex fix the P1 issue` / `@codex fix it`이 클라우드 작업을 띄워
  PR branch에 수정 push(권한 허용 시). 리뷰 코멘트에 답글도 새 작업 트리거.

## 6. (데스크톱 앱은 `codex-ide-desktop.md` Part B 참조)

## 7. 모바일 / ChatGPT 앱

- ChatGPT **iOS/Android 앱** 내 Codex(Free/Go 포함 프리뷰, 지원 지역).
- 두 가지: (1) **폰에서 클라우드 작업** — 스레드 작업/출력 리뷰/**명령 승인/모델
  변경**/새 작업 시작(순수 클라우드). (2) **Codex for Mac 원격 제어(페어링)** —
  Mac 앱이 **QR 코드** 생성 → 폰 앱으로 스캔 페어링 → 폰에서 start/steer/approve/
  check-in. 파일/자격증명/권한/로컬 셋업은 호스트에 유지, 폰으로는 **스크린샷/
  터미널 출력/diff/테스트 결과/승인**만 실시간 전달. 런치 시 macOS만(Windows 예고).

## 8. 인증 / 플랜 / rate limit(사용자 관점)

- 인증: ChatGPT 계정(권장) 또는 OpenAI API 키. GitHub는 별도 연결(repo/PR).
- 포함 플랜: Plus/Pro/Business/Edu/Enterprise(클라우드/데스크톱). 모바일 프리뷰는
  Free/Go까지.
- rate limit: 로컬 메시지 + 클라우드 작업이 **단일 rolling 5시간 창** 공유 +
  주간 한도. 모델별. (2차, 드리프트 주의) Plus ≈ GPT-5.5 15~80 msg/5h, Pro($100)
  ≈ Plus의 5배. 한도 도달 시 **크레딧 구매** 또는 `gpt-5.4-mini`로 전환 안내.
  → 정확한 수치는 `chatgpt.com/codex/pricing`에서 재확인.

## 9. 크로스 서페이스 핸드오프(하나의 작업, 여러 표면)

Codex는 **context(plan+diff+스레드)가 표면 간 이동**하도록 설계:

- **CLI**: `codex` 세션 → `codex cloud exec`로 클라우드 push → `codex cloud
  apply <id>`로 결과 pull.
- **IDE → Cloud**(문서화된 "Delegate refactor to the cloud"):
  1. IDE에서 로컬 계획/context 수집. 2. composer 아래 클라우드 아이콘 →환경 선택.
  3. 다음 프롬프트에서 **기존 스레드 context를 넘겨받는 새 클라우드 스레드 생성**
  (plan + 로컬 소스 변경 동반). 4. 클라우드 diff 리뷰/반복 → **클라우드에서 PR
  생성 또는 로컬 pull**.
- **Cloud → Local**: `codex cloud apply <id>`(또는 인터랙티브 picker).
- **데스크톱 앱**이 Local/Worktree/Cloud 선택기로 셋을 통합.
- 일관 원칙: 실행 위치(내 머신 / 격리 worktree / 클라우드 컨테이너)와 리뷰/적용
  방식만 다르고 context는 이동.

## AgentParty 시사점

- **클라우드 위임은 Codex 하네스의 차별 기능**이 될 수 있다. member 액션으로
  "Run in cloud"(from main / from local changes) → 진행 모니터 → 결과 diff pull.
  프로토콜상 `codex cloud *`는 CLI 서브커맨드이므로, 초기에는 `codex cloud
  exec/status/logs/apply`를 감싼 백엔드 job으로 구현 가능(app-server가 아니라
  CLI 배치). 향후 app-server가 클라우드 request를 노출하면 통합.
- **작업 상태 모델**: Codex Cloud의 `AWAITING_USER_FEEDBACK`/`AWAITING_PLAN_
  APPROVAL`은 AgentParty의 "Needs input" 상태와 직결 → sidebar/inbox에 반영.
- **PR/CI 결과 표현**: Claude Code 조사의 "Ready for review" group·PR badge와
  동일 요구. Codex는 `@codex` GitHub 리뷰·클라우드 PR 생성이 있어 PR entity가
  더 1급. member row PR badge + transcript "PR opened" 카드 + CI status.
- **best-of-N(`--attempts` 1~4)**: AgentParty가 dispatch 시 "N회 시도 후 비교"
  옵션으로 노출 가능(Claude Code에는 없는 Codex 고유).
- **환경/시크릿**: 클라우드 위임을 지원하면 환경 선택·secret 필드가 필요.
  민감정보라 no-silent-fallback + 명시적 마스킹.

## 출처 (검증 2026-07-01)

- https://developers.openai.com/codex/cloud , /codex/cloud/environments
- https://developers.openai.com/codex/integrations/github
- https://developers.openai.com/codex/use-cases/github-code-reviews
- https://developers.openai.com/codex/workflows , /codex/quickstart
- https://developers.openai.com/codex/cli/reference , /codex/cli/features
- https://github.com/openai/codex (세션 상태 enum, `codex-rs/app-server`)
- https://chatgpt.com/codex/pricing/
- (검색 발췌; 직접 fetch 403) openai.com/index/introducing-upgrades-to-codex ,
  openai.com/index/work-with-codex-from-anywhere , chatgpt.com/codex/mobile ,
  help.openai.com/en/articles/11369540
- (2차) simplemetrics.xyz, venturebeat.com, datacamp.com, codex.danielvaughan.com
</content>
