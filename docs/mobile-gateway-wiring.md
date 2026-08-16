# MobileGateway 접합 가이드

모바일 파이프(`src/main/mobile/`)를 데스크톱 앱에 붙이는 방법. 대상 독자는 **desktop-app 멤버**다.
파이프 내부는 이 문서에 없다 — 필요한 것은 전부 `MobileGateway` 인터페이스 하나로 나온다.

- 파이프 소유: desktop-pipe (`src/main/mobile/**`, `src/shared/mobileProtocol.ts`)
- 접합·핸들러·UI·자동화 API 소유: desktop-app
- 인터페이스 정의·프로토콜 정본: develop (`AgentPartyMobile/docs/아키텍처/01`, `07`)

인터페이스에 없는 것이 필요하면 파이프 내부를 고치지 말고 develop에게 요청한다.

## 의존성

`@agentparty/protocol`(`file:../AgentPartyServer/packages/protocol`)을 쓴다. `dist/`는 git에 없으므로
한 번 빌드해야 한다:

```
cd C:\Project\AgentPartyServer && npm install && npm -w @agentparty/protocol run build
```

봉투 타입·예약 메서드 이름·프레임/링버퍼 한도·암호는 **전부 이 패키지가 정본**이다.
`src/shared/mobileProtocol.ts`에는 패키지가 갖지 않는 것(게이트웨이 상태·설정·진단 shape)만 둔다.

esbuild로 파이프 모듈을 번들할 때는 `@agentparty/protocol`·`ws`·`node-datachannel`을
**`external`로 두어야 한다**. libsodium은 WASM이라 번들되면 난수원을 잃고
`No secure random number generator found`로 죽고, `node-datachannel`은 네이티브라 번들할 수 없다.

## 현재 상태

| 산출물 | 상태 |
|---|---|
| `MobileGateway` 인터페이스 + 타입 | 사용 가능 (`src/main/mobile/mobileGateway.ts`) |
| `MockMobileGateway` (폰 시뮬레이터 포함) | 사용 가능 (`src/main/mobile/mockMobileGateway.ts`) |
| 실물 게이트웨이(시그널링·WebRTC·E2E·RPC·진단·NAT 매핑·푸시) | 사용 가능 (`createMobileGateway({implementation:"real", deps})`) |
| 송신 큐 백프레셔(`queuedBytes`) | 사용 가능 — 실제 백로그를 보고, 2MB 초과 시 세션 종료 |
| ICE restart · 세션 만료(10초) | 사용 가능 |
| LanDirect·사용자 릴레이 | **미구현** (M6) |

> **제품 E2E는 아직 없다.** 파이프는 모듈 테스트와 상호운용 하네스·실기기로 검증했지만,
> **실제 AgentParty Electron 프로세스를 띄워 UI나 자동화 HTTP API로 구동한 적이 없다.**
> `scripts/mobile-gateway-cli.mjs`는 Electron 밖에서 파이프만 돌리는 QA 도구라 제품 E2E가
> 아니다. 접합이 끝나면 desktop-app과 함께 실제 앱 프로세스 E2E를 추가해야 한다.

`deps` 없이 `"real"`을 요청하면 예외로 실패한다. 목이 실물인 척하는 폴백은 없다.

## 붙이는 곳 — 총 4군데

### 1. 생성과 수명 (`main.ts` 또는 `AppController`)

```ts
import { createMobileGateway, type MobileGateway } from "./mobile";

const gateway: MobileGateway = createMobileGateway({
  implementation: "real",          // 목으로 개발할 때는 "mock"
  deps: {
    userDataPath: app.getPath("userData"),
    secretCipher: safeStorage,     // isEncryptionAvailable/encryptString/decryptString
    log: (level, message, detail) => log(level, "mobile", message, detail),
    onSecurityWarning: (warning) => broadcastToAllWindows("mobile:warning", warning),
    readSettings: () => settings.mobile ?? MOBILE_SETTINGS_DEFAULTS,
    writeSettings: (next) => settings.update({ mobile: next }),
    defaultDeviceName: os.hostname(),
    appVersion: app.getVersion(),
  },
});

await gateway.start();   // enabled:false면 소켓을 열지 않고 대기 상태로 남는다
app.on("before-quit", () => void gateway.stop());
```

