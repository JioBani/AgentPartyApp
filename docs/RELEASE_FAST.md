# 빠른 공개 릴리스 (5분)

`docs/RELEASE.md`가 릴리스의 정본 설명이라면, 이 문서는 **이미 검증이 끝난 master를
공개 릴리스로 내보내는 최단 경로**다. 토큰을 매번 손으로 넣고, 드래프트를 웹에서
찾아 본문을 붙이고, 다운로드 링크를 눌러보는 세 가지 수작업을 없앤다.

## 한 줄 요약

```powershell
node scripts/release-publish.mjs --notes "이번 릴리스에서 바뀐 것"
```

빌드 → 패키징 → 공개 저장소 업로드 → 릴리스 게시 → 익명 다운로드 확인까지 끝난다.
방금 `npm run build`를 돌렸다면 `--skip-build`를 붙여 빌드를 건너뛴다.

`npm run release:publish -- ...`는 npm/PowerShell 버전에 따라 `--notes`와
`--skip-build`를 npm 설정 옵션으로 소비할 수 있다. 그러면 본문이 기본값으로
게시되거나 검증 빌드가 다시 실행된다. 릴리스에서는 위처럼 Node 스크립트를 직접
호출하고, 시작 로그에 전달한 옵션이 그대로 보이는지 확인한다.

## 토큰은 어디에 있나

토큰은 **릴리스 저장소** `C:\Project\AgentParty-releases\.env` 한 곳에만 둔다.

```
GITHUB=<공개 저장소에 릴리스를 만들 권한만 있는 토큰>
```

- 이 파일은 그 저장소의 `.gitignore`에 `.env`, `.env.*`, `*.token`으로 이미 잡혀
  있다. **커밋되지 않는다.** 릴리스 저장소는 공개라서, 여기 토큰이 올라가면 즉시
  유출이다. 새 컴퓨터에서 릴리스할 때도 이 파일을 만들어 쓰고 절대 커밋하지 않는다.
- 소스 저장소(`AgentPartyApp`)에는 토큰을 두지 않는다. 앱 코드에도 넣지 않는다 —
  `docs/RELEASE.md`가 설명하듯 릴리스 저장소를 공개로 두는 이유가 바로 앱에 토큰을
  심지 않기 위해서다.
- 다른 경로에 두려면 `AGENTPARTY_RELEASE_ENV`로 파일 경로를 넘긴다.
- 토큰 값은 로그나 보고에 그대로 찍지 않는다. 스크립트도 값을 출력하지 않는다.

## 절차

1. **버전을 올린다.** `package.json`의 `version`. 호환되는 버그 수정은 patch,
   호환되는 새 기능은 minor, 호환성을 깨면 major. 이 값이 그대로 태그(`v0.5.0`)가
   된다. 커밋해 둔다.
2. **릴리스한다.**
   ```powershell
   node scripts/release-publish.mjs --notes "파티/멤버 UI 정리, 세션 시작 카드, ..."
   ```
   `--notes` 본문은 앱의 업데이트 대화상자와 설정 → **버전** 탭에 그대로 렌더링되므로,
   사용자에게 보여줄 문장으로 쓴다. 생략하면 `AgentParty <version>`만 들어간다.
3. **끝난다.** 스크립트가 마지막에 릴리스 주소, 자산별 HTTP 상태, 저장된 본문을
   출력한다. 전부 200이면 사용자 앱이 다음 확인 때(시작 직후 또는 6시간 주기)
   이 버전을 본다.

## 외부 release worktree 패키징 사전 점검

릴리스는 `C:\Users\Dev\AppData\Roaming\AgentParty\worktrees` 아래의 전용 외부
worktree에서 수행한다. 릴리스 checkout은 다른 checkout의 `node_modules`를 빌리거나
정션으로 공유하지 않고, 그 checkout 안에서 `npm ci`로 설치한 자체 의존성만 쓴다.

`@agentparty/protocol`은 선택적인 로컬 `file:` 의존성이다. 외부 worktree에서
`npm ci`를 실행하면 실제 대상이 없거나 프로젝트 밖에 있는 정션이
`node_modules\@agentparty\protocol`에 생길 수 있다. 일반 빌드는 모바일 연결을 뺀
구성으로 통과하지만, `electron-builder`의 `@electron/rebuild`는 `node_modules`의
모든 항목을 먼저 `stat`하므로 끊어진 정션에서 `ENOENT`로 중단된다.

`npm ci` 직후, 빌드나 패키징 전에 다음을 실행한다.

```powershell
Get-Item node_modules\@agentparty\protocol -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, LinkType, Target

node --input-type=module -e `
  "import('./scripts/mobile-pipe.mjs').then(m => console.log(m.pruneExternalPipeLinkForPackaging() ?? m.pruneBrokenPipeLink() ?? 'optional link 없음'))"
