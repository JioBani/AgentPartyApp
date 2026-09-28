# Codex 저장소 전환 적대적 리뷰 후속

2026-09-28 · Opus 5.5 xhigh (`storage-adversary`) · 기준 `ee4f54f` / `04f38b6`

최초 리뷰 결론은 승인 불가다. 아래 수정과 회귀 검증은 진행했지만, 운영 전환과
정식 출시 승인으로 간주하지 않는다. master 병합·배포·운영 마이그레이션은 하지 않았다.

## 수정과 근거

| 지적 | 조치 / 검증 |
| --- | --- |
| 1. 대화마다 전체 DB 복사로 디스크 증폭 | 비교 이력은 해당 thread 행만 복사하고 비교 직후 삭제. 재구성/스키마 갱신 scratch는 성공·실패 후 정리. 원본 백업·보고서는 보존. 목적지 쓰기 전 예상 공간 + 5GiB 여유 검사. `qa-codex-storage-resources.py` 통과. 대규모 최종 재실행은 미완료. |
| 2. 다중 store의 오래된 보관 경로 | 실존 파일이 정확히 하나일 때만 사라진 이전 경로를 판별한다. 보관 플래그는 Codex 홈의 `sessions`/`archived_sessions`에 한해 복사본에서 정규화한다. 실존 파일 여러 개, 다른 메타데이터 충돌, 파일 삭제는 계속 명시적으로 거절한다. 다중 store의 구형 스키마·오래된 경로·보관 상태를 구성한 worker/API 검사 통과 (`.tmp/codex-version-4jx10ckt`). 원본 색인은 수정하지 않았다. |
| 4. 크래시 뒤 잔류 PID lock | Python worker가 요청 수신 전에 Windows byte-range lock을 획득한다. 두 앱 모두 같은 OS 잠금을 검사하며 파일 내용/PID로 판단하지 않는다. worker 종료 시 OS가 해제하며 Job Object가 자식도 종료한다. 양 앱의 live 차단, 빈/손상/PID 재사용 marker, 동시 worker 거절, 강제 종료, 재실행, 자식 종료 fault 검사 통과. |
| 5a. 복귀 후보도 같은 lifecycle 재작성 | 복귀 후보는 adapter/runtime 변경을 `dfff7a9`로 되돌렸다. `815ac82`는 기존 startup queue 종료 대기와 함께 discovery/환경 검사에서 초기화 timeout kill만 제거했다. 최신 실제 앱 전체 왕복 통과 (`.tmp/partial-storage-vday4_w5`). |
| 5b. 신규 프로필 자동 native | 신규·기존 모두 명시적 전환 전에는 legacy. 상태 조회는 모드 기록을 만들지 않는다. 실제 빈 프로필에서 확인했다. |
| 6. installer가 대기 중인 앱 강제 종료 | installer 실행 전에 초기화 대기, 유지보수 중 설치 거절. 실패 시 실행 가능한 앱을 그대로 유지하고 시작 차단을 해제한다. 자동/무인 NSIS 설치는 정상 종료를 최대 60회 폴링한 뒤 거절/Retry/Cancel로 진행하며 강제 종료하지 않는다. 실제 macro 컴파일·무설치 fixture에서 정상 종료 대기, 장시간 실행 거절, 프로세스 생존 확인 통과. 전체 제품 설치/feed 경로는 별도 미완료. |
| 8. mode commit 뒤 job 저장 전 크래시 | 동일 backup/report가 모드 기록에 commit되었다면 재시작 때 완료로 복원한다. 상태 조회가 정책을 변경하지 않는다. |
| 9. 종료 중 second-instance | 폐기 중인 앱에 새 창을 만들지 않는다. 일반 종료면 종료 후 재실행을 예약하고, 업데이트 중이면 installer가 재실행한다. 실제 앱·실제 Codex의 새 4,000개 색인 중 창을 닫고 second-instance를 실행했다. 기존 프로세스의 완료 대기, 새 창 재실행/HTTP 사용 가능, complete 색인을 확인했다 (`.tmp/partial-storage-ken7o9qs`). |
| 10. 일반 대화는 텍스트 multiset만 검사 | 모든 대화에서 순서·도구·이미지를 포함한 전체 API 이력을 비교한다. paginated 전용 빠른 우회 경로를 제거했다. |

최소 복귀 후보의 전체 빌드와 실제 앱 왕복이 통과했다. 이후 installer dispatch 실패의
시작 차단 해제는 targeted 검사로 별도 확인했다. 실제 모델은 `gpt-6-luna`, low,
inherit를 사용했다. 멤버 작업은 실제 member-scoped MCP, 저장소 관리와 fixture/창 닫기는
해당 MCP가 없는 HTTP 경로를 사용했다. OS/트랜잭션/NSIS macro 검사는 제품 E2E와 구분한다.

## 아직 해결되지 않은 출시·전환 조건