`start()`는 설정의 `enabled`를 존중한다. 꺼둔 상태에서 켜려면 `start({ force: true })` — QA용이며
설정을 덮어쓰지 않는다. 로컬 시그널링은 `start({ signalingUrl: "ws://127.0.0.1:8080/v1/ws" })`.

**목에서 실물로 바꿀 때 두 가지**:

- **`updateSettings(persisted)` 시드를 제거할 것.** 실물은 `deps.readSettings()`를 스스로 읽는다.
  남겨두면 시작할 때마다 불필요한 설정 쓰기와 재연결이 일어난다.
- **`setSnapshotProvider` 등록은 사실상 필수다.** 폰의 첫 `resume`는 항상 스냅샷을 요구한다.

### 2. 이벤트 — `broadcastToWorkspace`에 **한 줄**

`src/main/main.ts`. `forwardRemoteEvent`(WSL 엔진 이벤트)도 이 함수를 지나가므로, 여기 한 곳만
탭하면 로컬·WSL 구분 없이 폰에 전달된다 (06 §WSL이 "그냥 되는" 이유).

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
- **페어링된 기기가 0대면 `emit`은 즉시 반환한다** — 아무도 되감을 수 없으므로 기록할 이유가 없다.
  핫패스에 둬도 되는 이유가 이 검사다.
- **폰이 연결돼 있지 않아도 기록한다.** 페어링된 폰이 잠시 떠나 있는 동안 발행된 이벤트가
  되감기로 재생되어야 한다(01 §5.3). 여기서 `seq`를 건너뛰면 폰의 커서가 그대로라 재연결 시
  `resumed`를 받고 **아무 일도 없었던 것처럼** 넘어간다 — 조용한 유실이다.
- 워크스페이스에 매이지 않는 전역 이벤트는 `scope`를 생략한다 → 모든 세션에 간다.
- `scope.workspacePath`가 있으면 **그 워크스페이스를 구독한 세션에만** 간다. 폰이
  `ctl.subscribe`를 보내기 전에는 워크스페이스 이벤트가 0건이다(01 §5.2). 정상이다.

#### 이벤트는 멱등이거나 위치를 실어야 한다 (01 §5.3)

되감기가 링버퍼 밖이면 파이프는 스냅샷을 보내는데, **스냅샷의 `seq`는 제공자가 실행되기 전
값**이다. 데스크톱은 상태와 `seq`를 원자적으로 잡을 수 없어 둘 중 하나를 골라야 했고, "유실 0"에
따라 이쪽을 택했다:

| 선택 | 결과 |
|---|---|
| `seq`를 제공자 **뒤**에 읽음 | 제공자가 상태를 읽은 직후 도착한 이벤트가 "포함됨"으로 처리돼 영영 재전송되지 않는다 — **무음 유실** |
| `seq`를 제공자 **앞**에 읽음 (채택) | 그 이벤트가 이미 상태에 있어도 한 번 더 전달된다 — **중복** |

중복되는 것은 **스냅샷 제공자가 실행되는 동안 발행된 이벤트**뿐이다. 파이프가 그것들을 붙잡아
스냅샷 **뒤에** seq 순으로 내보내므로, 실무적으로는 **스냅샷 직후에 오는 이벤트들**이 그 집합이다.
제공자가 빠를수록 창이 좁다.

부류별 위험(ux, `09-모바일-기능-정의.md` §3):

| 부류 | 예 | 중복 시 | 필요한 것 |
|---|---|---|---|
| 대입 | 멤버 상태·모델·연결 상태 | 무해(본래 멱등) | 없음 |
| 덧붙임 | 트랜스크립트 델타·도구 출력 | 같은 글이 두 번 붙음 | `offset`·ID |
| 누적 | 토큰·비용 카운터 | 숫자가 조용히 부풀려짐 | 증분 대신 절대값, 또는 ID |
| 승인 요청 | `approval_request` | 응답한 카드가 다시 열림 | 아래 참고 |

