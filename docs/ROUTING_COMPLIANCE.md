# 모델 × 하네스 교차 라우팅 — 라이선스·ToS 컴플라이언스

> 갱신일: 2026-07 · 상태: 참고용 정리(법률 자문 아님)
>
> 이 문서는 AgentParty가 제공자(Claude · GPT · Cursor · OpenRouter)의 모델을 여러 하네스
> (Claude Code · Codex · Cursor CLI)에 **교차**해서 실행할 때, 어떤 조합이 허용이고 어떤 조합이
> 약관 위반/고위험인지를 정리한다. 오픈소스 배포를 검토할 때의 리스크 기준선으로 쓴다.

## 판단의 핵심 축

교차가 문제가 되는지는 **"어떤 모델이냐"가 아니라 "인증 토큰이 그 제공자의 공식 클라이언트를
벗어나느냐"** 로 갈린다. 축은 둘뿐이다.

1. **인증 종류** — 구독 OAuth(Pro/Max/ChatGPT 플랜) vs API 키(BYOK).
2. **실행 하네스가 그 인증의 "공식 집"인가** — Claude 구독의 집은 Claude Code, GPT 구독의 집은
   Codex 패밀리(CLI·IDE·클라우드).

### 한 줄 규칙

```
구독 OAuth   → 그 제공자의 공식 클라이언트 하네스에만 태운다   (Claude 구독→Claude Code, GPT 구독→Codex)
API 키       → 어느 하네스든 자유                             (유일하게 "공식적으로" 안전한 교차 경로)
구독 × 남의 하네스 → 위험 지대                                (Claude 구독→Codex = 금지, GPT 구독→Claude Code = 회색)
```

## 신호등 정의

| 표시 | 의미 |
|---|---|
| 🟢 허용 | 네이티브 경로이거나 API 키 기반 — 계약상 안전 |
| 🟡 회색·묵인 | 기술적으로 작동하고 제공자가 눈감아 주지만 **공식 승인 문서가 없음**. 향후 단속 가능 |
| 🔴 금지·고위험 | 약관 명시 위반 또는 밴 이력 |
| ⚪ 미지원 | 조합이 성립하지 않음(하네스가 해당 인증/모델을 수용하지 않음) |

## 정밀 매트릭스

행 = 제공자 + 인증 종류 · 열 = 실행 하네스.

| 제공자 · 인증 | Claude Code | Codex | Cursor CLI |
|---|---|---|---|
| **Claude** · 구독(OAuth) | 🟢 네이티브·공식 | 🔴 밴 → SDK 크레딧만 | 🔴 서드파티 하네스 |
| **Claude** · API 키 | 🟢 계약상 안전 | 🟢 교차 OK | ⚪ 외부 키 미수용 |
| **GPT** · 구독(ChatGPT) | 🟡 묵인·공식 아님 | 🟢 네이티브·공식 | 🟡 묵인·공식 아님 |
| **GPT** · API 키 | 🟢 교차 OK | 🟢 네이티브·안전 | ⚪ 외부 키 미수용 |
| **Cursor** · 플랜(구독) | 🟡 MCP 릴레이(회색) | ⚪ 조합 없음 | 🟢 네이티브 |
| **OpenRouter** · API 키(BYOK) | 🟢 BYO 키 라우팅 | 🟢 BYO 키 라우팅 | ⚪ 조합 없음 |

## 케이스별 근거

### 🔴 Claude 구독 → Codex — 능동 단속 대상
- Anthropic이 2026-04 서드파티 하네스에서의 구독 OAuth 사용을 **명시 금지**.
  소비자 약관에 "봇·스크립트 등 자동화 수단 접근 금지, 예외는 공식 API 키뿐" 명문화.
- 2026-06-15 부분 완화 — **"Agent SDK 크레딧"** 이라는 별도 계량 쿼터 신설
  (Pro $20 / Max5x $100 / Max20x $200 상당, **월별·이월 없음**). 즉 정액 우회 모델은 사망,
  **공식 계량 메커니즘 경유만 합법**.
- 결론: 구독 토큰을 그대로 Codex에 넘기는 경로는 금지. 필요하면 공식 SDK 크레딧 경로를 타야 함.

### 🟡 GPT 구독 → 남의 하네스 — 묵인이지 공식 아님
- OpenAI는 Anthropic과 **비대칭**. OpenClaw 등 서드파티에 Codex OAuth를 오히려 열어줬고 밴하지 않음.
- 단 공식 인증 문서는 ChatGPT 구독 로그인을 **Codex 패밀리(CLI·IDE·클라우드) 안에서만** 지원한다고
  명시하고, 비공식/프로그래매틱 워크플로우엔 "API 키를 쓰라"고 안내.
- 결론: GPT 구독을 Claude Code/Cursor 하네스에 태우는 건 **회색(묵인)**. 금지는 아니지만 계약상
  공식 허용도 아니며 언제든 조일 수 있음. Claude 구독 쪽보다는 리스크가 확실히 낮다.

