# 릴리스 / 자동 업데이트

Windows `.exe` 배포와 앱 내 자동 업데이트를 어떻게 내보내고, 어떻게 검증하는지.

## 구조

| 무엇 | 어디 |
| --- | --- |
| 피드 주소(공개 저장소) | `src/shared/appUpdate.ts` 의 `UPDATE_FEED` — **정본** |
| 패키징/퍼블리시 설정 | `package.json` 의 `build.publish` (위 값과 반드시 일치) |
| 업데이트 상태 머신 | `src/main/updateService.ts` |
| 앱 API | `GET /api/update`, `POST /api/update/{check,download,install}` (docs/API.md) |
| UI | 타이틀바 `src/renderer/workbench/UpdatePill.tsx` + `UpdateModal.tsx`, 설정 → 버전 탭(`VersionsCard`) |
| QA 주입 | `POST /api/qa/update` |

소스 저장소(`JioBani/AgentPartyApp`)는 비공개로 두고, **릴리스만** 공개 저장소
`JioBani/AgentParty-releases` 로 올린다. 공개 저장소여야 `latest.yml` 과 설치본을
토큰 없이 받을 수 있고, 그래서 앱에 어떤 토큰도 넣지 않는다. 비공개 릴리스로
바꾸면 앱에 토큰을 심어야 하는데, 그건 사실상 토큰 유출이므로 하지 않는다.

## 릴리스 절차

1. 변경 범위에 맞춰 `package.json` 의 SemVer `version` 을 올린다. 작은 버그 수정,
   성능 개선, 내부 리팩터링처럼 기존 동작과 호환되는 변경은 세 번째 자리인 patch를
   올린다(`0.2.5` → `0.2.6`). 호환되는 새 기능은 minor, 호환성을 깨는 변경은
   major를 올린다. 이 값이 곧 릴리스 태그(`v0.2.6`)가 된다.
2. 릴리스용 GitHub 토큰을 환경변수로 준다 — 공개 저장소에 릴리스를 만들 권한만
   있으면 된다.
   ```powershell
   $env:GH_TOKEN = "<token>"
   ```
3. 빌드 + 업로드:
   ```powershell
   npm run release:win
   ```
   `release/` 에 `AgentParty Setup <version>.exe`(NSIS), 포터블 exe,
   `latest.yml`, `.blockmap` 이 생기고 그대로 릴리스에 업로드된다.
   업로드 없이 만들어만 보려면 `npm run dist:win`.