덧붙임 중복은 눈에 띄지만 누적은 그럴듯하게 틀리므로 더 위험하다.

**승인 요청은 리듀서만으로 부족하다.** 폰이 중복 카드를 걸러도 사용자가 두 번 탭하거나 두
기기에서 응답하면 `approval.respond`가 같은 `requestId`로 두 번 도착한다. 파이프는 그 메서드의
의미를 모르므로 막을 수 없다 — **핸들러가 `requestId` 기준으로 멱등이어야 하고**, 이미 응답된
요청은 재실행하지 말고 첫 응답 결과를 돌려줘야 한다.

### 3. 스냅샷 제공자 — 되감기 실패 시 폰에 줄 전체 상태

폰의 `resume {bootId,lastSeq}`가 링버퍼 밖이면(앱 재시작, 10분 초과, 첫 동기화) 파이프가 이걸
호출한다. **내용은 desktop-app이 정한다** — 파이프는 직렬화·청크만 한다.

```ts
gateway.setSnapshotProvider(async (ctx) => ({
  // ctx.workspaces = 그 세션이 구독 중인 워크스페이스 목록
  state: await controller.stateFor(ctx.workspaces),
}));
```

제공자를 등록하지 않으면 파이프는 빈 스냅샷을 지어내는 대신 **세션을 사유와 함께 종료한다**.
01 §5.3에 `snapshot`의 오류 변형이 없고, "데스크톱에 아무것도 없다"와 "데스크톱이 알려줄 수
없었다"가 폰에서 같아 보이면 안 되기 때문이다.

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
| `workspacePath` | **params의 `workspacePath` 문자열 필드를 파이프가 들어올린 값.** 파이프는 값을 해석하지 않는다 (04 §3) |
| `transport` | `directViaRendezvous` 등 |
| `signal` | 폰이 끊기거나 15초 응답 기한이 지나면 abort |
| `currentSeq()` | **호출 시점의** 이벤트 seq. 함수인 이유는 아래 |

폰은 이 값을 "이 답변에는 seq N까지가 이미 들어 있다"로 읽고 **N 이후만** 적용한다.

함수인 이유는 **어느 시점을 보고할지 호출자가 골라야** 하기 때문이다. 상태를 읽어서
돌려주는 핸들러(트랜스크립트·멤버 목록 등)는 **읽기 전에** 불러야 한다.

```ts
gateway.onRequest("member.transcript", async (params, ctx) => {
  const seq = ctx.currentSeq();                        // 읽기 전에
  const text = await readTranscript(params.workspacePath);
  return { text, seq };
});
```

상태와 seq를 원자적으로 잡을 수 없어서, 읽기가 일어난 시점 T에 대해 둘 중 하나는 반드시
생긴다.

| 보고 시점 | 결과 |
|---|---|
| 읽기 **전** | (before, T] 이벤트가 답변에도 있고 다시 오기도 함 → **중복** |
| 읽기 **후** | (T, after] 이벤트가 답변에 **없는데** 폰이 건너뜀 → **유실** |

01 §5.3은 유실 0을 요구하므로 중복을 택한다. 파이프의 `snapshot` 경로도 같은 이유로 제공자
실행 **전** seq를 쓴다 — 핸들러에서 나중 seq를 보고하면 그 경로가 막아둔 유실이 다시 생긴다.
(중복이 오므로 리듀서는 멱등해야 한다. 특히 누적형 이벤트가 그렇다.)

상태를 안 읽는 핸들러는 T가 없으니 아무 데서나 불러도 된다.

값은 링버퍼에 남아 있는 범위가 아니라 **누적 카운터**다. 버퍼는 잘려나가므로 버퍼 내용에서
유도하면 값이 뒤로 갈 수 있다.

규칙 두 가지가 **에러로** 강제된다 — 조용히 무시되지 않는다:

- `sys.ping` · `sys.info` · `push.register`는 파이프가 답한다. 등록하면 던진다.
- 같은 메서드 중복 등록은 던진다(마지막 등록이 이기는 사고 방지).

