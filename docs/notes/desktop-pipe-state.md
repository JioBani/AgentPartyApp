# desktop-pipe — 인계 노트 (2026-08-17)

컨텍스트 압축 후 이어서 작업하기 위한 상태 기록. 담당 범위는
`src/main/mobile/**`(시그널링·WebRTC·E2E·RPC·이벤트 브리지·UPnP/진단,
`MobileGateway`)와 그 QA 스크립트다.

## 지금 위치

- 워크트리 `C:\Project\AgentPartyApp-wt-mobile-pipe`, 브랜치 `mobile-pipe`
- HEAD `f2187f7` (시그널링 주소 목록+폴백, 01 ddc2563)
- 그 앞 `a8b2185` (`sys.info`가 시그널링 URL 보고, 01 ddc2563)
- 작업 트리 clean, 진행 중인 수정 없음

검증 상태: `npm run typecheck` 통과, **모바일 테스트 14/14 통과**.

```
npm run typecheck
npm run test:mobile-{mock,portability,event-rpc,identity,signaling,sender-audit,
                     strict-table,pairing,webrtc,rpc,diagnostics,natmapper,push,real}
```

`scripts/qa-mobile-soak.mjs`는 의도적으로 `test:ui`에 넣지 않았다(수 시간 소요).

### 프로토콜 패키지는 심링크다

`node_modules/@agentparty/protocol` → `C:\Project\AgentPartyServer\packages\protocol`.
server가 dist를 다시 빌드하면 **재설치 없이 즉시 반영**된다. 버전 번호가 그대로여도
내용이 바뀌었을 수 있으니 버전으로 판단하지 말고 스키마를 직접 확인할 것.

## 환경 락 (해제 전까지 유효)

사용자 직접 QA를 위해 세팅된 환경. **건드리면 QA가 깨진다.**

- S22 `R3CT50BCAQL` — 신뢰 목록이 **빈 상태**로 맞춰져 있음. 페어링하면 깨진다.
  `adb install`/`pm clear`/앱 실행/`adb forward` 8182 전부 금지
- 데스크톱 **포트 52343**과 시그널링 터널이 살아 있음 — 재시작 금지
- 기기가 필요하면 desktop-app에 먼저 알리고 승인받는다

내 스크립트 중 adb를 호출하거나 8182를 잡는 것은 없다(검색으로 확인, 해당 문자열은
`scripts/fixtures/**`의 JSONL 안에만 존재). 모바일 테스트는 전부 인프로세스·루프백이라
기기와 무관하지만, 락 기간에는 그래도 돌리지 않았다.

## 열린 항목

### 1. 원칙 ⑤ — 실제 Electron 프로세스 제품 E2E (유일한 마감 미충족)

내 영역이 자동 검증만으로 못 닫는 항목. review-desktop-pipe가 보류 중이며 닫으려면
desktop-app의 최종 E2E 보고가 필요하다: ① 확인한 커밋 ② Electron 프로세스 확인 방식
③ UI/자동화 API로 수행한 모바일 흐름 ④ S22 성공 결과 ⑤ 남은 실패 유무.

desktop-app에 **리뷰로 직접 보고**해 달라고 요청해 둔 상태(중계하면 손실). 나는 완료
통보 한 줄만 받았으므로 내가 재구성해서 전달하지 않는다.

### 2. 빈 시그널링 설정 → `getStatus()` 예외 가능성 (**미검증 가설**)

`signalingEndpoint()`는 빈 문자열에 throw하고(`signalingClient.ts:503`), 그 호출이
`signalingUrls()` → `effectiveSignalingUrl()` → `getStatus()` 경로에 있다
(`realMobileGateway.ts:759,794`). 설정의 `signalingUrl`이 `""`이면 상태 조회가
통째로 예외를 던질 수 있다.

- 출하 기본값은 `wss://sig.agentparty.app`(`src/shared/mobileProtocol.ts:247`)라 비어 있지 않다
- 사용자가 UI에서 값을 지우면 도달 가능
- **확인하다가 중단 지시로 멈췄다. 재현 못 했으므로 결함으로 단정하지 말 것.**

재현법: `readSettings()`가 `signalingUrl: ""`을 돌려주는 real 게이트웨이를 만들고
`start()` 후 `getStatus()` 호출. `scripts/qa-mobile-gateway-real.mjs`의 `gateway()`
헬퍼를 그대로 쓰되 `signalingUrl`만 `""`로 바꾸면 된다.

