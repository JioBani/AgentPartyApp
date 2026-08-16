# MobileGateway 접합 가이드

모바일 파이프(`src/main/mobile/`)를 데스크톱 앱에 붙이는 방법. 대상 독자는 **desktop-app 멤버**다.
파이프 내부는 이 문서에 없다 — 필요한 것은 전부 `MobileGateway` 인터페이스 하나로 나온다.

- 파이프 소유: desktop-pipe (`src/main/mobile/**`, `src/shared/mobileProtocol.ts`)
- 접합·핸들러·UI·자동화 API 소유: desktop-app
- 인터페이스 정의·프로토콜 정본: develop (`AgentPartyMobile/docs/아키텍처/01`, `07`)

인터페이스에 없는 것이 필요하면 파이프 내부를 고치지 말고 develop에게 요청한다.

## 의존성

`@agentparty/protocol`(`file:../AgentPartyServer/packages/protocol`)을 씁니다. `dist/`는 git에 없으므로 한 번 빌드해야 합니다:

```
cd C:\Project\AgentPartyServer && npm install && npm -w @agentparty/protocol run build
```

봉투 타입·예약 메서드 이름·프레임/링버퍼 한도·암호는 **전부 이 패키지가 정본**입니다.
`src/shared/mobileProtocol.ts`에는 패키지가 갖지 않는 것(게이트웨이 상태·설정·진단 shape)만 둡니다.
esbuild로 파이프 모듈을 번들할 때는 이 패키지를 **`external`로 두세요** — libsodium이 WASM이라 번들되면
난수원을 잃고 `No secure random number generator found`로 죽습니다.

## 현재 상태

| 산출물 | 상태 |
|---|---|
| `MobileGateway` 인터페이스 + 타입 | **사용 가능** (`src/main/mobile/mobileGateway.ts`) |
| `MockMobileGateway` (폰 시뮬레이터 포함) | **사용 가능** (`src/main/mobile/mockMobileGateway.ts`) |
| 공유 타입·상수·사유 코드 | **사용 가능** (`src/shared/mobileProtocol.ts`) |
| 실물 게이트웨이 (시그널링·WebRTC·E2E·RPC) | **사용 가능** — `createMobileGateway({implementation:"real", deps})` |
| 진단(`diagnostics()`) · 푸시(`push.notify()`) | 미구현 — 호출하면 **명시적으로 던진다**(M3/M5) |

목이 실물인 척하는 폴백은 없다. `deps` 없이 `"real"`을 요청하면 예외로 실패한다.
아직 없는 기능(진단·푸시)도 그럴듯한 값을 지어내지 않고 던진다 (AGENTS.md: 실패 은폐 금지).

`diagnostics()`를 호출하는 UI/라우트를 지금 붙이면 예외를 보게 된다. M3까지는 그 버튼을
비활성으로 두거나 예외 메시지를 그대로 표시하는 편이 낫다.

## 붙이는 곳 — 총 4군데

### 1. 생성과 수명 (`main.ts` 또는 `AppController`)

```ts
import { createMobileGateway, type MobileGateway } from "./mobile";

const gateway: MobileGateway = createMobileGateway({
  implementation: "real",          // 목으로 개발할 때는 "mock"
  deps: {                          // "real"일 때만 필요
    userDataPath: app.getPath("userData"),
    secretCipher: safeStorage,     // Electron safeStorage를 그대로 넘긴다 (isEncryptionAvailable/encryptString/decryptString)
    log: (level, message, detail) => log(level, "mobile", message, detail),
    onSecurityWarning: (warning) => broadcastToAllWindows("mobile:warning", warning),
    readSettings: () => settings.mobile ?? MOBILE_SETTINGS_DEFAULTS,
    writeSettings: (next) => settings.update({ mobile: next }),
    defaultDeviceName: os.hostname(),
    appVersion: app.getVersion(),
  },
});

await gateway.start();   // enabled:false면 소켓을 열지 않고 조용히 대기 상태로 남는다
app.on("before-quit", () => void gateway.stop());
```

`start()`는 설정의 `enabled`를 존중한다. 사용자가 꺼둔 상태에서 켜고 싶으면
`start({ force: true })` — QA용이며 설정을 덮어쓰지 않는다.
로컬 시그널링 서버로 붙일 때는 `start({ signalingUrl: "ws://127.0.0.1:8080/v1/ws" })`.

### 2. 이벤트 — `broadcastToWorkspace`에 **한 줄**

`src/main/main.ts:645`. `forwardRemoteEvent`(WSL 엔진 이벤트)도 이 함수를 지나가므로,
여기 한 곳만 탭하면 로컬·WSL 구분 없이 폰에 전달된다 (06 §WSL이 "그냥 되는" 이유).

```ts
function broadcastToWorkspace(workspacePath: string, channel: string, payload: unknown): void {
  for (const entry of registry().forWorkspace(workspacePath)) {
    entry.window.webContents.send(channel, payload);
  }
  gateway.emit(channel, payload, { workspacePath });   // ← 추가되는 줄
}
```