`onRequest`는 해제 함수를 돌려준다. 등록되지 않은 메서드는 파이프가
`{"ok":false,"e":{"code":"method_not_found"}}`로 답한다.

**핸들러가 폰에 오류 코드를 주려면 `RpcError`를 던져야 한다.**

```ts
import { RpcError } from "./mobile";

gateway.onRequest("member.send", async (params) => {
  if (typeof params?.text !== "string") {
    throw new RpcError("invalid_params", "text는 문자열이어야 합니다");
  }
  // …
});
```

평범한 `Error`는 `handler_failed`가 된다 — 진짜 결함에는 맞지만 폰이 분기할 수는 없다.
판정은 `instanceof`로 한다. Node 오류 상당수가 무관한 `code`(`ENOENT`, `ECONNREFUSED`)를 갖고
있어서, 그것들이 프로토콜 코드로 폰에 새어 나가면 안 되기 때문이다.

#### 오류로 던지면 안 되는 것 — 결과(outcome)

`RpcError`는 **요청을 수행할 수 없었을 때**만 쓴다. "수행했고 결과가 이러함"은 성공 응답의
값이어야 한다. 예: `approval.respond`의 `already_resolved`(09 §7)는 오류가 아니라 네 갈래
`outcome` 중 하나이고, `decision`·`resolvedAt`·`resolvedBy`를 함께 싣는다.

오류로 던지면 두 가지를 잃는다:

- 폰에서 `LinkFailure`로 보여 **"PC에 닿지 못함"과 구분되지 않는다** — 재시도해야 할 상황과 이미
  끝난 상황이 같아 보인다.
- 함께 실어야 할 필드를 실을 자리가 없다.

판단 기준: 폰이 그 응답에 **데이터를 함께 받아야 하거나** 정상 흐름의 한 갈래라면 성공 응답의
값이다. 오류 코드는 재시도·설정 변경 같은 **다른 행동**을 유도할 때만 쓴다.

> AGENTS.md 규칙상 폰에 노출하는 메서드는 대응하는 HTTP 엔드포인트가 있어야 한다.
> `automationApi.ts`의 라우팅은 라우트 **테이블이 아니라 if 체인**이므로 "apiSpec에 한 번
> 등록하면 HTTP·모바일 둘 다"는 지금 구조에서 공짜가 아니다. 테이블화 여부는 desktop-app 판단.

## 자동화 API에 노출할 표면 (04 §5)

파이프가 제공하는 메서드는 아래로 전부 덮인다. **등록·문서화는 desktop-app 몫이며 아직 되지
않았다.**

| 엔드포인트 | 게이트웨이 호출 |
|---|---|
| `POST /api/mobile/pair/open` | `pairing.openQr()` → `{ qr, expiresAt }`. **시그널링에 한 번도 연결된 적 없으면 throw** — 아래 참고 |
| `POST /api/mobile/pair/confirm` | `pairing.confirm()` |
| `POST /api/mobile/pair/cancel` | `pairing.cancel()` |
| `GET /api/mobile/status` | `getStatus()` — 동기, 페어링 상태(`phase`, `code`)까지 포함 |
| `GET /api/mobile/devices` | `pairing.devices()` |
| `POST /api/mobile/devices/:id/revoke` | `pairing.revoke(id)` |
| `POST /api/mobile/devices/:id/rename` | `pairing.rename(id, name)` |
| `POST /api/mobile/sessions/:id/disconnect` | `disconnect(id)` |
| `GET /api/mobile/diagnostics` | `diagnostics()` — STUN 프로브라 **수 초 걸린다** |

### QR 발급이 거부되는 경우

`openQr()`은 **주소 목록 중 어디에도 `pair.open`을 등록하지 못했으면** 오류를 던진다.
등록되지 않은 QR은 폰이 스캔해도 `pair_not_found`로 끝나기 때문이다 — 데스크톱 화면에는
유효한 QR이 떠 있는데도.

**한 곳만 되면 발급된다**(01 ddc2563). 클라이언트가 응답한 주소로 이미 넘어가 있고, QR은 그
주소를 담는다.

