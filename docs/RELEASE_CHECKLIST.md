# AgentParty 릴리스 체크리스트

Windows 배포본을 준비하고 `JioBani/AgentParty-releases`에 공개할 때 사용하는 실전 절차다.
자동 업데이트의 구조와 사용자 동작은 [RELEASE.md](./RELEASE.md)를 참고한다.

## 릴리스 원칙

- 소스는 비공개 `JioBani/AgentPartyApp`, 설치 파일은 공개
  `JioBani/AgentParty-releases`에 둔다.
- 소스 저장소와 릴리스 저장소의 태그는 모두 `v<version>` 형식을 사용한다.
- 설치본을 실제로 실행해 확인하기 전에는 공개하지 않는다.
- 릴리스는 먼저 draft로 만들고, 모든 자산을 검증한 뒤 publish한다.
- 기존 `master` 체크아웃을 직접 수정하지 않는다. 릴리스 전용 worktree와 브랜치를 사용한다.
- 토큰은 파일, 명령 출력, 릴리스 본문에 남기지 않는다.
- 매 업데이트마다 기존 사용자의 저장 데이터, 설정, 세션, 연동 호환성을 검토한다.
- 마이그레이션이 필요하면 범위와 위험을 설명하고 사용자에게 명시적 승인을 받은 뒤 진행한다.

### 버전 선택

SemVer는 `MAJOR.MINOR.PATCH` 순서다. 즉 첫 번째 자리는 major, 두 번째 자리는
minor, 세 번째 자리는 patch다. 변경 범위를 먼저 분류한 뒤 버전을 정하며,
릴리스를 만든다는 이유만으로 두 번째 자리(minor)를 올리지 않는다.

- 기존 사용자 동작과 호환되는 작은 버그 수정, 성능 개선, 내부 리팩터링은 세 번째
  자리인 **patch**를 올린다. 예: `0.2.5` → `0.2.6`.
- 호환성을 유지하면서 사용자 기능을 추가하면 두 번째 자리인 **minor**를 올리고
  patch는 `0`으로 되돌린다. 예: `0.2.6` → `0.3.0`.
- API, 저장 데이터, 사용자 동작의 호환성을 깨는 변경은 첫 번째 자리인 **major**를
  올린다. `0.x` 개발 단계에서도 호환성 영향은 릴리스 본문에 명시한다.
- 베타/RC는 선택한 정식 버전에 prerelease 식별자를 붙인다. 예: `0.3.0-beta.1`.

### 베타 채널 릴리스

- 버전과 태그는 `0.3.0-beta.1`, `v0.3.0-beta.1` 같은 SemVer prerelease 형식이다.
- GitHub 릴리스는 draft 검증 후 **prerelease**로 공개한다.
- 생성된 `beta.yml`, 설치본, blockmap을 함께 올리고 `latest.yml`로 바꾸지 않는다.
- 공개 후 `beta.yml`과 설치본의 익명 다운로드가 HTTP 200인지 확인한다.
- 안정 채널에는 prerelease가 보이지 않고, 베타 채널에는 이후 더 최신인 정식
  릴리스도 보이는지 채널별로 확인한다.

## 1. 사전 확인

두 저장소가 최신이고 예상하지 않은 변경이 없는지 확인한다.

```powershell
git -C C:\Project\AgentPartyApp status --short --branch
git -C C:\Project\AgentParty-releases status --short --branch
git -C C:\Project\AgentPartyApp fetch origin
git -C C:\Project\AgentParty-releases fetch origin --tags
```

작업 중인 사용자 파일이 있으면 건드리지 않는다. 충돌 가능성이 있으면 깨끗한 통합
worktree를 별도로 만든다.

릴리스할 변경이 `master`에 들어갔는지와 직전 버전 이후 커밋을 확인한다.

```powershell
git -C C:\Project\AgentPartyApp log --oneline --decorate -10
git -C C:\Project\AgentPartyApp log --oneline v<previous>..master
```

## 2. 릴리스 worktree와 버전 준비

```powershell
git -C C:\Project\AgentPartyApp worktree add `
  C:\Project\AgentPartyApp-wt-release-v<version> `
  -b release/v<version> master

Set-Location C:\Project\AgentPartyApp-wt-release-v<version>
npm version <version> --no-git-tag-version
npm ci
```

`npm version` 실행 후 `package.json`과 루트 `package-lock.json`의 버전이 모두 같은지
확인한다. 의존성 감사 결과에 새 critical 취약점이 있으면 내용을 확인하고, 위험을
평가하기 전에는 릴리스를 계속하지 않는다.

## 3. 변경 QA와 단일 패키징

변경 영역의 집중 테스트는 병합 전에 실행한다. 인증 영역을 변경한
경우의 예시는 다음과 같다.