1. 3번 backfill 중단 후 복구: 리뷰어가 Codex 0.158에서 4,000개 색인 도중 강제 종료 후
   `running`이 남아 세 번의 재시작이 모두 실패하는 것을 재현했다. doctor도 복구하지 않았다.
   양 앱의 discovery/환경 검사와 전환 앱 adapter/worker는 초기화 경고 시간 초과로 죽이지
   않는다. 실제 CLI·새 store·4,000개 rollout으로 양 앱의 discovery/환경 검사를 각각 실행했고
   1ms 경고 뒤 모두 complete/4,000개 색인 완료를 확인했다 (`.tmp/initialize-wait-0t9v2ig8`).
   worker는 live initialize 직전 complete 및 공식 갱신 사본과의 migration 일치를 요구한다.
   없는 index는 private store에서 공식 Codex 색인을 끝내고 Windows no-overwrite rename으로
   게시한다. 남은 WAL/SHM/journal은 거절한다. OS 종료·런타임 크래시·외부 CLI의 향후 schema
   변경은 이 worker 게이트 밖이다. 이미 멈춘 공유 DB의 공식 복구 경로는 확인되지 않았다.
2. 5c의 요구 범위: 앱 다운그레이드는 최신 native 데이터를 계속 읽는다. native 저장소
   자체의 문제가 legacy로 즉시 전환된다는 뜻이 아니다. 저장소 모드 복귀는 별도 검증과
   Python/유지보수 시간이 필요하다. 이 한계를 숨긴 채 “모든 문제를 다운그레이드로 즉시 해결”이라고
   보장하지 않는다. 활성화 전 사용자에게 이 차이를 설명해야 한다.
3. 7번 lazy rollout: 정상 빈 멤버는 turnCount 가드로 ID를 저장하지 않아 전환된다.
   실제 앱에서 확인했다. 과거 ID/import 기록은 참조가 남아 있으면 소유 파티/멤버와 함께
   실패한다. 명시적 disconnect/reconnect 관리 API는 동의·ID 비교·closed·유지보수 검사를
   거치며 transcript와 Codex 파일을 보존하고 해제 ID도 기록한다. 참조가 없고 모든 경로에
   파일이 없는 색인은 전환 제외 보고서에 기록하며 원본/백업 cache를 보존한다.
   누락·비참조 파일도 기본값은 실패다. root 접근과 home 범위를 확인하고, 상태의 누락 ID/경로
   목록을 본 뒤 재요청에서 정확히 같은 ID 집합을 명시해야 제외한다. 목록 변화는 다시 실패한다.
   `.tmp/partial-storage-net6bugs`에서 실제 CLI delete 이후 남은 legacy 색인/cache, 기본 거절,
   정확한 제외 승인, 최종 제외 건수, 캐시 미부활을 확인했다. 정상 첫 턴의 turn/started 직후
   실제 MCP interrupt를 보낸 `.tmp/partial-storage-tnybrszo`에서도 interrupted 상태·rollout 존재와
   legacy/native 왕복을 확인했다. 특별한 지연 삽입으로 interruptAfterStart 분기를 강제한 검사는 아니다.
4. 실제 제품 NSIS 설치·자동 업데이트·feed 회수에 의한 다운그레이드 검증은 남았다.
   독립 macro 검사와 개발 앱 왕복을 이 검증으로 대체하지 않는다.
   이 머신에는 Windows Sandbox 실행 파일이 없어 설치 격리 환경도 준비되지 않았다.
   실행 중인 운영 앱 설치를 덮어쓰는 방법으로 검증하지 않았다.
5. 운영 규모의 최종 회귀 검사: 운영 데이터는 읽기 전용 inventory만 확인했다.
   당시 365 stores / 887 threads / DB 약 8.63GiB이고, 정규화된 경로/메타데이터 충돌은 없었다.
   Codex 홈 밖의 과거 QA rollout을 가리키는 기록 1개가 있었다. 운영 파일/색인은 수정하지
   않았으며, 이 경로의 처리와 충분한 디스크 여유를 확보한 뒤 격리 사본에서 검증해야 한다.

11번 Fast→inherit는 기존 버전도 영향을 받는 별도 문제로 확인했다. Codex 0.158에서
priority 실턴 후 unsubscribe/resume하면서 tier를 생략해도 priority가 유지됐다.
따라서 기존 0.18의 재시작 경로도 이를 해제하지 않는다. 설정 별칭/profile/model 기본값을
앱이 추측해 강제로 바꾸지 않았고, 이번 저장소 수정의 회귀와 별도 추적한다.

## 디스크 정리 차단

리뷰가 측정한 이전 corpus QA는 약 109GiB이며, 그중 약 96GiB가 임시 baseline이었다.
해당 baseline만 제거하고 원본 백업·보고서를 보존하는 작업은 자동 승인 검토에서
`blocked by policy`로 거부됐다. 삭제하지 않았으며 사용자에게 정확한 대상의 삭제 확인을
요청했다. 다른 도구로 우회 삭제하지 않는다. 공간이 확보되기 전에는 큰 corpus를 추가 복제하지 않는다.