> 이전에는 "폰 신뢰기록이 오염된다"를 이유로 거부했으나, 01 ddc2563으로 **주소는 신뢰의
> 일부가 아니다**. 폰은 자기 목록으로 폴백하거나 사용자가 주소를 고칠 수 있으므로, 이사한
> 주소가 박힌 QR은 복구 가능하다. 남은 이유는 등록뿐이다.

UI는 이 오류를 "서버 주소를 확인하세요"로 그리고, 설정 화면으로 보내면 된다.

**한 번 연결된 뒤의 일시적 끊김은 막지 않는다.** 그 창에서 연 QR은 재연결 시
`reregister()`가 서버에 다시 등록하므로 실제로 복구되고, 막으면 UI만 고장 난 것처럼 보인다.
`getStatus().signaling`으로 구분할 수 있다.
| `GET`/`POST /api/mobile/settings` | `getSettings()` / `updateSettings(patch)` |

QA 흐름: `POST /api/mobile/pair/open`으로 QR 문자열을 얻어 폰(에뮬레이터) 자동화 API에 주입 →
`GET /api/mobile/status`로 확인 코드 대조 → `POST /api/mobile/pair/confirm`.

`getStatus()`는 **호출할 때마다 새로 만든다** — `emit` 직후에 폴링해도 늘어난 `events.seq`가
보인다. `emit`은 `broadcastToWorkspace` 위에 있어 매 이벤트마다 상태를 푸시하지 않으므로, 푸시
채널인 `status$`는 상태 전이에만 반응한다. 렌더러 푸시가 필요하면:

```ts
const stop = gateway.status$.subscribe((status) => broadcastToAllWindows("mobile:status", status));
```

rxjs는 쓰지 않는다. `subscribe(fn)`이 해제 함수를 돌려준다.

## "모바일에서 조작 중" 표시와 즉시 끊기 (04 §성능·안전)

`getStatus().sessions[]`에 다 있다:

- `inFlightRequests > 0` → 지금 폰이 이 데스크톱을 조작 중
- `lastRequestMethod` / `lastRequestAt` → 무엇을, 언제
- `state` → `connecting` | `connected` | `reconnecting` | `closed`.
  **`reconnecting`을 "끊김"으로 그리지 말 것** — 폰이 Wi-Fi↔LTE로 넘어가는 중이라는 뜻이고,
  10초 안에 돌아오면 같은 세션이 그대로 이어진다(01 §6, 키도 그대로다). 10초를 넘기면
  파이프가 세션을 닫고 목록에서 사라지므로, 그때 비로소 "끊김"이다. 폰은 곧 새 세션을
  만들어 되감기로 따라잡는다
- `candidatePair` → 실제로 연결을 나르는 ICE 쌍. `type`이 `host`면 LAN, `srflx`/`prflx`면 NAT를
  통과한 것이다. `relay`는 이 시스템에 TURN이 없으므로 나오면 안 된다
- `queuedBytes` → 아직 회선에 나가지 못한 바이트. 정상 링크에서는 0 근처에 머문다.
  **2MB(`MOBILE_LIMITS.sessionSendQueueMaxBytes`)를 넘으면 파이프가 세션을 끊는다** —
  폰은 재접속 후 되감기(01 §5.3)로 놓친 것을 받으므로 유실은 없다. UI에서 이 값이 계속
  커지는 세션은 "링크가 느려지고 있음"으로 읽으면 된다
- 끊기 버튼 → `gateway.disconnect(sessionId)`. 신뢰까지 끊으려면 `pairing.revoke(deviceId)`
  (이쪽은 `trustEpoch`를 올려 예전 `hello`를 거부하게 만든다)

## 푸시 (01 §7)

`gateway.push.notify(deviceId, payload)`. 페이로드는
`{ type: "approval", title, body, requestId, expiresAt }` — `type`은 리터럴이고 나머지는 필수다
(와이어 스키마가 그것만 받는다). 폰이 보내는 `push.register`는 파이프가 처리해 신뢰 레코드에
저장하므로 앱에서 할 일은 없다.

실패는 `PushError`이고 `code`로 분기한다:

