# 사용자 노출 문자열 전수 조사와 다국어화 가능성

조사 기준: 2026-08-19, `v0.2.1` 소스

## 결론

다국어화할 수 있다. 현재 구조가 다국어화를 막고 있지는 않지만, 문자열이 한곳에 모여 있지 않아서 먼저 메시지 ID와 로케일 저장소를 도입해야 한다.

화면의 고정 문구만 바꾸는 작업은 비교적 단순하다. 어려운 부분은 다음 세 가지다.

1. 앱이 만든 상태·오류 문구 일부가 대화 기록에 완성된 문자열로 저장된다.
2. 백엔드가 사용자 안내와 로그 문구를 같은 문자열 형태로 전달하는 곳이 있다.
3. 외부 CLI와 모델이 보낸 오류 원문은 앱이 번역하면 안 된다.

따라서 번역 대상과 원문 보존 대상을 먼저 나눈 뒤 단계적으로 옮기는 것이 안전하다.

## 수집 결과

전체 목록: [`user-facing-strings-excel.csv`](user-facing-strings-excel.csv)

CSV는 한국어 Windows의 Excel에서 바로 열 수 있도록 UTF-8 BOM으로 생성한다.

| 구분 | 위치 수 | 의미 |
|---|---:|---|
| `renderer-ui` | 779 | JSX 본문, 제목, 도움말, placeholder 등 화면 노출이 확실한 문구 |
| `renderer-candidate` | 761 | 조건부 문구, 상수, 상태 매핑, 데모 데이터 등 렌더러의 노출 후보 |
| `renderer-html` | 1 | HTML 문서 제목 |
| `guide-knowledge` | 384 | 가이드 채팅이 답변 근거로 읽는 문서 |
| `backend-message` | 367 | core/main에서 만들어지는 오류·진단·상태·로그 후보 |
| `shared-presentation` | 232 | 가이드, 승인, 사용 한도 등 여러 프로세스가 함께 쓰는 표시 문구 |
| `model-catalog` | 51 | 모델 카탈로그의 이름·설명 |
| **합계** | **2,575** | 97개 파일, 중복 제거 시 2,087종 |

- 노출 확실성이 높은 항목: 1,215개
- 사람이 용도를 확인해야 하는 항목: 1,360개
- 값이 문장 안에 들어가는 템플릿: 265개
- 한글이 포함된 항목: 2,033개
- 한글이 없는 항목: 542개

`medium` 항목에는 누락 방지를 위해 로그 전용 문구나 데모 데이터가 일부 포함되어 있다. 실제 번역 파일로 옮길 때는 각 항목을 `translate`, `keep-raw`, `internal-only`, `fixture` 중 하나로 확정해야 한다.

## 목록 읽는 법

CSV의 각 행은 문자열 한 종류가 아니라 **소스의 한 위치**다. 같은 `닫기`라도 화면 맥락이 다르면 다른 번역이 필요할 수 있으므로 자동으로 합치지 않았다.

| 열 | 설명 |
|---|---|
| `id` | 조사용 임시 ID. 제품의 최종 메시지 ID가 아님 |
| `surface` | 문자열이 나오는 영역 |
| `confidence` | `high`는 직접 노출, `medium`은 확인 필요 |
| `kind` | JSX 본문·속성·템플릿·Markdown·JSON 등 원본 형태 |
| `file`, `line` | 원본 위치 |
| `pointer` | JSON 항목의 경로 |
| `text` | 현재 문자열. `${…}`는 동적으로 들어가는 값 |

목록은 다음 명령으로 다시 만들 수 있다.

```powershell
node scripts/audit-user-facing-strings.cjs
```

## 현재 문자열이 생기는 경로

### 1. 렌더러에 직접 적힌 문구

버튼, 제목, 빈 화면, 설정 설명이 각 컴포넌트에 직접 들어 있다. 대표적으로 다음 파일의 비중이 크다.

- `src/renderer/app/secondaryViews.tsx`
- `src/renderer/app/MobileLinkTab.tsx`
- `src/renderer/workbench/Transcript.tsx`
- `src/renderer/usage/TokenUsageView.tsx`
- `src/renderer/workbench/ModelCatalogModal.tsx`
- `src/renderer/workbench/MemberWizard.tsx`

이 영역은 `t("...")` 형태로 옮기기 쉽다. React Context나 전용 hook으로 현재 언어를 공급하면 실행 중 언어 변경도 가능하다.

### 2. shared의 표시용 상수

가이드 슬라이드, 권한 선택지, 사용 한도 이름, 모델 설명처럼 main과 renderer가 함께 보는 값이다. 표시 문자열을 도메인 값과 분리해야 한다.

예:

```ts
// 현재 형태
{ id: "once", label: "이번만 허용" }

// 권장 형태
{ id: "once", labelKey: "approval.once" }
```

도메인 계층은 `once`만 알고, 화면에서 현재 언어로 `approval.once`를 해석하는 편이 안전하다.

### 3. core/main에서 만든 오류와 진단

어댑터가 `title`, `detail`, `recovery`를 완성된 문장으로 만들어 렌더러에 보낸다. 알려진 앱 오류는 문자열 대신 다음처럼 전달해야 한다.

```ts
{
  code: "usage.read_failed",
  params: { provider: "codex" },
  rawDetail: providerMessage,
}
```

- `code`, `params`: 앱이 번역
- `rawDetail`: 공급자·CLI의 원문이므로 그대로 표시
- 로그: 원문과 구조화된 code를 함께 기록

이렇게 해야 오류 원인을 숨기지 않으면서 UI만 자연스럽게 번역할 수 있다.

### 4. 대화 기록에 저장되는 앱 생성 문구

