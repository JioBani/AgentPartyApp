# WSL 환경 점검 후 `spawn UNKNOWN`이 발생하는 문제

- 확인일: 2026-08-19
- 확인 버전: AgentParty `v0.2.4`
- 상태: 원인 범위 확인, 수정 미적용
- 대상: Windows 호스트에서 WSL 작업공간을 여는 경우

## 증상

사용자가 **설정 → 런타임 → 환경**에서 점검을 실행했지만, WSL 작업공간에서 멤버를 시작하면
`spawn UNKNOWN`이 표시됐다. 환경 점검을 통과한 것으로 보이는데 실제 멤버 프로세스는 시작되지
않아, 점검 결과와 실제 실행 결과가 일치하지 않는다.

## 확인된 진단 누락

현재 작업공간이 `wsl+Ubuntu-20.04:/...`인 경우 일반 환경 점검은 Windows 네이티브 Claude와
Codex 검증을 다음과 같이 건너뛴다.

- 작업공간: `skipped`
- 실행 파일: Windows에서 발견한 경로만 표시
- 버전, 로그인, 프로세스 실행 또는 app-server 초기화: `skipped`

별도의 **WSL 점검**도 현재는 다음 두 항목만 확인한다.

- 배포판 안의 Node.js 존재 여부와 버전
- AgentParty가 배포판에 복사한 Claude Agent SDK의 존재 여부와 패키지 버전

즉, WSL 점검은 다음 실제 실행 경로를 검증하지 않는다.

- 실제 WSL 작업공간을 자식 프로세스의 `cwd`로 사용할 수 있는지
- Agent SDK가 실제로 실행하는 Linux Claude 바이너리를 생성할 수 있는지
- WSL 안의 Claude 로그인 상태
- WSL 안의 Codex 실행 파일, 로그인 상태
- 실제 멤버와 같은 환경에서 Codex `app-server`가 `initialize`에 응답하는지

따라서 현재 구현에서는 WSL 실행 문제가 있어도 점검 화면에서 사전에 잡히지 않을 수 있다.

관련 코드:

- `src/main/environmentService.ts`
  - 네이티브 `claudeCheck`, `codexCheck`는 WSL 작업공간에서 실행 검증을 건너뜀
  - `wslDistroChecks`는 Node.js와 SDK 패키지 버전만 확인
- `src/main/engine/transport/wslEngine.ts`
  - 실제 멤버는 배포판 안에서 별도 엔진 서버로 실행됨
- `src/core/codexAdapter.ts`
  - 실제 Codex 멤버는 `CODEX_SQLITE_HOME`을 지정하고 `codex app-server`를 실행

## 현 장비에서 확인한 값

작업공간:

```text
wsl+Ubuntu-20.04:/home/.../sellmate-dockerize
```

WSL 기본 도구:

```text
Node.js: v20.20.1
Claude Code(PATH): 2.1.235
Codex: codex-cli 0.147.0
```

두 CLI 모두 WSL 안에서 로그인 상태였다. AgentParty가 배포판에 설치한 실제 Claude SDK 바이너리도
직접 실행과 로그인 확인에 성공했다.

```text
~/.agent_party_app/server/node_modules/@anthropic-ai/
  claude-agent-sdk-linux-x64/claude
Claude Code: 2.1.201
```

SDK 패키지 버전은 배포판에 `0.3.201`, 앱에는 `0.3.191`이 설치되어 있어 버전 차이 경고가
발생했다. 이 차이가 `spawn UNKNOWN`의 직접 원인이라는 증거는 아직 없다.

## Codex에서 추가로 확인된 동작 차이

동일한 WSL 작업공간에서 기본 환경의 `codex app-server`에 `initialize`를 보내면 응답이 왔다.
그러나 AgentParty 멤버가 사용하는 실행 조건을 더 가깝게 재현하기 위해 비어 있는 별도
`CODEX_SQLITE_HOME`을 지정하면 제한 시간 안에 초기화 응답이 오지 않고 `timeout` 종료 코드
`124`가 발생했다.