```powershell
npm run test:subscription-auth
npm run test:subscription-disconnect-ui
npm run test:subscription-auth-url
```

릴리스 worktree에서는 준비 파이프라인을 한 번 실행한다.

```powershell
npm run release:prepare
```

이 명령은 소스 린트 → 전체 빌드 1회 → `electron-builder --win --x64` 패키징 1회 →
실제 패키지 E2E → 산출물 린트를 순서대로 실행한다. 별도 `npm run build`나 두 번째
`electron-builder`를 실행하지 않는다. 패키징 시 현재 추적 소스 fingerprint와 네
산출물의 크기·SHA-256을 `release/release-manifest.json`에 기록한다.

`release/`에 다음 파일이 생겼는지 확인한다.

| 로컬 파일 | 공개 릴리스 자산 이름 | 용도 |
| --- | --- | --- |
| `AgentParty Setup <version>.exe` | `AgentParty-Setup-<version>.exe` | NSIS 설치본, 자동 업데이트 지원 |
| `AgentParty Setup <version>.exe.blockmap` | `AgentParty-Setup-<version>.exe.blockmap` | 차등 다운로드 |
| `AgentParty <version>.exe` | `AgentParty-<version>.exe` | 포터블 실행본, 자동 업데이트 미지원 |
| `latest.yml` | `latest.yml` | 최신 버전과 설치본 해시 메타데이터 |

`release:prepare` 안의 패키지 E2E는 실제 포터블 실행 파일의 버전, 격리된 작업공간,
Windows 네이티브 인증 호스트, 환경 진단 host/cwd와 화면 캡처를 확인한다. 산출물
린트는 `latest.yml`의 버전, 설치본 URL, SHA-512와 source fingerprint를 확인한다.

## 4. 실제 배포본 QA

개발 서버나 모듈 테스트만으로 완료 처리하지 않는다. `release/AgentParty <version>.exe`
또는 설치된 앱을 실제로 실행하고 사용자 화면을 확인한다.

최소 확인 항목:

- 앱이 오류 없이 시작된다.
- 이번 변경의 사용자 화면과 핵심 동작이 의도대로 보인다.
- 로컬 자동화 API의 `/api/state`로 동일한 상태를 확인할 수 있다.
- 실행 파일의 `FileVersion`과 `ProductVersion`이 `<version>`이다.
- QA가 끝나면 실행한 앱 프로세스를 정상 종료한다.

자동 업데이트 자체를 검증할 때는 이전 설치 버전에서 새 공개 릴리스를 탐지하고,
다운로드 후 재시작 설치까지 실제 사용자 흐름으로 확인한다.

## 5. 소스 병합과 태그

테스트와 실제 배포본 QA가 모두 통과한 뒤 버전 변경을 커밋한다.

```powershell
git add package.json package-lock.json
git commit -m "release: v<version>"
```

릴리스 worktree에서 원격 `master`가 현재 커밋의 조상인지 확인한다. 통과하면 현재
커밋을 원격 `master`로 fast-forward하고 태그를 푸시한다. 이 방식은 사용자 변경이
남아 있는 기존 `master` worktree를 건드리지 않는다.

```powershell
git fetch origin master
git merge-base --is-ancestor origin/master HEAD
if ($LASTEXITCODE -ne 0) { throw "origin/master를 fast-forward할 수 없습니다." }

git tag -a v<version> -m "AgentParty v<version>"
git push origin HEAD:master
git push origin v<version>
```

조상 확인이 실패하거나 push가 거부되면 억지로 병합하지 않는다. 원격 변경을 확인하고
릴리스 브랜치를 최신 `master` 위에 정리한 뒤 테스트와 패키징 QA를 다시 수행한다.
기존 `master` worktree는 사용자 변경과 충돌하지 않는 것이 확인된 뒤 별도로
`git merge --ff-only origin/master`로 동기화한다.

## 6. 검증한 산출물 공개하기

배포 스크립트는 3단계에서 검증한 산출물을 그대로 업로드한다. 업로드 권한 토큰은
`C:\Project\AgentParty-releases\.env`에서 읽으며 출력하지 않는다.

```powershell
node scripts/release-publish.mjs --publish-existing --notes "사용자에게 보여줄 변경 사항"
```

이 명령은 빌드하거나 패키징하지 않는다. 게시 직전에 release manifest, 현재 source
fingerprint, 태그, `HEAD`, `origin/master`가 모두 일치하는지 확인한다. 이후 draft를
만들어 네 자산을 업로드하고, 원격 크기와 UTF-8 본문이 일치할 때만 공개한다.

`--skip-build`는 호환성을 위해 남은 레거시 옵션이며 빌드는 생략해도 패키징은 다시
수행한다. 새 절차에서는 사용하지 않는다.

