# 실제 Electron + HA275888 live signaling 제품 E2E (2026-08-17)

## 실행물

- Desktop: 실제 Electron `C:\Project\AgentPartyApp-wt-mobile-link\node_modules\electron\dist\electron.exe .`
- Desktop PID: `59116`
- AgentPartyApp: `mobile-link@948faef3357a89b54edfc880a8b2f21ebae939d5`
- Desktop automation: `http://127.0.0.1:52343`
- Mobile: `72d87d3` 실제 pipe/app, 태블릿 `HA275888`
- Mobile automation: `http://127.0.0.1:8182`
- Desktop deviceId: `Yve8p5HsZrD_QUECMrxe6B`
- Desktop bootId: `58451e19-e9c5-45c7-9c40-ac41db68165f`

S22 `192.168.137.119:5555`에는 접근하지 않았다. 기존 CLI userData를 같은 경로에서
직접 열어 desktop identity와 phone trust를 재사용했으며 identity 파일을 복사하거나
이식하지 않았다.

## 연결 및 connection lock

- 연결 시작: `2026-08-17T12:26:18.773Z`
- 연결 완료: `2026-08-17T12:26:22.675Z`
- transport: `directViaRendezvous`
- desktop/phone sessionId: `36cc7bb1-79ae-445a-8a93-4f11251726ae`
- 추가 pairing 없이 기존 trust 사용
- desktop lock 설정: `configured:false`
- desktop session: `lockAuthenticated:true`

첫 `ctl.lock {required:false}` 패킷의 별도 raw 캡처나 스크린샷은 남기지 않았다.
`lockAuthenticated:true` full-connect 제품 상태와 현재 `RpcServer.begin()`이 의무 첫
프레임으로 현재 lock state를 쓰는 구현을 함께 근거로 required:false 전송을 판정했다.
패킷을 직접 캡처했다고 주장하지 않는다.

이 결과는 보존된 pre-lock CLI와 lock 필수 phone 사이의 15초 timeout이 현재 소스에서는
해소됐음을 실제 제품 경로로 확인한다.

## 연결 중 signaling 변경

연결된 WebRTC session에서 desktop automation API `POST /api/mobile/settings`로
signaling URL을 다음과 같이 변경했다.

- 변경 전: `wss://playing-ryan-hydrogen-earned.trycloudflare.com/v1/ws` (8080)
- 변경 후: `wss://alcohol-thoroughly-increasing-par.trycloudflare.com/v1/ws` (8090)

변경 뒤 desktop signaling은 8090에 connected였고 bootId와 sessionId는 바뀌지 않았다.
phone이 연결 위에서 다시 요청한 `sys.info.signalingUrl`도 8090을 반환했다. 따라서
signaling socket 교체가 진행 중 WebRTC/SecureSession/RPC/EventBridge를 종료하지 않고
새 주소를 무중단 전파한다는 요구를 실제 제품 프로세스에서 확인했다.

## EventBridge 연속성

- 관측 seq: `4,5,6,7,8`
- 누락: 없음
- 중복: 없음
- desktop seq: `8`
- desktop lastDeliveredSeq: `8`
- phone lastSeq: `8`

phone 저장 주소 목록은 재시작 전후 `[8080, dead.invalid]` 그대로였다. Mobile은 connect
직후 `sys.info`만 저장하고 이후 generic `sys.info` 응답은 trust list에 반영하지 않는
경로이므로, 이는 desktop live-session 보존 요구와 분리된 Mobile 잔여 결함이다. 실패를
숨기지 않고 mobile-pipe 범위에서 추적한다. 테스트 후 태블릿 `HA275888`은 해제됐다.

review-desktop-pipe는 수행자 desktop-app의 직접 보고와 위 캡처 한계를 확인한 뒤
desktop-pipe 원칙 ①②③④⑤⑥⑦을 모두 PASS로 최종 판정했다.