```

이 명령은 공식 패키징 헬퍼로 링크 자체만 제거하며 대상 디렉터리는 건드리지 않는다.
실행 뒤 해당 경로가 없어졌는지 확인한다. 실제 디렉터리로 복사된 패키지라면 임의로
삭제하지 않는다.

### 패키징 재시도 규칙

- `electron-builder`는 같은 release worktree에서 **한 프로세스만** 실행한다.
- 호출 측 타임아웃은 하위 `electron-builder` 종료를 보장하지 않는다. 타임아웃이나
  강제 중단 뒤에는 `electron-builder`, `node`, 해당 worktree 경로를 명령줄에 가진
  프로세스가 모두 끝났는지 확인하기 전 재실행하지 않는다.
- 첫 패키징에는 충분히 긴 타임아웃을 사용한다. 진행 중인 패키징 위에 두 번째
  패키징을 시작하지 않는다.
- 실패 후 `release\win-unpacked` 같은 부분 결과를 정리하거나 옮길 때도 먼저 관련
  프로세스가 없음을 확인한다. 두 프로세스가 같은 출력 경로를 쓰면 한쪽이
  `electron.exe`를 이동한 뒤 다른 쪽이 같은 파일을 찾지 못하는 rename `ENOENT`가
  발생할 수 있다.
- 재시도는 선택적 링크 정리, 프로세스 종료, 부분 결과 격리까지 끝난 뒤 깨끗한
  출력 경로에서 한 번만 수행한다.

## 스크립트가 대신 해주는 것

`scripts/release-publish.mjs`:

- 토큰을 `.env`에서 읽어 `GH_TOKEN`으로 넣는다 — 셸에 매번 export 하지 않는다.
- `electron-builder --win --x64 --publish always`로 NSIS 설치본, 포터블 exe,
  `latest.yml`, `.blockmap`을 만들어 업로드한다. 이 넷은 항상 함께 올라가야 한다.
  `latest.yml`이 없으면 앱의 업데이트 확인이 실패로 표시되고, 블록맵이 없으면
  차등 다운로드가 통째 다운로드로 떨어진다.
- 드래프트로 올라온 릴리스를 찾아 본문을 넣고 **게시(draft: false)** 한다. 본문은
  UTF-8 바이트로 보내고 `charset=utf-8`을 지정한다 — PowerShell에서 한글 본문을
  그냥 넘기면 `?`로 깨지기 때문이다.
- 버전이 `0.5.0-beta.1` 같은 prerelease면 자동으로 prerelease로 게시한다. 이때
  피드는 `beta.yml`이며, 이름을 `latest.yml`로 바꾸면 안정 채널 사용자에게 베타가
  나가므로 바꾸지 않는다.
- 게시 후 **익명(비로그인) 다운로드 URL**로 피드와 설치본을 실제로 받아 200인지
  확인한다. 하나라도 실패하면 에러로 멈춘다. "올렸는데 사용자는 못 받는" 상태를
  그냥 지나치지 않기 위해서다.

## 검증은 어디까지

이 경로는 **이미 검증이 끝난 master**를 전제로 한다. 릴리스 시점에 다시 도는 것은
`npm run build` 안에 포함된 테마 카탈로그 검증과 전체 타입 검사뿐이다.

QA는 릴리스 직전이 아니라 병합 시점에 끝내둔다. 병합 후 최소한 이만큼은 본다 —
전체 타입 검사, 프로덕션 빌드, 그리고 이번 변경이 건드린 영역의 QA 스크립트.
기존에 실패하던 검사가 있으면 병합 전후가 **같은지만** 확인하고, 새로 생긴 실패만
차단 사유로 본다.

## 안 되면

- `Repository is empty`(422) — 릴리스 저장소에 커밋이 하나도 없으면 태그를 만들 수
  없다. 아무 커밋이나 하나 올린 뒤 다시 시도한다.
- `릴리스 토큰 파일을 열 수 없습니다` — 위의 `.env`가 없거나 경로가 다르다.
- `GITHUB= 토큰 줄이 없습니다` — 키 이름은 `GITHUB`, `GH_TOKEN`, `GITHUB_TOKEN` 중
  아무거나 쓸 수 있다.
- `공개 다운로드 실패 … 404` — 업로드는 됐지만 자산 이름이 다르다. 릴리스 페이지에서
  실제 파일 이름을 확인한다. electron-builder는 공백을 하이픈으로 바꿔 올린다
  (`AgentParty Setup 0.5.0.exe` → `AgentParty-Setup-0.5.0.exe`).
- 잘못된 릴리스를 내보냈다면 회수 절차는 `docs/RELEASE.md`의 "문제 릴리스 회수"를
  따른다. 드래프트로 되돌리거나 지우면 각 앱이 직전 정상 버전으로 되돌리기를
  제안한다. **데이터는 되돌아가지 않는다.**

## 서명

지금은 서명하지 않는다. SmartScreen이 첫 설치와 업데이트 설치 모두에서 한 번
경고한다(추가 정보 → 실행). 자동 업데이트 자체는 서명 없이도 동작한다.