4. GitHub 릴리스는 **draft** 로 올라간다. 본문(변경 사항)을 적고 **publish** 해야
   앱들이 그 버전을 보기 시작한다. 본문 마크다운이 앱의 업데이트 대화상자와
   설정 → **버전** 탭에 그대로 렌더링되므로, 사용자에게 보여줄 문장으로 쓴다.
   버전 탭은 과거 릴리스 본문도 그대로 보여주므로, 나중에 본문을 고치면 앱에서도
   고쳐진 내용이 보인다.

   Windows PowerShell 5.1에서 GitHub API로 한글 본문을 직접 올릴 때 JSON 문자열을
   `Invoke-RestMethod -Body`에 그대로 넘기면 한글이 `?`로 손실될 수 있다. 반드시
   JSON을 UTF-8 바이트로 인코딩하고 `application/json; charset=utf-8`을 지정한 뒤,
   공개 API에서 본문을 다시 읽어 검증한다. 명령 예시는
   [릴리스 체크리스트](./RELEASE_CHECKLIST.md#powershell에서-한글-릴리스-본문-올리기)를
   따른다.

   ⚠️ 빈 저장소에는 태그를 만들 수 없어 게시가 422(`Repository is empty`)로
   거부된다. 릴리스 저장소에 커밋이 최소 하나는 있어야 한다.

`latest.yml` 과 `.blockmap` 은 반드시 함께 올라가야 한다. `latest.yml` 이 없으면
앱의 업데이트 확인은 실패로 표시되고(조용히 "최신"이라고 하지 않는다), 블록맵이
없으면 차등 다운로드가 통째 다운로드로 떨어진다.

### 베타 채널 배포

베타는 `0.3.0-beta.1` 같은 SemVer prerelease 버전과 동일한 `v` 태그를 사용하고,
GitHub 릴리스를 **prerelease**로 게시한다. 패키징 결과의 `beta.yml`, 설치본,
blockmap을 함께 올린다. `beta.yml`을 `latest.yml`로 바꾸면 안정 채널 사용자에게
베타가 노출될 수 있으므로 이름을 바꾸지 않는다. 공개 후 익명 다운로드 URL에서
`beta.yml`과 설치본이 모두 HTTP 200인지 확인한다.

베타 채널은 prerelease뿐 아니라 그보다 최신인 정식 릴리스도 받는다. 안정 채널은
`latest.yml`만 사용하며 prerelease를 받지 않는다.

## 사용자 쪽 동작

- 앱 시작 직후 한 번, 이후 6시간마다 확인한다(`updateService.ts`). 설정 화면을
  열 때마다 백그라운드에서 한 번 더 확인한다 — 이미 떠 있는 배지를 숨기지 않고,
  방금 끝난 확인은 다시 치지 않는다.
- 새 버전이 있으면 타이틀바에 파란 배지가 뜨고 토스트가 한 번 뜬다. 같은 버전을
  다시 알리지는 않는다. 배지는 `available` / `downloading` / `downloaded` 일 때만
  보인다 (`hasActionableUpdate`). 최신 상태, 확인 중, 오류, 개발/포터블 빌드에서는
  배지가 없다.
- 다운로드는 **자동으로 시작하지 않는다.** 사용자가 "새 버전 다운로드"를 눌러야
  받는다.
- 다 받으면 배지가 초록 "재시작하여 설치"로 바뀐다. 설치는 앱을 종료하므로 —
  실행 중인 멤버가 전부 끊긴다 — 대화상자에서 한 번 더 확인을 받는다.
- **설치는 사용자가 누를 때만 일어난다.** 받아두고 안 누르면 계속 대기하며,
  앱을 닫아도 설치되지 않는다 (`autoInstallOnAppQuit = false`). 이 앱에서 종료는
  실행 중인 멤버가 전부 끊긴다는 뜻이라, 무심코 지나칠 만한 순간이 아니다.

## 문제 릴리스 회수(롤백)

치명적인 문제가 있는 릴리스가 나갔을 때, **이미 설치한 사용자까지 되돌리는**
방법이다.

1. GitHub에서 문제 릴리스를 **draft로 되돌리거나 삭제**한다.
2. `latest.yml` 이 자동으로 직전 정상 릴리스를 가리키게 된다.
3. 각 앱이 다음 확인(시작 직후 또는 6시간 주기) 때 그 버전을 발견하고,
   **되돌리기**를 제안한다.

`autoUpdater.allowDowngrade = true` 라서 가능한 동작이다. 이게 없으면 릴리스를
내려도 이미 설치한 사용자는 그대로 남는다.

앱은 이 경우를 **업그레이드와 다르게** 표시한다 — 배지는 주황색 "되돌리기 x.y.z",
버튼은 "이전 버전 받기", 대화상자에는 데이터가 되돌아가지 않는다는 경고가 붙는다.
롤백을 "새 버전"이라고 안내하면 사용자가 반대로 이해한 채 설치하기 때문이다.

⚠️ **데이터는 되돌아가지 않는다.** 새 버전이 설정이나 파티 저장 형식을 바꿨다면,
옛 빌드가 그것을 읽지 못할 수 있다. 포맷을 바꾸는 변경을 낼 때는 이 점을 감안한다.

앱이 아예 실행되지 않는 수준이라면 자동 회수도 닿지 않는다. 그때는 사용자가
릴리스 페이지에서 옛 설치본을 직접 받아 실행해야 하며, 그 안내는 릴리스 저장소의
README에 있다.

### 자동 업데이트가 불가능한 경우

`state: "disabled"` 로 이유와 함께 표시된다. 조용히 실패하지 않는다.

- **개발 실행**(`npm start`, 패키징되지 않은 빌드) — 자기 자신을 교체할 대상이 없다.
- **포터블 exe** — 설치 경로가 없어 NSIS 업데이터가 동작하지 않는다. 자동 업데이트가
  필요하면 `Setup.exe` 로 설치해서 쓴다.

## 코드 서명

현재 서명하지 않는다. 서명 없는 설치본은 Windows SmartScreen 경고를 띄우며,
이는 첫 설치와 업데이트 설치 모두에 해당한다. 자동 업데이트 자체는 서명 없이도
동작한다(electron-updater 는 `publisherName` 을 설정했을 때만 서명을 검증한다).
경고를 없애려면 코드 서명 인증서를 사서 `build.win.certificateFile` 등을 설정해야
한다.

## QA — 릴리스 없이 UI 검증하기

개발 실행은 실제로 업데이트할 수 없으므로, 상태를 주입해서 화면을 본다.

```powershell
# 앱을 QA 모드로 띄운 뒤(자동화 포트는 <workspace>/.agent_party_app/instances/*.json)
curl -s $B/api/qa/update -X POST -H 'content-type: application/json' `
  -d '{"state":"available","latestVersion":"0.2.0","releaseNotes":"- 첫 자동 업데이트\n"}'
curl -s $B/api/capture -X POST -H 'content-type: application/json' `
  -d '{"path":"shot.png","click":".wb-update-pill"}'
```

`state` 를 `downloading`(+`progress`) → `downloaded` 로 바꿔가며 배지/진행률/설치
버튼을 확인하고, 끝나면 `{"reset":true}` 로 실제 업데이터를 되돌린다.

실제 피드 연결은 공개 저장소에 릴리스가 하나 올라간 뒤 **패키징된 빌드**로만
검증할 수 있다: 낮은 버전으로 설치한 뒤 앱을 띄우고 배지가 뜨는지 본다.