### 3. `/connect` 간헐 실패 — 미진단

desktop-app 보고. 재현이 잡히지 않았다. **반증된 가설 두 개**(다시 세우지 말 것):

- 고정 포트가 점유돼도 PeerConnection 생성은 throw하지 않는다
- 소켓이 그 포트를 물고 있어도 candidate는 계속 gather된다

다음 재현 때 답이 나오도록 관측만 심어 뒀다: 릴레이 거부는 와이어로 답을 줄 수 없어
(`kxPk`가 없는 미신뢰 기기) `getStatus().lastRelayRejection`에 기록된다. 폰이 조용하면
여기부터 본다.

### 4. 소프트 핸드오버 왕복 — 환경 제약으로 미실시

develop 승인 하에 보류. 재현 절차는 mobile-pipe에 전달했다:
`adb shell settings put global mobile_data_always_on 1` 후 `svc wifi disable`.
(`svc wifi disable`만 하면 hard transition이라 소프트 핸드오버가 아니다.)

### 5. `qa-mobile-rpc.mjs:120`의 낡은 라벨 (사소)

server가 `SysInfoResultSchema.signalingUrl`을 추가하면서(`df6bf45`) BLOCKED가 해소됐는데,
어서션 문구는 아직 "SysInfoResultSchema does not declare signalingUrl"로 남아 ✓ 옆에
모순되게 출력된다. 제품 영향 없음. develop의 "추가 다듬기 중단" 지시로 손대지 않았다.

문구를 고칠 때는 "키가 선언됐는가"가 아니라 **"값이 permissive 파싱을 통과해 살아남는가"**로
바꿀 것 — 후자가 실제로 막고 싶은 결함이다.

### 6. `node-datachannel` `cleanup()` SIGABRT

`try/catch`로 못 잡는다. napi assertion의 SIGABRT(exit 134)는 JS 예외 처리를 우회한다.
전에 넣었던 가드는 실효 없어 제거했다. 파이프를 빼고(`--baseline`) 돌려도 재현되므로
node-datachannel 쪽 문제다.

## 판단이 담긴 설계 메모 (되돌리기 전에 읽을 것)

- **`ctx.workspacePath`는 params에서만 온다**(`rpcServer.ts:243,444`). subscribe의
  workspaces는 이벤트 필터 전용이고 ctx로 흐르지 않는다. `RpcRequestSchema`의 `p`는
  `z.unknown().optional()`이라 파이프가 params 내부를 strip하는 것은 구조적으로 불가능하다.
  E2E 409("Create a party before...") 경계 판정에 이 사실이 쓰였고, 원인은 데스크톱
  핸들러 측(04 §3 위반)으로 확정됐다.
- **`getStatus().signalingUrl`은 설정값이 아니라 지금 붙어 있는 주소다.** 폴백으로 옮겨간
  데스크톱이 자기가 *있는* 곳을 보고해야 폰이 낡은 주소로 갱신되지 않는다.
- **start 오버라이드는 목록을 대체하고 저장되지 않는다.** QA용 로컬 서버를 가리킨 실행이
  공용 서버로 조용히 폴백해 다른 것을 테스트하면 안 되고, 그 URL이 사용자 설정에 남아도
  안 된다.
- **QR 거부 사유는 "등록 불가"이지 "신뢰 오염"이 아니다.** 01 ddc2563이 주소를 신뢰에서
  분리했으므로 옛 근거는 성립하지 않는다. 동작은 유지하되 근거를 바꿨다.
- **`currentSeq()`는 상태를 읽기 *전에* 호출한다.** 뒤에 부르면 조용한 유실이고 앞에 부르면
  중복인데, 01 §5.3은 무손실을 요구한다(중복 > 유실).

## 다음에 할 일

1. desktop-app의 E2E 보고가 review-desktop-pipe에 도착했는지 확인 → 원칙 ⑤ 종결
2. 사용자 QA에서 파이프 결함이 나오면 수정(확인은 desktop-app이 한다)
3. QA 종료 후: 항목 2 가설 검증, 항목 5 라벨 정리, 리뷰 백로그 반영

새 기능·리팩토링은 develop이 재개 지시할 때까지 금지.