| code | 앱이 할 일 |
|---|---|
| `peer_connected` | **오류로 표시하지 말 것.** 폰이 연결돼 있어 이미 E2E 채널로 전달됐다 |
| `not_paired` | 기기 목록 갱신 |
| `no_handle` | 폰이 아직 `push.register`를 보내지 않음 — 폰에서 앱을 한 번 열도록 안내 |
| `not_configured` | 설정에 `pushUrl` 없음 → 설정 화면 유도 |
| `rate_limited` | 릴레이 제한, 잠시 후 재시도 |
| `relay_refused` | 릴레이가 거부 — 메시지 표시, 즉시 재시도는 무의미 |
| `transport_failed` | 릴레이에 닿지 못함 — 재시도 가치 있음 |

## 목으로 개발·테스트하기

`createMockMobileGateway()`는 `MobileGateway` 전부 + `mock` 시뮬레이터를 준다. 소켓·암호·폰 없이
페어링 전 과정과 이벤트 전달을 재현한다.

```ts
const gateway = createMockMobileGateway();
await gateway.start({ force: true });

const session = await gateway.pairing.openQr();   // UI에 session.qr을 QR로 그린다
gateway.mock.scanQr({ deviceName: "Galaxy S25" }); // 폰이 스캔한 셈
session.code$.current;                             // "4213" — 확인 코드
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

`mock.request()`는 등록된 실제 핸들러를 호출하므로 **핸들러 자체를 폰 없이 테스트**할 수 있다.

**목은 실물이 아니다.** 둘은 한 인터페이스의 두 구현이고, 과거에 수정이 목에만 적용되어 목
테스트가 통과하는 동안 실물이 깨진 채 실기기까지 간 적이 있다. 동작에 관한 것은
`npm run test:mobile-real`이 실물을 직접 구동해 함께 검증한다.

## 앱 없이 파이프만 띄우기 — 게이트웨이 CLI

실물 게이트웨이를 Electron 밖에서 돌린다. 상호운용 하네스·실기기 QA·LTE 격리 시험에 쓴다.
**제품 E2E가 아니다** — 실제 앱 프로세스 검증은 desktop-app 접합 후에 따로 해야 한다.

```
node scripts/mobile-gateway-cli.mjs \
  --signaling wss://<host>/v1/ws \
  --port 7100 [--data <dir>] [--name <표시 이름>] [--pair] [--pair-ttl <분>] [--auto-confirm]
```

| 인자 | 뜻 |
|---|---|
| `--signaling` | 시그널링 URL. 평문 `ws://`는 루프백·`10.0.2.2`만 허용된다(운영은 `wss://`) |
| `--port` | 제어 HTTP 포트(기본 7100) |
| `--data` | 신원·신뢰 저장소 위치. 지우면 페어링이 초기화된다 |
| `--pair` | 뜨자마자 QR 발행 |
| `--pair-ttl <분>` | **개발 전용.** QR 유효시간(기본 2분, 상한 10분 — 시그널링 서버의 페어링 창과 같다). 켜면 `pairing_ttl_extended` 보안 경고가 뜬다 |
| `--auto-confirm` | **QA 전용.** 확인 코드 대조(02 §T4)를 건너뛴다. 실기기 검증에는 쓰지 말 것 |

### stdout 이벤트 (JSON 한 줄씩)

`started` · `qr` · `code` · `confirmed` · `paired` · `pairing_failed` · `sessions`.
사람이 읽는 줄은 `{`로 시작하지 않으므로 그걸로 걸러낸다.

### 제어 API

| 요청 | 하는 일 |
|---|---|
| `GET /status` | 게이트웨이 상태 + 설정 + 보안 경고 |
| `GET /logs` | 최근 200줄 (연결 실패 원인) |
| `GET /devices` | 신뢰 기기 목록 |
| `GET /diagnostics` | STUN 프로브·NAT 판정 실측 |
| `POST /pair/open` | QR 발행 → `{qr, expiresAt}` |
| `POST /pair/confirm` | 코드 일치 확인 후 blob2 발송 |
| `POST /pair/cancel` | 페어링 중단 |
| `POST /devices/:id/revoke` | 신뢰 해제(trustEpoch 증가) |
| `POST /sessions/:id/disconnect` | 세션만 끊기 |
| `POST /emit` | `{type, payload, workspacePath?}` 이벤트 주입. 응답의 `delivered`가 지금 전달된 세션 수이고 **0은 정상**(되감기로 재생된다). 페어링된 기기가 없을 때만 409 |

