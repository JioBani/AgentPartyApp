# 구형 `:7100` CLI lock/DataChannel 타임라인

수집 시각: 2026-08-17 21:xx KST  
수집 경로: 실행 중이던 `GET http://127.0.0.1:7100/status`, `GET http://127.0.0.1:7100/logs`  
종료 전 bootId: `0c472884-d7af-4f3d-b6c0-d556652acd3b`
보존 번들 SHA-256: `28F7EE1ECC06E927001B399244EAFCFF16A23AB58400ADA2A11026213819DB36`

## 종료 직전 상태

- signaling: `connected`
- signaling URL: `wss://playing-ryan-hydrogen-earned.trycloudflare.com/v1/ws`
- desktop deviceId: `Yve8p5HsZrD_QUECMrxe6B`
- trusted device count: `1`
- paired phone deviceId: `qBqRBz0TCEGeTWB5TaKM_-`
- sessions: `[]`
- event seq/count: `0/0`
- warning: `identity_unencrypted` (QA CLI의 의도된 비암호화 저장소)

## `/logs` 원문

```text
2026-08-17T12:02:21.404Z warn  mobile identity stored unencrypted {"file":"C:\\Project\\AgentPartyApp-wt-mobile-pipe\\.qa\\ha275888\\mobile-identity.json"}
2026-08-17T12:02:21.406Z info  mobile identity created {"deviceId":"Yve8p5HsZrD_QUECMrxe6B"}
2026-08-17T12:09:42.077Z info  mobile pairing opened {"expiresAt":1786968702076}
2026-08-17T12:10:55.889Z info  mobile pairing ended {"phase":"cancelled","message":"페어링이 취소되었습니다."}
2026-08-17T12:10:55.889Z warn  pairing failed {"error":"페어링이 취소되었습니다."}
2026-08-17T12:11:09.180Z info  mobile pairing opened {"expiresAt":1786968789180}
2026-08-17T12:11:10.377Z info  mobile pairing awaiting confirmation {"deviceId":"qBqRBz0TCEGeTWB5TaKM_-","name":"AgentParty Mobile"}
2026-08-17T12:11:20.575Z info  mobile pairing completed {"deviceId":"qBqRBz0TCEGeTWB5TaKM_-"}
2026-08-17T12:11:20.576Z info  pairing completed {"deviceId":"qBqRBz0TCEGeTWB5TaKM_-","name":"AgentParty Mobile"}
2026-08-17T12:11:53.033Z info  mobile session ended {"sessionId":"f5f08ad3-a592-4daa-b54d-75b8b32bb6e5","reason":"상대가 연결을 닫았습니다."}
2026-08-17T12:14:21.546Z info  mobile session ended {"sessionId":"91265631-176e-4def-b7d0-763a9f966fe1","reason":"상대가 연결을 닫았습니다."}
```

## 코드 대조 판정

두 연결 모두 desktop session 생성 뒤 약 15초에 phone이 peer-close했다. 실행 번들은
`ctl.lock`, lock provider/state, `rpc.begin()`을 전혀 포함하지 않는다. RpcServer 구성
(`.qa/mobileGatewayCli.mjs:3693-3710`)에도 lock dependency가 없고 SecureSession 생성 뒤에도
`rpc.begin()` 호출이 없다. 따라서 이번 timeout의 직접 원인은 **pre-lock desktop 번들과
lock을 필수로 기다리는 phone의 버전 불일치**다.

같은 번들에는 별개의 옛 결함도 있다. `.qa/mobileGatewayCli.mjs:3236-3239`는 이미 열린
DataChannel을 인계받으면 상태만 `connected`로 바꾸고 pending queue를 flush하지 않는다.
하지만 이 번들은 `ctl.lock` 자체를 만들지 않으므로, 이 결함은 이번 lock timeout의 직접
원인이 아니다.

현재 `mobile-link` 소스 `src/main/mobile/webrtcTransport.ts:509-514`에는 `5e26ffb`의
`flushPending()` 수정과 connection-lock 구현이 이미 포함돼 있다. 이 증거는 주소 fallback
실패가 아니라 구형 실행 번들과 현재 phone 사이의 세대 불일치를 보여준다.
