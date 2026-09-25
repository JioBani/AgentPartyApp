/**
 * 실제 공개 릴리스 14개 (JioBani/AgentParty-releases, 2026-09-26 기준).
 * 버전 화면 목업이 긴 노트·이미지·짧은 노트를 모두 실제 모양으로 보여주도록 그대로 담았다.
 */
import type { ReleaseSummary } from "../../shared/appUpdate";

export const RELEASES: ReleaseSummary[] = [
  {
    "version": "0.15.0",
    "name": "v0.15.0",
    "notes": "## 주요 변경\n\n### 멤버가 앱 안의 브라우저로 웹페이지를 살펴봅니다\n\n각 멤버에게 독립된 인앱 브라우저가 생겼습니다. 멤버에게 URL을 열어 달라고 요청하면 페이지의 본문과 화면에 보이는 버튼·링크·입력 항목을 확인할 수 있습니다. 브라우저 화면을 열어두면 멤버가 클릭, 입력, 스크롤, 이전·다음 페이지 이동과 스크린샷 촬영도 할 수 있습니다. 웹 조사와 대화를 AgentParty 안에서 이어갈 수 있으며, 컴퓨터 전체의 마우스를 조작하지 않습니다.\n\n### 멤버 탭 안에서 대화와 브라우저를 전환하세요\n\n멤버 탭의 오른쪽 메뉴에서 **브라우저 탭 보기**를 누르면 현재 멤버 탭이 브라우저 화면으로 바뀝니다. 별도 탭으로 이동하거나 새 탭을 만들지 않습니다. 브라우저에서 **대화 탭 보기**를 누르면 같은 탭에 대화가 다시 나타납니다. 웹페이지는 그대로 유지되므로 오가며 확인할 수 있습니다.\n\n![하나의 멤버 탭에서 브라우저를 보는 화면](https://raw.githubusercontent.com/JioBani/AgentParty-releases/main/media/releases/v0.15.0/browser-in-member-tab.png)\n\n### 동시에 보고 싶을 때만 분리하세요\n\n브라우저의 **브라우저 탭 분리하기**를 누르면 같은 탭 그룹에 별도의 브라우저 탭이 생깁니다. 이 탭을 옆 패널로 나누면 멤버와 대화하면서 웹페이지를 함께 볼 수 있습니다. 다시 **멤버 탭과 합치기**를 누르면 별도 탭이 없어지고 기존 멤버 탭에서 브라우저를 볼 수 있습니다.\n\n![멤버 대화와 브라우저를 나란히 연 화면](https://raw.githubusercontent.com/JioBani/AgentParty-releases/main/media/releases/v0.15.0/browser-side-by-side.png)\n\n### 브라우저 작업이 보고 있던 화면을 빼앗지 않습니다\n\n멤버가 페이지를 열거나 조작해도 현재 선택한 탭과 패널이 자동으로 바뀌지 않습니다. 옆 패널에서 대화를 읽는 동안 브라우저의 클릭·입력 결과를 확인할 수 있고, 데스크톱 마우스 포인터도 움직이지 않습니다. 화면 전환은 **보기·분리·합치기**처럼 명시적인 버튼을 사용할 때만 일어납니다.\n\n### Codex CLI의 기존 기능을 그대로 이용할 수 있습니다\n\nAgentParty의 내장 브라우저를 추가했다는 이유로 Codex CLI에서 제공하는 Computer Use나 브라우저 연결 기능을 숨기지 않습니다. 실제 사용 가능 여부는 설치된 Codex CLI와 해당 세션에 연결된 도구 환경에 따릅니다.\n\n## 업데이트 안내\n\n기존에 분리해 둔 브라우저 탭 배치는 유지되며, 원하는 때 **멤버 탭과 합치기**로 전환할 수 있습니다. 파티·세션·설정 데이터의 마이그레이션은 필요하지 않습니다. 앱 내 브라우저의 로그인 상태는 앱을 종료하면 유지되지 않습니다. 클릭·입력·스크린샷에는 해당 브라우저 화면을 앱에 표시해야 합니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.15.0.exe`를 설치하세요.\n- `AgentParty-0.15.0.exe`는 설치 없이 실행하는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.\n",
    "publishedAt": "2026-09-25T15:02:40Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.15.0",
    "prerelease": false
  },
  {
    "version": "0.14.0",
    "name": "v0.14.0",
    "notes": "## 주요 변경\n\n이번 0.14.0은 버전 표기를 조정한 재배포입니다. 앞서 공개한 1.0.0과 기능은 동일합니다.\n\n### 대화와 브라우저를 나란히 보며 작업하세요\n\n멤버가 앱 안에서 전용 브라우저 탭을 열 수 있습니다. 브라우저 탭을 대화 옆 패널로 옮기면 웹페이지를 보면서 멤버와 계속 대화할 수 있습니다. 멤버는 페이지 내용을 읽고, 클릭·입력·스크롤할 수 있으며 이 과정에서 데스크톱 마우스 포인터를 움직이지 않습니다.\n\n![멤버 대화와 전용 브라우저 탭을 나란히 연 AgentParty 0.14](https://raw.githubusercontent.com/JioBani/AgentParty-releases/main/media/releases/v0.14.0/browser-side-by-side.png)\n\n*예시 화면: 왼쪽은 멤버 대화, 오른쪽은 같은 멤버의 앱 내 브라우저입니다.*\n\n### Codex가 만든 파일과 다음 작업을 바로 이어가세요\n\nCodex 답변에 포함된 파일 인용은 긴 내부 표기 대신 파일 이름과 열기/위치 확인 버튼으로 표시됩니다. 제안된 후속 작업도 버튼을 눌러 해당 멤버에게 바로 요청할 수 있습니다.\n\n![Codex 답변의 파일 링크와 후속 작업 버튼](https://raw.githubusercontent.com/JioBani/AgentParty-releases/main/media/releases/v0.14.0/codex-results.png)\n\n*예시 대화로 촬영한 화면이며 실제 사용자 파일이나 작업 내용은 포함하지 않았습니다.*\n\n### 모델 선택과 작업 상태를 다듬었습니다\n\n- 지원되는 Claude Code CLI에서는 **Opus 5.5**를 선택할 수 있습니다. 이 모델은 Claude Code 2.1.280 이상이 필요합니다.\n- 멤버 탭을 다시 열 때 탭 배치가 예상과 다르게 바뀌는 문제를 수정했습니다.\n- 작업이 진행 중인데 잠시 `idle`로 표시되던 현상을 수정했습니다.\n\n## 업데이트 안내\n\n1.0.0 설치본에서는 0.14.0이 버전 되돌리기 업데이트로 표시될 수 있습니다. 기존 파티·세션·설정 데이터의 마이그레이션은 필요하지 않습니다. 현재 앱 내 브라우저의 로그인 상태는 앱을 종료하면 유지되지 않습니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.14.0.exe`를 설치하세요.\n- `AgentParty-0.14.0.exe`는 설치 없이 실행하는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.\n",
    "publishedAt": "2026-09-25T07:19:22Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.14.0",
    "prerelease": false
  },
  {
    "version": "0.13.0",
    "name": "v0.13.0",
    "notes": "모델 카탈로그 정렬, 모델별 자동 컴팩팅 설정, GPT-6 Sol/Luna Fast 선택기 및 설정 화면 개선",
    "publishedAt": "2026-09-23T08:29:05Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.13.0",
    "prerelease": false
  },
  {
    "version": "0.12.2",
    "name": "v0.12.2",
    "notes": "## AgentParty 0.12.2\n\n- Codex 0.155.1에서 새로 노출된 **GPT-6 Sol**을 Codex/Claude Code 모델 카탈로그에 추가했습니다.\n- GPT-6 Sol의 이미지 입력, low~ultra 추론 단계, 기본 medium, Fast 모드를 실제 계정 카탈로그 기준으로 지원합니다.\n- 새 Codex 설치에서 모델 목록 초기화가 오래 걸릴 때 자동 재시도하도록 개선했습니다.\n\n설치 후 Codex에 로그인되어 있으면 모델 선택 화면에서 바로 사용할 수 있습니다.",
    "publishedAt": "2026-09-22T18:10:35Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.12.2",
    "prerelease": false
  },
  {
    "version": "0.12.1",
    "name": "v0.12.1",
    "notes": "## 변경 사항\n\n- Claude Code 2.1.280 이상에서 **Opus 5.5**를 모델 목록에서 바로 선택할 수 있습니다.\n- Opus 5.5의 1M 컨텍스트, 이미지 입력, adaptive thinking과 low~max effort 설정을 반영했습니다.\n- 모델 카탈로그는 앱 업데이트와 별도로도 갱신되어 새 모델을 더 빠르게 받아볼 수 있습니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.12.1.exe`를 설치하세요.\n- `AgentParty-0.12.1.exe`는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.\n- Opus 5.5를 사용하려면 Claude Code 2.1.280 이상이 필요합니다.",
    "publishedAt": "2026-09-22T17:05:39Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.12.1",
    "prerelease": false
  },
  {
    "version": "0.12.0",
    "name": "v0.12.0",
    "notes": "## 변경 사항\n\n- Muse Code CLI를 정식 멤버로 추가하고 모델 카탈로그, 승인, 파티 도구 통신을 지원합니다.\n- Muse 구독 사용량을 표시하며, 수동 새로고침은 대화 기록을 건드리지 않는 최소 실제 호출로 최신 값을 가져옵니다.\n- Grok 4.7 모델 경로와 최신 Codex 호환성 보정을 포함합니다.\n\n## 설치\n\n- 자동 업데이트는 AgentParty Setup 0.12.0 설치본에서 지원됩니다.\n- AgentParty 0.12.0 포터블 버전은 자동 업데이트를 지원하지 않습니다.",
    "publishedAt": "2026-09-22T09:25:03Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.12.0",
    "prerelease": false
  },
  {
    "version": "0.11.2",
    "name": "v0.11.2",
    "notes": "## 변경 사항\n\n- Codex에서 B.AI DeepSeek 모델을 호출할 때 `reasoning.summary` 오류로 답변이 시작되지 않던 문제를 수정했습니다.\n- 최신 Codex CLI에서도 B.AI가 지원하지 않는 추론 요약 필드를 보내지 않도록 호환 설정을 적용했습니다.\n- B.AI API 키를 저장할 때 진단 로그에 키 원문이 남지 않도록 보호를 강화했습니다.\n\n## 설치\n\n- 자동 업데이트: AgentParty-Setup-0.11.2.exe\n- Portable: AgentParty-0.11.2.exe",
    "publishedAt": "2026-09-21T12:59:58Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.11.2",
    "prerelease": false
  },
  {
    "version": "0.11.1",
    "name": "v0.11.1",
    "notes": "채팅이 자동으로 응답을 따라갈 때 정확히 맨 아래에 붙도록 수정했습니다. 사용자가 직접 위로 스크롤한 경우에는 읽던 위치를 유지하고, 새 메시지를 보내면 다시 최신 대화를 따라갑니다.\n\n기존 Codex 대화 세션에서도 AgentParty 전송·상태·목록 도구를 정상적으로 사용할 수 있도록 호환 경로를 보강했습니다.",
    "publishedAt": "2026-09-21T00:54:35Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.11.1",
    "prerelease": false
  },
  {
    "version": "0.11.0",
    "name": "v0.11.0",
    "notes": "## 변경 사항\n\n- 가이드의 슬라이드 기능을 잠시 숨기고, 질문과 답변에 집중할 수 있도록 채팅 화면을 정리했습니다.\n- 가이드 채팅을 일반 멤버 채팅과 같은 전체 폭으로 맞춰, 답변이 길어져도 화면 폭이나 정렬이 달라지지 않습니다.\n- 가이드 문서를 현재 기능 기준으로 갱신하고 SSH 원격 멤버와 B.AI DeepSeek 사용법을 더 자세히 안내합니다.\n- 비용 안내를 연결한 AI 구독 사용량을 사용하는 방식으로 바꾸고, 불필요한 비용·언어·내부 문서 경로 표시를 제거했습니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 AgentParty-Setup-0.11.0.exe를 설치하세요.\n- AgentParty-0.11.0.exe는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.",
    "publishedAt": "2026-09-20T13:01:36Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.11.0",
    "prerelease": false
  },
  {
    "version": "0.10.0",
    "name": "AgentParty v0.10.0",
    "notes": "## 변경 사항\n\n### SSH 서버에서 멤버 실행\n\n- 이제 Windows나 WSL뿐 아니라 원격 SSH 서버에서도 AgentParty 멤버를 실행할 수 있습니다. **설정 → SSH 서버**에서 서버를 등록한 뒤, 멤버 생성 화면에서 SSH 서버와 원격 작업 폴더를 선택하세요.\n- 비밀번호와 개인 키 로그인을 지원하며, 비밀번호로 처음 연결한 뒤 공개 키를 설치해 자동 로그인으로 전환할 수 있습니다. 처음 보는 서버나 변경된 호스트 지문은 사용자가 직접 확인하고 신뢰해야 연결됩니다.\n- 원격 폴더는 직접 입력하거나 찾아보기와 경로 제안으로 선택할 수 있습니다. 현재 SSH 멤버는 Claude Code와 Codex를 지원합니다.\n- 서버 연결이 끊기거나 인증에 실패하면 메시지를 대기열에 넣어 둔 것처럼 보이지 않고 **전송 실패**로 명확하게 남습니다. 멤버 화면에서 바로 SSH 서버 설정으로 이동해 다시 연결한 뒤 재전송할 수 있습니다.\n\n### B.AI의 DeepSeek 모델 지원\n\n- **인증** 화면에서 B.AI API 키를 저장하고 실제 연결을 테스트할 수 있습니다. 키는 마스킹되어 표시되며 필요할 때 같은 화면에서 지울 수 있습니다.\n- Codex 하네스에서 `DeepSeek V4.1 Flash`, `DeepSeek V4 Pro`, `DeepSeek V4 Flash Vision Exp`의 B.AI 경로를 선택할 수 있습니다. 모델 이름에 `B.AI`가 표시되어 다른 제공 경로와 구분됩니다.\n- 각 모델에서 실제로 지원하는 추론 강도만 선택할 수 있고, 지원하지 않는 설정은 임의로 바꾸지 않고 오류로 안내합니다. 사용량은 연결한 B.AI 계정의 크레딧으로 청구됩니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.10.0.exe`를 설치하세요.\n- `AgentParty-0.10.0.exe`는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.",
    "publishedAt": "2026-09-18T09:51:10Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.10.0",
    "prerelease": false
  },
  {
    "version": "0.9.0",
    "name": "AgentParty v0.9.0",
    "notes": "## 변경 사항\n\n- 파티 그룹 안에서 파티 순서를 드래그로 변경할 수 있으며, 선택한 파티가 즐겨찾기에 있으면 즐겨찾기 위치로 자동 스크롤됩니다.\n- Codex가 AgentParty 핵심 파티 도구를 즉시 찾고, 재개된 세션에서도 도구와 사용 지침을 안정적으로 유지합니다.\n- 과거 대화를 보던 중 새 메시지를 보내면 최신 대화로 이동하고, 이후 스트리밍 응답과 권한 요청도 자동으로 하단을 따라갑니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.9.0.exe`를 설치하세요.\n- `AgentParty-0.9.0.exe`는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.",
    "publishedAt": "2026-09-16T07:25:13Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.9.0",
    "prerelease": false
  },
  {
    "version": "0.8.0",
    "name": "v0.8.0",
    "notes": "Message Gate를 발신·수신 설정으로 분리하고, 두 규칙을 한 번의 심사로 함께 판정하도록 개선했습니다. 기존 Message Gate 설정은 발신 규칙으로 안전하게 이전되며 수신 규칙은 기본적으로 꺼져 있습니다. 모델 카탈로그, Effort·Fast 선택, 멤버 목록의 빠른 설정 진입점과 오류·반려 표시도 정리했습니다.",
    "publishedAt": "2026-09-13T12:19:33Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.8.0",
    "prerelease": false
  },
  {
    "version": "0.7.1",
    "name": "AgentParty v0.7.1",
    "notes": "## 변경 사항\n\n- 다른 파티로 이동한 사이 멤버의 응답과 세션 종료가 겹치면, 원래 창에서 이후 대화가 멈춘 것처럼 보이던 문제를 수정했습니다.\n- 새 창을 열지 않아도 원래 파티로 돌아올 때 저장된 최신 대화를 자동으로 동기화합니다.\n\n## 설치\n\n- 자동 업데이트를 사용하려면 `AgentParty-Setup-0.7.1.exe`를 설치하세요.\n- `AgentParty-0.7.1.exe`는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.",
    "publishedAt": "2026-09-11T01:45:38Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.7.1",
    "prerelease": false
  },
  {
    "version": "0.7.0",
    "name": "v0.7.0",
    "notes": "코덱스 Fast(서빙 티어) 선택이 앱을 켜자마자 보입니다. 모델 정보를 창마다 따로 들고 있다가 부팅 타이밍에 따라 낡은 목록에 갇히던 문제를 고쳤습니다 — 계정 전용 모델과 Ultra 추론 강도도 첫 화면부터 나옵니다.\n\n파티 사이드바가 세 가지 좋아집니다.\n- 즐겨찾기: 파티를 즐겨찾기하면 맨 위 즐겨찾기 그룹에 함께 표시됩니다. 원래 그룹에서 빠지지 않습니다.\n- 접어둔 그룹이 앱을 껐다 켜도 그대로 유지됩니다.\n- 새 파티 만들 때 '새 창에서 생성'을 고르면 새 창에서 열리고, 보던 파티는 그대로 남습니다.\n\n그리고 main 멤버도 이제 삭제할 수 있습니다.",
    "publishedAt": "2026-09-10T16:04:12Z",
    "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.7.0",
    "prerelease": false
  }
];
