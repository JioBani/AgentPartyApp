# desktop-pipe 핸드오프 (2026-08-17)

`desktop-pipe` 자리를 이어받는 멤버를 위한 문서. 결론보다 **경로·명령·재현법**을
남긴다. 판단이 필요한 곳은 왜 그렇게 됐는지도 적었다 — 근거를 모르면 되돌리기 쉽다.

이 문서가 단일 출처다. `desktop-pipe-state.md`는 여기를 가리키는 포인터로만 남겼다
(두 벌을 유지하면 반드시 어긋난다).

---

## 1. 담당 범위

`src/main/mobile/**` 전체와 그 QA 스크립트. 데스크톱 쪽 파이프만이며, **폰 파이프는
mobile-pipe, 앱 UI·핸들러는 desktop-app, 시그널링 서버는 server**가 담당한다.

| 파일 | 줄수 | 역할 |
|---|---:|---|
| `index.ts` | 109 | `createMobileGateway({implementation})` 팩토리 + 공개 타입 재수출 |
| `mobileGateway.ts` | 344 | **파이프 ⇄ 앱 경계**(07). `MobileGateway`, `RequestContext` 등 인터페이스 |
| `realMobileGateway.ts` | 910 | 제품용 구현. 설정·시그널링·페어링·세션·상태 조립 |
| `mockMobileGateway.ts` | 581 | UI 개발용 모의 구현. **인터페이스 동작은 real과 동일해야 함**(§7 참조) |
| `signalingClient.ts` | 597 | 01 §3 시그널링 WS 클라이언트. strict 수신, 주소 목록 폴백 |
| `webrtcTransport.ts` | 548 | `node-datachannel` 기반 WebRTC. ICE restart·백프레셔·복구 타이머 |
| `transport.ts` | 61 | 01 §6 전송 인터페이스. 상위 계층은 이것만 의존 |
| `secureSession.ts` | 126 | 01 §4 E2E 계층. 키 유도·AEAD·카운터·리플레이·치명적 갭 |
| `rpcServer.ts` | 453 | 01 §5 RPC. 봉투 처리, 예약 메서드, resume/snapshot, 청크 |
| `eventBridge.ts` | 209 | 01 §5.2–5.3 이벤트 팬아웃 + 되감기 링버퍼. **seq는 프로세스 전역** |
| `chunking.ts` | 126 | 01 §5.6 프레임 초과 봉투 분할·재조립 |
| `pairingService.ts` | 388 | 01 §2 페어링(QR·blob1~3·확인 코드) |
| `identityStore.ts` | 256 | Ed25519/X25519 시드 영속화. safeStorage 없으면 경고 |
| `pushClient.ts` | 161 | 01 §7 푸시 릴레이 호출 |
| `natMapper.ts` | 197 | 04 — 폰이 페어링된 동안 UDP 포트 매핑 유지 |
| `portMapping.ts` | 470 | UPnP IGD / NAT-PMP / PCP 직접 구현 |
| `stun.ts` | 192 | RFC 5389 최소 STUN. 반사 주소·NAT 매핑 재사용 여부 |
| `diagnostics.ts` | 243 | 04 — 직접 연결이 될지/안 될지와 그 이유 |
| `valueStream.ts` | 56 | 상태 스트림. 쓰기 측은 파이프 내부에만 노출 |

### 이 디렉터리의 규칙 (06 문서)

- **플랫폼 분기 금지, OS 명령 실행 금지, Windows 전용 환경변수 금지.**
  `test:mobile-portability`가 이걸 강제한다.
- **STUN만. TURN·relay 금지**(00 §원칙 2). `acceptIceServers()`가 `turn:`/`turns:`를
  버리고 **버렸다고 보고**한다(조용히 무시하지 않는다).
- **base64url 텍스트를 해시하지 말 것**(01 §0). 바이트로 디코드한 뒤 해시한다.
- **중계 내용은 로그에 남기지 않는다**(05). 필드 **이름**만, 값은 절대 — 값이 sealed
  box일 수 있다.

---

## 2. 현재 위치

- 워크트리 `C:\Project\AgentPartyApp-wt-mobile-pipe`, 브랜치 `mobile-pipe`
- 원 저장소 `C:\Project\AgentPartyApp`
- HEAD: 이 문서 커밋. 직전 `a7d282c`(state 노트) ← `f2187f7`(시그널링 주소 폴백)
  ← `a8b2185`(`sys.info`의 signalingUrl)
- 작업 트리 clean, 진행 중인 수정 없음
- **검증 상태: `typecheck` 통과, 모바일 테스트 14/14 통과**

