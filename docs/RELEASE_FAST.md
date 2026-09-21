# 빠른 공개 릴리스

이 문서는 검증이 끝난 변경을 Windows 공개 릴리스로 내보내는 최단 경로다. 자동
업데이트 구조와 복구 절차는 [RELEASE.md](./RELEASE.md), 상세 체크리스트는
[RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)를 참고한다.

## 먼저 사람이 판단할 두 가지

자동화 전에 다음 두 항목만 판단한다.

1. 기존 사용자의 저장 데이터, 설정, 세션, 연동에 업데이트 호환성 문제가 없는가?
2. 마이그레이션이 필요한가? 필요하다면 범위와 위험을 설명하고 사용자에게 명시적
   승인을 받았는가?

변경 영역의 집중 QA도 병합 전에 끝낸다. 이 판단과 동작 QA는 린트로 대신할 수 없다.
나머지 버전·브랜치·산출물·해시·업로드 검사는 스크립트가 수행한다.

## 권장 절차

릴리스 전용 worktree에서 버전을 올리고 의존성을 한 번 설치한다.

```powershell
git -C C:\Project\AgentPartyApp worktree add `
  C:\Project\AgentPartyApp-wt-release-v<version> `
  -b release/v<version> master

Set-Location C:\Project\AgentPartyApp-wt-release-v<version>
npm version <version> --no-git-tag-version
npm ci
```

빌드, Windows 패키징, 실제 패키지 E2E, 산출물 린트를 한 번에 실행한다.

```powershell
npm run release:prepare
```

성공하면 버전 커밋과 태그를 원격 소스에 fast-forward로 올린다.

```powershell
git add package.json package-lock.json
git commit -m "release: v<version>"
git fetch origin master
git merge-base --is-ancestor origin/master HEAD
if ($LASTEXITCODE -ne 0) { throw "origin/master를 fast-forward할 수 없습니다." }

git tag -a v<version> -m "AgentParty v<version>"
git push origin HEAD:master
git push origin v<version>
```

검증한 기존 산출물을 그대로 업로드한다. 이 단계는 빌드하거나 패키징하지 않는다.

```powershell
node scripts/release-publish.mjs --publish-existing --notes "사용자에게 보여줄 변경 사항"
```

스크립트가 draft 생성, 네 자산 업로드, 원격 크기와 UTF-8 본문 확인, 공개 전환,
비로그인 다운로드 HTTP 확인까지 수행한다. 출력된 릴리스 URL을 보고한 뒤 worktree를
정리한다.

## 무엇이 빨라졌나

이전 가이드는 상황에 따라 같은 작업을 반복했다.

- 별도 `npm run build` 뒤 `package:win`이 다시 전체 빌드했다.
- `release-publish --skip-build`도 이름과 달리 electron-builder 패키징을 다시 했다.
- 버전, 네 자산, `latest.yml`, SHA-512, 원격 크기, 공개 URL을 에이전트가 여러 명령으로
  재확인했다.

새 경로는 `release:prepare`에서 **빌드 1회·패키징 1회**만 수행한다. 패키징 시
`release/release-manifest.json`에 추적 파일 전체의 source fingerprint와 산출물
크기·SHA-256을 기록한다. `--publish-existing`은 게시 직전에 다음을 자동으로 다시
검사하므로, 안전을 위해 재패키징할 필요가 없다.

- `package.json`과 lockfile 버전 일치
- 정확한 release 브랜치, GitHub 대상, NSIS/portable 설정
- 설치본, 포터블, blockmap, 채널 feed 네 파일 존재
- feed의 버전·설치본 경로·SHA-512 일치
- 현재 추적 소스와 패키징 당시 source fingerprint 일치
- 릴리스 태그, `HEAD`, `origin/master` 일치
- draft 자산 이름·크기·상태와 UTF-8 릴리스 본문 일치
- 공개 후 네 자산의 비로그인 HTTP 응답

`--skip-build`는 호환성을 위해 남아 있지만 electron-builder를 다시 실행하는 레거시
옵션이다. 새 릴리스에서는 사용하지 않는다.

## 명령별 역할

- `npm run release:lint`: 패키징 전 버전, 브랜치, worktree, 배포 설정 검사
- `npm run package:win`: 빌드 1회, Windows 패키징 1회, release manifest 생성
- `npm run test:e2e:packaged-release`: 포터블 실행 파일을 실제로 기동해 버전과 환경 확인
- `npm run release:prepare`: 위 세 단계와 산출물 린트를 순서대로 실행
- `npm run release:publish -- --notes "..."`: 기존 산출물 게시. npm이 인자를 소비하는
  환경이 있으므로 실제 릴리스에서는 Node 명령 직접 호출을 권장
- `npm run catalog:publish`: 모델 카탈로그가 변경됐을 때만 별도로 게시

## 토큰

토큰은 공개 릴리스 저장소 `C:\Project\AgentParty-releases\.env`에만 둔다.

```text
GITHUB=<JioBani/AgentParty-releases 릴리스 권한 토큰>
```

다른 경로를 사용하려면 `AGENTPARTY_RELEASE_ENV`를 지정한다. 스크립트는 토큰 값을
출력하지 않는다.

## 시간 해석

깨끗한 worktree의 첫 `npm ci`와 electron-builder 도구 다운로드 시간은 네트워크와
캐시에 따라 달라진다. 그 뒤의 정상 경로에서 오래 걸리는 단계는 한 번의 프로덕션
빌드, 한 번의 Windows 패키징, 약 200MB 자산 업로드뿐이다. 같은 빌드나 패키징이 두
번 보이면 권장 경로를 벗어난 것이다.

패키징을 강제 중단했다면 남은 electron-builder 프로세스가 끝나기 전에 다시 실행하지
않는다. 같은 `release/`를 두 프로세스가 동시에 쓰면 부분 산출물이 섞일 수 있다.