등록된 앱 메서드는 `qa.echo` 하나(파라미터를 그대로 반환)다.

### 제품과 다른 점

CLI의 `safeStorage` 대역은 **암호화하지 않는다**. 그래서 뜰 때 `identity_unencrypted` 경고가
찍힌다 — 키링 없는 리눅스와 같은 경로이며, 여기서 암호화하는 척하면 실제 강등이 QA에서 보이지
않게 된다. 또 CLI는 파이프를 ESM으로 번들하므로 `node-datachannel`을 직접 import해
`deps.loadWebrtcModule`로 주입한다(Electron main은 CommonJS라 불필요).

## 테스트

| 명령 | 검증 |
|---|---|
| `npm run test:mobile-mock` | 목의 계약: 페어링 단계, 예약 메서드 보호, 워크스페이스 필터, 스냅샷, 세션 종료 |
| `npm run test:mobile-real` | 실물 게이트웨이(소켓 없이): emit↔status 반영, 부재 중 기록, 미페어링 시 무기록, 푸시 오류 코드 |
| `npm run test:mobile-portability` | `src/main/mobile/**`에 플랫폼 분기·OS 명령·Electron 의존이 없음 (06 §검증) |
| `npm run test:mobile-event-rpc` | 링버퍼·구독 필터·되감기 판정, 01 §5.6 청크 분할/조립 |
| `npm run test:mobile-identity` | 신원 저장·복호 실패·키체인 부재·신뢰 레코드·trustEpoch |
| `npm run test:mobile-signaling` | 01 §3 핸드셰이크(실제 서명 검증), 송신 페이싱, 백오프, 종료성 오류, 수신 strict 거부, bare host → `wss://host/v1/ws` |
| `npm run test:mobile-sender-audit` | 01 §3 송신 감사: 소켓에 넘어가는 **원문** 기준으로 클라이언트 8종 규격 외 0건, 주입 필드가 실제로 잡히는지, 방향 표를 옳게 조회하는지 |
| `npm run test:mobile-strict-table` | 01 §3.1~3.4 허용 필드 표(벡터 `signalingFields` 대조): 정상 프레임 **전수 수락**, `err` 13종·relay `kind` 5종 포함 |
| `npm run test:mobile-pairing` | 01 §2 전 과정(실제 폰 역할), 확인 코드 일치·불일치, 재연결 시 재등록 |
| `npm run test:mobile-webrtc` | 실제 PeerConnection 2개 루프백, JSEP 후보 형태, 02 §T1 변조 거부, 후보 쌍 보고 |
| `npm run test:mobile-rpc` | 01 §5 봉투 처리, 예약 메서드, 되감기 순서 보장, strict 스키마 적합성 |
| `npm run test:mobile-diagnostics` | 판정 규칙 전수 + 실제 공개 STUN 서버 파싱 |
| `npm run test:mobile-natmapper` | 매핑 수명·재시도·해제, 실제 NAT-PMP/PCP 바이트를 스탠드인 라우터로 검증 |
| `npm run test:mobile-push` | 01 §7 봉인·서명, 릴레이/폰 역할 왕복, 실패 코드 |

14개 전부 `package.json`에 등록돼 있고 `npm run test:ui` 체인에 들어 있다 — 이 표와
`package.json`의 `test:mobile-*`는 1:1로 맞춰 유지한다.
**이들은 모듈·상호운용 검증이며 제품 E2E가 아니다.**

`scripts/qa-mobile-soak.mjs`는 장기 실행 안정성 측정용이라 **`test:ui`에 넣지 않았다**(2시간
단위로 돌기 때문). 의도적으로 등록하지 않은 것이며, 실행법은 파일 상단 주석에 있다.
`--baseline`은 파이프를 뺀 같은 루프를 돌려 node-datachannel 자체 증가분과 분리한다.