### 🟡 Cursor 플랜 → Claude Code — 앱이 실제로 하는 릴레이
- Grok 4.5(Cursor)를 MCP 릴레이로 Claude Code 하네스에 태우는 경로(현재 구현됨).
- Cursor 플랜을 비공식 클라이언트에서 사용하는 것이라 Cursor 약관상 **회색**이며,
  알려진 사면 경로가 없다. Cursor 로그인/로그아웃은 AgentParty가 아니라 Cursor CLI에서 수행.

### 🟢 API 키(BYOK) — 유일한 "공식 안전" 교차 경로
- API 키는 애초에 프로그래매틱·어디서나 쓰라고 발급하는 것. Claude/GPT/OpenRouter 키를
  어느 하네스에 태우든 인증 측면에서는 안전.
- open-codex · cc-switch · claude-code-router 같은 참고 프로젝트가 합법 지대에 머무는 이유가
  바로 **BYO 키 기본** + 앱이 구독 우회를 능동 대행하지 않기 때문.

### ⚪ 소프트웨어 라이선스 리스크 (인증과 별개 축)
- 인증과 무관하게, Anthropic **독점** Claude Code / `@anthropic-ai/claude-agent-sdk` 로
  **타사 모델**을 라우팅하는 것 자체는 소프트웨어 약관 이슈가 남는다.
  (SDK LICENSE: `© Anthropic PBC. All rights reserved`, 약관 링크 `code.claude.com/docs/en/legal-and-compliance`)
- claude-code-router 선례로 리스크는 낮게 평가되나, SDK 약관에 "경쟁 모델 라우팅/경쟁 제품 구축 금지"
  류 조항이 있는지 배포 전 확인 권장.
- Codex CLI 는 Apache-2.0 → 통합·포크·재배포 자유. MCP SDK 는 MIT → 자유.

## 하네스별 라이선스 요약

| 하네스 | 라이선스 | 포크/재배포 |
|---|---|---|
| Codex CLI | Apache-2.0 | ✅ 자유 (open-codex, just-every/code 등 합법 포크 존재) |
| MCP SDK (`@modelcontextprotocol/sdk`) | MIT | ✅ 자유 |
| Claude Code / Agent SDK | 독점(All rights reserved) | ❌ 소스 재배포 불가. 번들 시 Anthropic 약관 확인 |

## 배포 시 권장 정책

앱이 강제해야 할 인증-라우팅 매트릭스:

```
구독 인증
  Claude 구독 → Claude Code 전용            (Codex/Cursor 하네스 조합 차단  — 🔴 제거)
  GPT   구독 → Codex 전용을 기본            (Claude Code 조합은 opt-in + 회색 경고 — 🟡)
  Cursor 플랜 → Cursor CLI 전용을 기본       (Claude Code 릴레이는 실험 플래그 뒤로 — 🟡)
API 키
  Claude / GPT / OpenRouter 키 → 아무 하네스나 자유   (교차 라우팅의 기본 경로로 승격 — 🟢)
```

체크리스트:
1. **교차 라우팅 기본값을 "API 키(BYOK)"로.** 구독 크로스-하네스는 opt-in + 명시 경고.
2. **Claude 구독 × 비-Claude Code 조합은 하드 차단** 또는 공식 Agent SDK 크레딧 경로 강제.
3. **당신 코드에 라이선스 지정**(MIT 또는 Apache-2.0). 단 번들된 독점 SDK엔 적용 불가.
4. **Claude Agent SDK 재배포 가능 여부 확인** — 불가하면 사용자 로컬 설치본 호출로 전환.
5. `NOTICE` / `THIRD_PARTY_LICENSES` 로 의존성 라이선스 고지, `DISCLAIMER` 로 약관 준수 책임을
   사용자에게 명시(단, 방조 리스크를 세탁하는 용도로 의존하지 말 것).
6. 상표(Claude/Codex/Cursor/ChatGPT)는 지명적 공정 사용 수준으로만, 로고·제휴 뉘앙스 금지.

## 출처

- Anthropic Consumer Terms — https://www.anthropic.com/news/updates-to-our-consumer-terms
- Anthropic 서드파티 구독 밴 → 완화(SDK 크레딧) — VentureBeat
  https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch
- OpenAI Codex Authentication — https://learn.chatgpt.com/docs/auth
- openai/codex (Apache-2.0) — https://github.com/openai/codex
- 참고 프로젝트: open-codex(Apache-2.0), cc-switch(MIT), claude-code-router(MIT)

---

*법률 자문이 아님. 각 제공자 약관은 수시로 변경되므로 위 표는 갱신일 기준이며, 실제 배포 전
관할 지역의 IP·계약 전문 변호사 검토를 권한다. 시각화 버전은 별도 HTML 아티팩트로 존재.*