### 아키텍처 문서 (프로토콜 진실의 출처)

`C:\Project\AgentPartyMobile\docs\아키텍처\` — `00-개요` `01-프로토콜` `02-보안-모델`
`03-모바일-앱` `04-데스크톱-확장` `05-운영자-서버` `06-플랫폼-매트릭스`
`07-역할-분담` `08-메서드-카탈로그` `09-모바일-기능-정의`, 그리고 `vectors/`.

**01이 프로토콜의 유일한 출처다. 와이어 포맷을 단독으로 바꾸지 말 것** — 변경은
develop을 통한다(잠금 기능은 security→develop 경로).

배선 안내서는 이 저장소의 `docs/mobile-gateway-wiring.md`(앱 쪽에서 파이프를 어떻게
붙이는지, `currentSeq()` 사용법, 상태 UI 가이드 포함).

### 프로토콜 패키지는 심링크다 (함정)

`node_modules/@agentparty/protocol` → `C:\Project\AgentPartyServer\packages\protocol`

server가 dist를 다시 빌드하면 **재설치 없이 즉시 반영**된다. 버전 번호가 그대로여도
내용이 바뀌었을 수 있으니 **버전으로 판단하지 말고 스키마를 직접 확인**할 것:

```bash
node -e "const P=require('@agentparty/protocol'); console.log(Object.keys(P.SysInfoResultSchema.shape))"
```

과거에 라이브 소크 중 `npm install`을 두 번 돌려 `node_modules`를 갈아엎고 실행을
죽인 적이 있다. 장시간 실행 중에는 설치 명령을 돌리지 말 것.

---

## 3. 테스트 14종

```bash
npm run typecheck        # tsc -p tsconfig.json && tsc -p tsconfig.main.json (둘 다 --noEmit)

npm run test:mobile-mock          # scripts/qa-mobile-gateway-mock.mjs
npm run test:mobile-portability   # 06 규칙 강제 (플랫폼 분기·OS 명령·env 금지)
npm run test:mobile-event-rpc
npm run test:mobile-identity
npm run test:mobile-signaling
npm run test:mobile-sender-audit  # §3 송신 원시 와이어 감사 (아래 §7)
npm run test:mobile-strict-table  # 01 §3.1~3.4 프레임 수용 표, 벡터와 교차검증
npm run test:mobile-pairing
npm run test:mobile-webrtc
npm run test:mobile-rpc
npm run test:mobile-diagnostics
npm run test:mobile-natmapper
npm run test:mobile-push
npm run test:mobile-real          # scripts/qa-mobile-gateway-real.mjs
```

14종 전부 `npm run test:ui`에도 포함돼 있다. 전부 인프로세스이거나 루프백이라 실기기가
필요 없다.

**소크는 별도이고 의도적으로 `test:ui`에 넣지 않았다**(수 시간 소요):

```bash
node scripts/qa-mobile-soak.mjs [--baseline] [--baseline-rss <bytes>]
```

`--baseline`은 파이프를 빼고 `node-datachannel`만 돌린다(문제 귀속용). 임계값은
스크립트 상단 `{rssPerCycle: 8*1024, heapGrowthRatio: 2.0, maxHandleGrowth: 64}`.
**최종 수치는 주기 샘플이 아니라 마지막 verdict 블록에서 읽을 것** — 샘플만 보고
6531 사이클로 보고했다가 실제 6803이었던 적이 있다.

장시간 실행은 출력을 파일로 남기고 종료 코드를 보존한다:

```bash
node scripts/qa-mobile-soak.mjs 2>&1 | tee soak.log; exit ${PIPESTATUS[0]}
```

---

## 4. 게이트웨이 CLI 기동법

Electron 밖에서 **진짜 게이트웨이**를 띄우고 HTTP로 조작한다
(AGENTS.md: 모든 기능은 자동화 API로 도달 가능해야 함).

```bash
npm run mobile:gateway -- --signaling ws://127.0.0.1:8080/v1/ws [--port 7100] \
                          [--data <dir>] [--name <표시이름>] [--pair-ttl <분>]
```

기본값: `--signaling ws://127.0.0.1:8080/v1/ws`, `--port 7100`, 데이터는 QA 임시 디렉터리.