릴리스 본문은 앱 안에서도 사용자에게 표시되므로 구현 상세보다 사용자 변화를 적는다.

```markdown
## 변경 사항

- 사용자가 체감하는 변경 사항
- 오류 수정 또는 동작 개선

## 설치

- 자동 업데이트를 사용하려면 `AgentParty-Setup-<version>.exe`를 설치하세요.
- `AgentParty-<version>.exe`는 포터블 버전이며 자동 업데이트를 지원하지 않습니다.
```

### PowerShell에서 한글 릴리스 본문 올리기

Windows PowerShell 5.1의 `Invoke-RestMethod`에 JSON **문자열**을 `-Body`로 바로
넘기면, 요청 본문이 UTF-8이 아닌 인코딩으로 전송되어 한글이 GitHub에 도착하기 전에
`?`로 치환될 수 있다. `-ContentType application/json`만 지정하는 것으로는 충분하지
않다. JSON을 명시적으로 UTF-8 바이트로 바꾸고 charset도 함께 선언한다.

```powershell
$payload = @{
  name = "AgentParty v<version>"
  body = $releaseNotes
  draft = $true
  prerelease = $false
} | ConvertTo-Json

$utf8Body = [Text.Encoding]::UTF8.GetBytes($payload)
Invoke-RestMethod `
  -Uri "https://api.github.com/repos/JioBani/AgentParty-releases/releases/<release-id>" `
  -Headers $headers `
  -Method Patch `
  -ContentType "application/json; charset=utf-8" `
  -Body $utf8Body
```

본문을 올린 직후 GitHub API에서 다시 읽어 업로드 전 원문과 일치하는지 확인한다.
줄바꿈 형식만 정규화하고 본문 문자는 그대로 비교한다. 이 검증이 실패하면
publish하지 않는다.

```powershell
$saved = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/JioBani/AgentParty-releases/releases/tags/v<version>" `
  -Headers @{ "User-Agent" = "AgentParty-Release-Verify" }

$expectedBody = ($releaseNotes -replace "`r`n", "`n").TrimEnd()
$actualBody = ([string]$saved.body -replace "`r`n", "`n").TrimEnd()
if ($actualBody -cne $expectedBody) {
  throw "GitHub release body differs from the UTF-8 source"
}
```

다음 draft 검증은 `release-publish.mjs`가 결정론적으로 수행한다.

- 태그와 릴리스 제목이 정확하다.
- 네 자산이 모두 `uploaded` 상태다.
- 원격 자산 크기가 로컬 파일 크기와 같다.
- 다운로드한 `latest.yml`이 `<version>`과
  `AgentParty-Setup-<version>.exe`를 가리킨다.
- 릴리스 본문에 내부 경로, 토큰, 개발자 전용 정보가 없다.
- GitHub API에서 다시 읽은 본문이 업로드 전 UTF-8 원문과 일치한다.

검증을 모두 통과한 경우에만 스크립트가 publish한다. 에이전트가 동일 항목을 별도
명령으로 재확인하지 않는다.

## 7. 공개 후 확인

게시 스크립트가 인증 헤더 없이 네 공개 자산에 HEAD 요청을 보내 HTTP 응답을 확인한다.

완료 조건:

- 최신 공개 릴리스가 `v<version>`이다.
- draft와 prerelease가 모두 `false`다.
- 설치본, 포터블, blockmap, `latest.yml` 네 자산이 공개 다운로드된다.
- 공개 `latest.yml`의 버전과 설치본 URL이 정확하다. 이 내용은 업로드 전 린트한 동일
  파일이며 source fingerprint로 패키징 이후 변경되지 않았음을 보장한다.
- 릴리스 저장소에서 `git fetch --tags` 후 `v<version>` 태그가 보인다.

릴리스 URL과 검증 결과를 작업 보고에 남긴다. 그 뒤에만 릴리스 worktree를 정리한다.

## 실패 시 중단 기준

다음 중 하나라도 해당하면 publish하지 않고 draft 상태에서 원인을 해결한다.

- 테스트, 타입 검사, 빌드 또는 실제 앱 실행이 실패했다.
- 실행 파일 버전이 릴리스 버전과 다르다.
- 자산이 빠졌거나 크기가 다르다.
- `latest.yml`이 없거나 다른 버전/설치본을 가리킨다.
- 변경 사항을 실제 배포본에서 재현하지 못했다.
- 원격 `master` 또는 동일 버전 태그가 예상과 다르다.

이미 공개한 뒤 치명적 문제를 발견했다면 임의로 같은 버전 파일을 교체하지 않는다.
[RELEASE.md의 문제 릴리스 회수 절차](./RELEASE.md#문제-릴리스-회수롤백)에 따라 릴리스를
회수하고, 수정 버전은 새 버전 번호로 다시 배포한다.