현재 `status`, `turn complete`, 압축 결과, 진단 일부는 화면에 표시될 문자열 형태로 transcript에 들어간다. 이 상태로 언어만 바꾸면 예전에 저장된 기록은 이전 언어로 남는다.

앱이 생성한 블록은 최종 문자열 대신 아래 정보를 저장해야 한다.

```ts
{
  kind: "appMessage",
  messageId: "turn.completed",
  values: { cost: "$0.03" },
}
```

사용자 입력, 모델 답변, 도구 출력, 명령 원문은 번역하지 않는다. 기존 저장 데이터는 그대로 읽고, 새 형식만 추가하는 하위 호환 방식이 적절하다.

### 5. 가이드 지식 문서

`guide/knowledge/*.md`는 화면에 그대로 그려지는 문구는 아니지만 가이드 답변의 근거다. UI만 영어로 바꾸고 이 문서를 한국어로 두면 가이드 채팅은 계속 한국어로 답할 수 있다.

권장 구조:

```text
guide/knowledge/ko/*.md
guide/knowledge/en/*.md
```

가이드 모델을 호출할 때 선택한 locale의 문서만 검색하도록 해야 한다. 문서별 파일명은 같게 유지하면 라우팅 코드 변경을 줄일 수 있다.

### 6. 모델 카탈로그

모델 ID와 공급자 이름은 번역하지 않는다. 사람이 읽는 설명만 `descriptionKey`로 분리하거나 locale별 설명 객체로 둔다.

가격, 컨텍스트 크기, 모델 ID 같은 데이터는 번역 문자열에 넣지 말고 `Intl.NumberFormat`으로 표시한다.

## 번역하지 않아야 하는 것

- 사용자 입력과 멤버 간 메시지
- 모델 응답과 reasoning 원문
- 명령어, 파일 경로, diff, 도구 출력
- 모델 ID, 공급자 ID, MCP 도구 이름
- 외부 CLI·API가 반환한 원시 오류
- 로그의 구조화 필드와 프로토콜 값

이 값들은 주변 제목과 행동 버튼만 번역하고 원문은 별도 영역에 유지한다.

## 권장 구현 순서

### 1단계: 기반과 고정 UI

- `Locale` 타입과 설정 저장 추가
- `ko`, `en` 메시지 카탈로그 추가
- renderer용 `useI18n()` 또는 검증된 i18n 라이브러리 연결
- 날짜·숫자·비용·복수형을 `Intl` 기반 formatter로 통일
- `renderer-ui` 779개부터 이동

이 단계만 끝내도 일반 화면 대부분은 언어를 바꿀 수 있다.

### 2단계: shared 표시 값과 템플릿

- 상태/권한/승인/사용 한도 매핑을 message ID로 변경
- 265개 동적 문장을 ICU 스타일 변수와 복수형으로 이동
- 문자열 이어 붙이기와 삼항 연산자로 만든 문장을 formatter 함수로 교체

한국어에는 자연스럽지만 영어에서 순서를 바꿔야 하는 문장이 있으므로, 문장 조각을 번역해 이어 붙이는 방식은 피해야 한다.

### 3단계: 오류·진단·대화 기록

- 알려진 오류를 `code + params + rawDetail`로 구조화
- 앱 생성 transcript 블록에 `messageId + values` 추가
- 기존 저장 기록과 API 응답의 하위 호환 유지
- 로그 전용 문자열과 사용자 안내 문자열 분리

이 단계가 끝나야 언어 전환 후 기존 화면과 새 이벤트가 섞이지 않는다.

### 4단계: 가이드와 카탈로그

- locale별 가이드 문서 분리
- 모델 설명 번역
- 가이드 채팅에 현재 locale 전달

## 구현 시 함께 필요한 제품 변경

언어 선택은 사용자 기능이므로 UI와 로컬 자동화 HTTP API가 같은 `AppController` 메서드를 사용해야 한다. route table에 한 번 등록하고 `GET /api/spec`, 모바일 링크 메서드, `docs/API.md`를 함께 갱신해야 한다.

권장 API 형태:

```text
GET  /api/settings/locale
PUT  /api/settings/locale  { "locale": "ko" | "en" }
```

지원하지 않는 locale은 자동 대체하지 말고 명시적인 오류를 반환하는 편이 현재 프로젝트 원칙과 맞다.

## 검증 방법

- 사전에 없는 message ID가 있으면 개발/QA 빌드에서 눈에 보이게 실패
- 긴 문자열을 만드는 pseudo-locale로 잘림·오버플로 검사
- 소스에 새 한글/영문 UI 리터럴이 추가되면 CI에서 목록 변화 감지
- 실제 앱을 실행해 인증, 런타임, 멤버 생성, 대화, 오류, 모바일, 가이드 화면을 locale별로 E2E 확인
- 기존 transcript를 연 상태에서 언어를 바꿔 하위 호환 확인
- 숫자·날짜·비용·복수형을 `ko-KR`, `en-US`에서 각각 확인

## 조사 범위와 한계

수집기는 누락을 줄이는 쪽으로 설계했다. 그래서 `medium`에는 실제로는 로그 전용인 문구나 데모 데이터가 들어갈 수 있다. 반대로 다음 값은 정적으로 모두 열거할 수 없다.

- 공급자와 CLI가 실행 중 반환하는 오류
- 모델이 만든 답변
- 사용자의 프로젝트 파일과 명령 출력
- 서버에서 나중에 내려오는 모델 설명

이 값들은 번역 목록에 넣는 대신 원문 데이터로 취급해야 한다. 앱이 직접 작성한 제목, 설명, 복구 행동만 메시지 ID로 관리하면 된다.