HTTP 표면 (`http://127.0.0.1:<port>`):

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/status` | 게이트웨이 상태(= `getStatus()`) |
| GET | `/logs` | 로그 |
| GET | `/diagnostics` | 연결 진단 |
| GET | `/devices` | 신뢰 기기 목록 |
| POST | `/pair/open` | QR 발급 |
| POST | `/pair/confirm` | 확인 코드 |
| POST | `/pair/cancel` | 취소 |
| POST | `/emit` | 이벤트 발행(폰 수신 확인용) |

**주의**: 이 CLI는 제품이 아니다. Electron `safeStorage` 대신 **암호화하지 않는**
cipher를 주입하고, 게이트웨이는 그에 맞춰 `identity_unencrypted` 경고를 올린다.
키링 없는 리눅스와 같은 경로다 — 여기서 암호화하는 척하면 실제 degradation이
QA에서 안 보이게 된다.

`/connect`는 **이 저장소에 없다**(리포 전체 검색 확인). desktop-app이 보고한 간헐
`/connect` 실패는 앱/폰 쪽 자동화 표면이며, 파이프 쪽 관측 지점은 §6의
`lastRelayRejection`이다.

---

## 5. QA 환경 락 (해제 통보 전까지 유효)

사용자 직접 QA용으로 세팅된 상태다. **건드리면 QA가 깨진다.**

- **S22 `R3CT50BCAQL`** — 신뢰 목록이 **빈 상태**로 맞춰져 있음. 페어링하면 깨진다.
  `adb install` / `pm clear` / 앱 실행 / `adb forward` 8182 전부 금지
- **데스크톱 포트 52343**과 시그널링 터널이 살아 있음 — **재시작 금지**
- 기기가 필요하면 **desktop-app에 먼저 알리고 승인**받는다. 락 해제 통보는
  desktop-app이 한다

내 스크립트 중 adb를 호출하거나 8182를 잡는 것은 없다(검색 확인, 해당 문자열은
`scripts/fixtures/**`의 JSONL 안에만 존재). 그래도 락 기간에는 돌리지 않았다.

---

## 6. 미해결 / 미검증 항목

### 6.1 원칙 ⑤ — 실제 Electron 프로세스 제품 E2E (유일한 마감 미충족)

자동 검증만으로는 못 닫는다. review-desktop-pipe가 보류 중이며, 닫으려면
desktop-app의 최종 E2E 보고 5항목이 필요하다: ① 확인한 커밋 ② Electron 프로세스
확인 방식 ③ UI/자동화 API로 수행한 모바일 흐름 ④ S22 성공 결과 ⑤ 남은 실패 유무.

desktop-app에 **리뷰로 직접 보고**해 달라고 요청해 둔 상태다. 나는 완료 통보 한 줄만
받았으므로 재구성해서 전달하지 않았다. **후임도 하지 말 것** — 보지 않은 것을
보고하는 일이 된다.

### 6.2 빈 시그널링 설정 → `getStatus()` 예외 가능성 (**미검증 가설**)

`signalingEndpoint()`는 빈 문자열에 throw하고(`signalingClient.ts:503`), 그 호출이
`signalingUrls()`(`realMobileGateway.ts:794`) → `effectiveSignalingUrl()`(:759) →
`getStatus()`(:825) 경로에 있다. 설정의 `signalingUrl`이 `""`이면 상태 조회가 통째로
예외를 던질 수 있다.

- 출하 기본값은 `wss://sig.agentparty.app`(`src/shared/mobileProtocol.ts:247`) — 비어 있지 않다
- 사용자가 UI에서 값을 지우면 도달 가능
- **확인하려다 중단 지시로 멈췄다. 재현 못 했으므로 결함으로 단정하지 말 것.**

재현법: `scripts/qa-mobile-gateway-real.mjs`의 `gateway()` 헬퍼를 복사해
`readSettings()`가 `signalingUrl: ""`을 돌려주게 하고, `start()` 후 `getStatus()` 호출.

### 6.3 `/connect` 간헐 실패 — 미진단

desktop-app 보고. 재현이 잡히지 않았다.

**이미 반증된 가설 — 다시 세우지 말 것:**
1. 고정 포트가 점유돼도 PeerConnection **생성은 throw하지 않는다**
2. 소켓이 그 포트를 물고 있어도 **candidate는 계속 gather된다**

다음 재현 때 답이 나오도록 관측만 심어 뒀다: 릴레이 거부는 **와이어로 답을 줄 수
없어서**(미신뢰 기기는 `kxPk`가 없어 봉인할 대상이 없다) `getStatus().lastRelayRejection`
에 기록된다(`{from, kind, reason, detail, at}`, reason은 `unpaired_device` /
`undecryptable` / `handler_failed`). **폰이 조용하면 여기부터 본다.**

### 6.4 소프트 핸드오버 왕복 — 환경 제약으로 미실시

develop 승인 하에 보류. 재현 절차는 mobile-pipe에 전달했다:

```bash
adb shell settings put global mobile_data_always_on 1
adb shell svc wifi disable
```

`svc wifi disable`만 하면 hard transition이라 소프트 핸드오버가 아니다.

### 6.5 `scripts/qa-mobile-rpc.mjs:120`의 낡은 라벨 (사소)

server가 `SysInfoResultSchema.signalingUrl`을 추가하면서(AgentPartyServer `df6bf45`)
BLOCKED가 해소됐는데, 어서션 문구는 아직 "SysInfoResultSchema does not declare
signalingUrl"로 남아 ✓ 옆에 모순되게 출력된다. 제품 영향 없음.
develop의 "추가 다듬기 중단" 지시로 손대지 않았다.

고칠 때는 "키가 선언됐는가"가 아니라 **"값이 permissive 파싱을 통과해 살아남는가"**로
바꿀 것 — 후자가 실제로 막고 싶은 결함이다.

### 6.6 `node-datachannel` `cleanup()` SIGABRT

`try/catch`로 **못 잡는다.** napi assertion의 SIGABRT(exit 134)는 JS 예외 처리를
우회한다. 전에 넣었던 가드는 실효가 없어 제거했다. 파이프를 빼고(`--baseline`) 돌려도
재현되므로 node-datachannel 쪽 문제다.

### 6.7 연결 잠금(01 §5.1a / 02) — 착수 전

**security 멤버가 총괄**한다. 내 담당은 파이프 내 lock 프레임·세션 게이팅.
스키마는 develop 문서 확정 후. security에 이미 올린 설계 지적 4건:

1. **차단은 `evt` 송신에도 걸려야 한다.** 이벤트는 데스크톱→폰 push다
   (`EventBridge.publish()` → `session.deliver()`). 인바운드만 막으면 인증 전에 내용이
   나간다. 게이트는 `RpcServer`의 단일 진입점 **과** `deliver` 양쪽 — 핸들러별로 걸면
   새 예약 메서드가 우회한다.
2. **연속 실패 10회를 sessionId에 매면 재접속으로 리셋돼 한도가 무력화된다.** 인증
   *성공*은 sessionId 한정이 맞지만 *실패 카운터*는 deviceId 기준으로 세션을 넘어
   지속돼야 한다.
3. **잠금 구간 이벤트는 유실 금지**(01 §5.3). `publish()`가 구독자 유무와 무관하게 seq를
   부여하고 버퍼에 쌓으므로, 차단은 "버퍼링 중단"이 아니라 **"전달 보류"**여야 한다.
4. **`ctl ping`을 차단 대상에서 뺄지 결정 필요.** 막으면 PIN 입력 중 링크가 죽을 수 있다.

부수 효과: 인증이 sessionId 한정이면 **하드 핸드오버마다 재인증**이다. ICE restart는
같은 세션이라 무관(01 §4.1).

---

## 7. 되돌리기 전에 읽을 설계 판단

- **`ctx.workspacePath`는 params에서만 온다**(`rpcServer.ts:243`, `workspacePathOf()` :444).
  subscribe의 workspaces는 이벤트 필터 전용이고 ctx로 흐르지 않는다.
  `RpcRequestSchema`의 `p`는 `z.unknown().optional()`이라 **파이프가 params 내부를
  strip하는 것은 구조적으로 불가능**하다. E2E 409("Create a party before...") 경계
  판정에 이 사실이 쓰였고, 원인은 데스크톱 핸들러 측(04 §3 위반)으로 확정됐다.
- **`getStatus().signalingUrl`은 설정값이 아니라 지금 붙어 있는 주소다.** 폴백으로
  옮겨간 데스크톱이 자기가 *있는* 곳을 보고해야 폰이 낡은 주소로 갱신되지 않는다.
- **start 오버라이드(`--signaling`)는 목록을 대체하고 저장되지 않는다.** QA용 로컬
  서버를 가리킨 실행이 공용 서버로 조용히 폴백해 다른 것을 테스트하면 안 되고, 그
  URL이 사용자 설정에 남아도 안 된다.
- **응답한 주소는 설정으로 승격 저장**된다(= "성공한 것을 맨 앞으로", 01 ddc2563).
  목록의 맨 앞이 곧 설정이기 때문이다.
- **QR 거부 사유는 "등록 불가"이지 "신뢰 오염"이 아니다.** 01 ddc2563이 주소를 신뢰에서
  분리했으므로 옛 근거는 성립하지 않는다. 동작은 유지하되 근거를 바꿨다 — 서버가 한
  번도 응답한 적 없으면 `pair.open`을 등록할 수 없고, 폰은 데스크톱이 유효하다고
  표시 중인 코드에 대해 `pair_not_found`를 받는다.
- **`currentSeq()`는 상태를 읽기 *전에* 호출한다.** 뒤에 부르면 조용한 유실이고 앞에
  부르면 중복인데, **01 §5.3은 무손실을 요구한다**(중복 > 유실). `sendSnapshot()`이
  같은 이유로 같은 순서를 쓴다.
- **mock과 real은 같은 인터페이스의 별도 구현이다.** 과거에 수정이 mock에만 들어가
  테스트는 초록인데 제품은 낡은 상태를 반환한 사고가 있었다. **동작에 관한 주장은
  `qa-mobile-gateway-real.mjs`에도 반드시 넣는다.**
- **검사는 "실패할 수 있는 위치"에 둔다.** 이 프로젝트에서 반복된 실패 유형이
  *실패할 수 없어서 통과하는 검사*였다: 파서 출력(이미 strip된 뒤)을 재는 감사,
  방향 전용 타입이 `[]`를 반환해 통과하던 표, 실효 없던 `cleanup()` try/catch,
  워밍업 구간만 잰 소크 베이스라인. **새 검사를 넣을 때는 고장을 주입해 실제로
  빨간불이 되는지 먼저 확인할 것.** `qa-mobile-sender-audit.mjs`에 그 anti-vacuity
  패턴이 들어 있다.

---

## 8. 다른 멤버 접점

| 멤버 | 접점 |
|---|---|
| **develop** | 총괄. 프로토콜 변경·문서 확정·작업 배정. 와이어 포맷 단독 변경 금지 |
| **desktop-app** | 앱 쪽 배선(핸들러·설정 UI·apiSpec·`docs/API.md`). **제품 E2E 단독 수행자** — 기기·앱 조작은 전부 이 멤버가 한다 |
| **mobile-pipe** | 폰(Dart) 파이프. 프로토콜 대칭 확인 상대. lock 상태·unlock·실패 코드 담당 |
| **server** | `@agentparty/protocol` 패키지와 시그널링 서버. 스키마 추가 요청 대상 |
| **security** | 연결 잠금 총괄. 프로토콜 변경 요청은 security→develop 경로로만 |
| **ux** | 앱 화면·l10n. PIN/패턴 입력 화면 |
| **review-desktop-pipe** | 내 영역 리뷰어. 원칙 ⑤ 보류 중 |

**메시지 게이트**가 있다. develop에게는 프로토콜 이슈 / 문서·코드 불일치 / (검증
결과와 산출물 경로가 포함된) 완료 보고 / 실제 블로커만 통과한다. 거부되면 이유가
그대로 오니 규칙에 맞게 고쳐 다시 보낸다. 정말 급하면 `force: true` + 사유.

---

## 9. 주의사항 (사고가 났던 지점)

- **실행하지 않은 것을 보고하지 말 것.** 라이브 소크를 스스로 죽여 놓고 "정상
  진행 중"이라고 보고했다가 철회한 적이 있다.
- **다른 멤버 대신 실행하지 말 것.** 최종 E2E는 desktop-app 단독 수행이고, 나는
  정보만 준다. 수정 후 확인도 desktop-app이 한다.
- **미검증 가설을 결론처럼 쓰지 말 것.** 6.2/6.3은 미검증이라고 명시돼 있다.
- **`git stash`는 훅에서 차단**된다(파괴적). 쓰지 말 것.
- **`master`/`main` 체크아웃에서 직접 편집·커밋 금지.** 워크트리 + 피처 브랜치에서만
  작업한다(AGENTS.md).
- **조용한 폴백으로 실패를 감추지 말 것.** 실패는 로그·알림·진단으로 드러낸다.

---

## 10. 다음에 할 일

1. desktop-app의 E2E 보고가 review-desktop-pipe에 도착했는지 확인 → **원칙 ⑤ 종결**
2. 사용자 QA에서 파이프 결함이 나오면 수정(확인은 desktop-app이 한다)
3. security의 잠금 설계 확정 대기 → 파이프 내 lock 프레임·세션 게이팅 구현
4. QA 종료 후: 6.2 가설 검증, 6.5 라벨 정리, 리뷰 지적 백로그 반영

새 기능·리팩토링은 develop이 재개를 지시할 때까지 금지.
