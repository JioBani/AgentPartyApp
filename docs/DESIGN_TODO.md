# 디자인 수정 할일

나중에 **한 번에 몰아서** 손볼 디자인 항목 모음. 기능 구현과 분리해서 관리한다.
디자인 토큰/테마 규칙은 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) 참고 — 색·radius는
컴포넌트에 하드코딩하지 말고 `var(--token)` 사용.

## 대기 중

- [ ] **Codex 승인 카드가 너무 화려함** — 톤 다운 필요.
  - 위치: [Transcript.tsx](../src/renderer/workbench/Transcript.tsx) `CodexApprovalBlock`,
    스타일 `.wb-codex-approval*` / `.wb-btn-soft` in
    [styles.css](../src/renderer/styles.css).
  - 지금: 프리셋 버튼(거부/이번만/이 세션 동안/항상 허용)들이 색이 강해 시선을
    과하게 끈다. 명령/diff/규칙 메타 블록도 장식이 많음.
  - 방향: 버튼 강조를 primary 1개만 남기고 나머지는 차분하게, 카드 배경·보더도
    다른 transcript 블록과 통일감 있게. (구체안은 일괄 작업 때 결정)

- [ ] **Codex transcript item 카드 톤 통일** — plan(계획)·fileChange(파일 변경)
  카드도 승인 카드와 같은 디자인 패스에서 함께 조정.
  - 위치: [Transcript.tsx](../src/renderer/workbench/Transcript.tsx) `PlanBlock`/
    `FileChangeBlock`, 스타일 `.wb-plan*`/`.wb-filechange*`/`.wb-tool-source`/
    `.wb-tool-meta` in [styles.css](../src/renderer/styles.css).
  - 지금: member-accent 헤더 + 배지가 승인 카드와 같은 화려함 계열. 톤 다운 시
    함께 맞춰야 통일감.

- [ ] **Codex 권한 설정 UI(컴포저) 디자인 수정** — 재검토 필요.
  - 위치: [CodexPermissionControl.tsx](../src/renderer/workbench/CodexPermissionControl.tsx),
    스타일 `.wb-codex-perm-*` / `.wb-codex-guardian` in
    [styles.css](../src/renderer/styles.css).
  - 지금: Send 왼편 트리거(🛡 write · ask)를 누르면 뜨는 팝오버(프리셋 세그먼트
    + sandbox/approval 드롭다운 + guardian 토글) 레이아웃을 손봐야 함.
  - 방향: 일괄 디자인 작업 때 승인 카드와 함께 톤·간격 재조정. (구체안 미정)

- [ ] **파일 드래그앤드롭 디자인 수정** — 기능은 들어갔으나 **디자인 미완**(2026-08-02 사용자 지적).
  - 위치: [Composer.tsx](../src/renderer/workbench/Composer.tsx) `onDrop`/`onDragOver` 와
    드롭 대상 표시, 스타일 `.wb-composer*` in [styles.css](../src/renderer/styles.css).
  - 지금: [P-3]10 으로 **비이미지 파일을 드롭하면 경로가 텍스트로 삽입**되고, 공백이 있는 경로는
    따옴표로 감싼다. 이미지는 기존대로 첨부 썸네일이 된다. **동작은 되지만 보이는 형태가 미완이다.**
  - **구체안 미정** — 사용자가 추후 지시. 일괄 디자인 작업 때 다룰 것.
  - 함께 볼 것: 드롭 중 피드백(어디에 놓이는지·무엇이 될지가 보이는가), 이미지/비이미지가
    **다르게 처리된다는 사실이 드롭 전에 드러나는가**, 첨부 썸네일 strip 과의 관계
    ([P-18] 대화창 이미지 복사·전체보기와 같은 첨부 표면).

## 완료

(없음)