- 이벤트 타입 이름 = IPC 채널명 그대로. 파이프는 의미를 모르고 페이로드를 손대지 않는다.
- `seq` 부여·링버퍼(5,000개/10분)·되감기·청크 분할은 전부 파이프가 한다.
- **세션이 0개면 `emit`은 즉시 반환한다** — 객체 생성도 하지 않으므로 핫패스에 둬도 된다.
- 워크스페이스에 매이지 않는 전역 이벤트(사용량 등)는 `scope`를 생략한다:
  `gateway.emit("usage:update", payload)` → 모든 세션에 간다.
- 반대로 `scope.workspacePath`가 있으면 **그 워크스페이스를 구독한 세션에만** 간다.
  폰이 `ctl.subscribe`로 구독 집합을 보내기 전에는 워크스페이스 이벤트가 0건이다(01 §5.2). 정상이다.

### 3. 스냅샷 제공자 — 되감기 실패 시 폰에 줄 전체 상태

폰의 `resume {bootId,lastSeq}`가 링버퍼 밖이면(앱 재시작, 10분 초과) 파이프가 이걸 호출한다.
**내용은 desktop-app이 정한다** — 파이프는 직렬화·청크만 한다.

```ts
gateway.setSnapshotProvider(async (ctx) => ({
  // ctx.workspaces = 그 세션이 구독 중인 워크스페이스 목록
  state: await controller.stateFor(ctx.workspaces),
}));
```

제공자를 등록하지 않으면 파이프는 빈 스냅샷을 지어내는 대신 **세션을 사유와 함께 종료한다**.
01 §5.3에 `snapshot`의 오류 변형이 없고, "데스크톱에 아무것도 없다"와 "데스크톱이 알려줄 수 없었다"가
폰에서 같아 보이면 안 되기 때문이다. **실물 게이트웨이를 붙이면 이 등록은 사실상 필수다** —
폰의 첫 `resume`는 항상 스냅샷을 요구한다.

### 4. 메서드 핸들러 — `onRequest`

```ts
gateway.onRequest("party.list", async (params, ctx) => {
  return controller.listParty(ctx.workspacePath ?? defaultWorkspace());
});
```

`RequestContext`:

| 필드 | 내용 |
|---|---|
| `deviceId` / `deviceName` | 신원 검증이 끝난 페어링 기기 |
| `sessionId` | `gateway.disconnect(sessionId)`에 그대로 넘길 수 있다 |
| `requestId` | 봉투 `id` — 폰 로그와 대조용 |
| `method` | 메서드 이름 |
| `workspacePath` | **params의 `workspacePath` 문자열 필드를 파이프가 들어올린 값**. 파이프는 값을 해석하지 않는다 (04 §3) |
| `transport` | `directViaRendezvous` 등 |
| `signal` | 폰이 끊기거나 15초 응답 기한이 지나면 abort |

규칙 두 가지가 **에러로** 강제된다 — 조용히 무시되지 않는다:
- `sys.ping` · `sys.info` · `push.register`는 파이프가 답한다. 등록하면 던진다.
- 같은 메서드 중복 등록은 던진다(마지막 등록이 이기는 사고 방지).

`onRequest`는 해제 함수를 돌려준다. 등록되지 않은 메서드는 파이프가
`{"ok":false,"e":{"code":"method_not_found"}}`로 답한다.

> AGENTS.md 규칙상 폰에 노출하는 메서드는 대응하는 HTTP 엔드포인트가 있어야 한다.
> `automationApi.ts`의 라우팅은 현재 라우트 **테이블이 아니라 if 체인**이므로
> "apiSpec에 한 번 등록하면 HTTP·모바일 둘 다"는 지금 구조에서 공짜가 아니다.
> 테이블화 여부는 desktop-app 판단 (04 §1은 이 사실에 맞춰 정정됨).

## 자동화 API에 노출할 표면 (04 §5)

파이프가 제공하는 메서드는 아래로 전부 덮인다. 등록·문서화는 desktop-app 몫이다.

| 엔드포인트 | 게이트웨이 호출 |
|---|---|
| `POST /api/mobile/pair/open` | `pairing.openQr()` → `{ qr, expiresAt }` |
| `POST /api/mobile/pair/confirm` | `pairing.confirm()` |
| `POST /api/mobile/pair/cancel` | `pairing.cancel()` |
| `GET /api/mobile/status` | `getStatus()` — 동기, 페어링 상태(`pairing.phase`, `code`)까지 포함 |
| `GET /api/mobile/devices` | `pairing.devices()` |
| `POST /api/mobile/devices/:id/revoke` | `pairing.revoke(id)` |
| `POST /api/mobile/devices/:id/rename` | `pairing.rename(id, name)` |
| `POST /api/mobile/sessions/:id/disconnect` | `disconnect(id)` |
| `GET /api/mobile/diagnostics` | `diagnostics()` |
| `GET`/`POST /api/mobile/settings` | `getSettings()` / `updateSettings(patch)` |