이 결과는 다음 중 하나일 수 있어 추가 분리가 필요하다.

1. 새 SQLite home의 최초 마이그레이션 또는 기존 세션 backfill 시간이 현재 제한 시간을 넘음
2. Codex `0.147.0`과 새 SQLite home 조합의 app-server 초기화 문제
3. 여러 app-server가 동시에 실행될 때의 상태 저장소 경합
4. AgentParty의 멤버별 SQLite 격리 경로 또는 초기화 제한 시간 문제

`CODEX_SQLITE_HOME` 자체는 Codex가 공식적으로 지원하는 SQLite 저장소 위치 재정의 값이다.
그러므로 변수를 제거하는 임시 우회 대신 최초 생성 시간, 안정된 재사용 경로, 동시 실행을 각각
측정해야 한다.

또한 WSL에 `bubblewrap`이 없어 Codex가 경고를 출력했지만, Codex는 번들된 bubblewrap을
사용한다고 명시했고 기본 환경의 app-server 초기화도 성공했다. 현재 증거만으로는 이 경고를
직접 원인으로 볼 수 없다.

## 이번 확인의 한계

- 사용자가 처음 본 `spawn UNKNOWN`이 기록된 다른 컴퓨터의 원본 로그는 확보하지 못했다.
- 현 장비에는 같은 WSL 작업공간을 소유한 다른 AgentParty 프로세스가 이미 실행 중이었다.
- 격리 QA 프로세스에서는 기존 멤버 시작이 다른 프로세스 소유권 때문에 거절되어, 최초 오류와
  동일한 세션 시작 경로를 그대로 재현하지 못했다.
- 따라서 확정된 것은 **WSL 진단이 실제 실행을 검증하지 않는 구조적 누락**이며,
  `CODEX_SQLITE_HOME` 동작은 강한 후속 조사 대상이다.

## 수정 요구사항

1. WSL 점검은 현재 창의 실제 distro와 POSIX 작업공간 경로를 사용해야 한다.
2. Claude는 AgentParty 엔진이 실제 사용하는 SDK Linux 바이너리로 다음 단계를 검사해야 한다.
   - 작업공간 접근
   - 실행 파일
   - 버전
   - 프로세스 생성
   - 로그인
3. Codex는 실제 멤버와 같은 실행 조건으로 검사해야 한다.
   - WSL 안에서 해석된 Codex 경로
   - 실제 작업공간 `cwd`
   - 로그인 상태
   - `CODEX_HOME`, `CODEX_SQLITE_HOME`, 추가 인자
   - `app-server initialize` 프로토콜 응답
4. `spawn`, `timeout`, 비정상 종료, 프로토콜 오류를 서로 다른 단계와 원문으로 표시해야 한다.
5. 진단용 SQLite 경로는 실제 멤버와 경합하지 않아야 하며, 매번 새 경로를 만들어 최초 backfill을
   반복해서도 안 된다.
6. WSL 점검 결과가 없는 일반 `다시 점검`은 성공처럼 보이지 않도록, 실제 실행 검증이
   `skipped`임을 상단 요약에서도 분명히 표시해야 한다.

## 필요한 검증

- 실제 AgentParty Electron 프로세스 실행
- `GET /api/environment?refresh=1&wsl=1`에서 Claude/Codex 단계 확인
- 설정 화면의 WSL 점검에서 같은 단계와 실패 원문 확인
- 실제 WSL 작업공간에서 Claude 멤버와 Codex 멤버 각각 시작
- Codex SQLite home을 최초 생성, 재사용, 동시 app-server 실행으로 나누어 시간과 결과 측정
- 오류를 강제로 만들었을 때 `spawn UNKNOWN` 한 줄이 아니라 command, cwd, 단계, OS/CLI 원문 표시

이번 커밋에는 조사 문서만 포함하며, 검증이 끝나지 않은 진단 코드 변경은 포함하지 않는다.