QA 흐름: `POST /api/mobile/pair/open`으로 QR 문자열을 얻어 폰(에뮬레이터) 자동화 API에 주입 →
`GET /api/mobile/status`로 확인 코드 대조 → `POST /api/mobile/pair/confirm`.

`getStatus()`는 동기 프로퍼티 읽기라 HTTP 핸들러에서 await 없이 즉답할 수 있다.
렌더러 푸시가 필요하면 `status$.subscribe(fn)`(해제 함수 반환) — rxjs는 쓰지 않는다.

```ts
const stop = gateway.status$.subscribe((status) => broadcastToAllWindows("mobile:status", status));
```

## "모바일에서 조작 중" 표시와 즉시 끊기 (04 §성능·안전)

`getStatus().sessions[]`에 다 있다:

- `inFlightRequests > 0` → 지금 폰이 이 데스크톱을 조작 중
- `lastRequestMethod` / `lastRequestAt` → 무엇을, 언제
- `queuedBytes` → 백프레셔 상한(2MB) 초과 시 세션을 끊고 되감기에 맡길 값. **M2까지는 항상 0이다**
- 끊기 버튼 → `gateway.disconnect(sessionId)`. 신뢰까지 끊으려면 `pairing.revoke(deviceId)`
  (이쪽은 `trustEpoch`를 올려 예전 `hello`를 거부하게 만든다)

## 목으로 개발·테스트하기

`createMockMobileGateway()`는 `MobileGateway` 전부 + `mock` 시뮬레이터를 준다.
소켓·암호·폰 없이 페어링 전 과정과 이벤트 전달을 그대로 재현한다.

```ts
const gateway = createMockMobileGateway();
await gateway.start({ force: true });

const session = await gateway.pairing.openQr();   // UI에 session.qr을 QR로 그린다
gateway.mock.scanQr({ deviceName: "Galaxy S25" }); // 폰이 스캔한 셈
session.code$.current;                             // "4213" — 확인 코드가 뜬다
await gateway.pairing.confirm();                   // 사용자가 "일치" 클릭
await session.completed;                           // TrustedDevice

const sessionId = gateway.mock.connect();          // 폰이 붙었다
gateway.mock.subscribe(sessionId, ["C:/proj/a"]);  // 폰의 ctl.subscribe
gateway.emit("session:events", { block: 1 }, { workspacePath: "C:/proj/a" });
gateway.mock.deliveredTo(sessionId);               // 그 세션이 실제로 받은 이벤트

await gateway.mock.request("party.list", { workspacePath: "C:/proj/a" }); // 핸들러 왕복
await gateway.mock.snapshot(sessionId);            // 되감기 실패 경로
gateway.mock.setDiagnostics("symmetric_nat");      // 진단 화면의 실패 케이스
gateway.mock.failPairing("확인 코드가 일치하지 않습니다.");
gateway.mock.reset();
```

`mock.request()`는 등록된 실제 핸들러를 호출하므로, **핸들러 자체를 폰 없이 테스트**할 수 있다.

목의 동작은 계약이다. `npm run test:mobile-mock`이 지킨다.

## 실물로 바꿀 때

바뀌는 것은 `createMobileGateway`의 `implementation` 인자 하나다.
접합 코드(`emit` 한 줄, `onRequest` 등록, 스냅샷 제공자, HTTP 라우트, UI)는 그대로 둔다.

실물에서 달라지는 점 두 가지:
- **`gateway.updateSettings(persisted)`로 시드하지 말 것.** 실물은 `deps.readSettings()`를
  스스로 읽는다. 시드를 남겨두면 시작할 때마다 불필요한 설정 쓰기와 재연결이 한 번씩 일어난다.
- **스냅샷 제공자를 반드시 등록할 것.** 폰의 첫 `resume`는 항상 스냅샷을 요구하는데(01 §5.3),
  제공자가 없으면 파이프는 빈 상태를 지어내는 대신 **세션을 사유와 함께 종료**한다.

## 테스트

| 명령 | 검증 |
|---|---|
| `npm run test:mobile-mock` | 목의 계약: 페어링 단계, 예약 메서드 보호, 워크스페이스 필터, 스냅샷, 세션 종료 |
| `npm run test:mobile-portability` | `src/main/mobile/**`에 플랫폼 분기·OS 명령·Electron 의존이 없음 (06 §검증) |

둘 다 `npm run test:ui` 체인에 들어 있다.

## 아직 없는 것 (파이프 로드맵)

| 항목 | 마일스톤 |
|---|---|
| identityStore / pairingService / signalingClient | M1 |
| webrtcTransport (node-datachannel, STUN only, fp 서명) / secureSession | M1 |
| rpcServer / eventBridge (실물 링버퍼·resume·chunk) | M1 |
| natMapper (UPnP/NAT-PMP/PCP) / diagnostics 실측 | M3 |
| pushClient | M5 |
