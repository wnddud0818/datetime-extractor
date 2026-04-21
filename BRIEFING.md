# datetime-extractor 브리핑

## 1. 기능 소개

`datetime-extractor`는 한국어와 영어 자연어 문장에서 날짜, 기간, 시간 표현을
뽑아내는 TypeScript 라이브러리입니다. 단순히 "언제"라는 단서를 찾는 수준을 넘어,
아래와 같이 입력을 구조화된 결과로 바꿉니다.

- 입력: 사용자의 자연스러운 한 문장 (예: `"저번달 영업일"`, `"내일 오후 3시 회의"`, `"next Friday 5pm"`)
- 출력: 감지된 표현 목록과, 각 표현에 대해 요청된 포맷의 확정 값
  - `single`, `range`, `list`, `business_days`, `weekdays`, `holidays`, `datetime`, `all`

핵심 설계 원칙은 "정확도 우선 + 결정론"입니다.

- 룰 엔진이 1차 해석을 담당하고, 필요할 때만 LLM이 중간 표현(DSL) 생성에 개입합니다.
- 실제 날짜 산술(월말 처리, 영업일 계산, 주/반기/분기 경계 등)은 전부 결정론적
  리졸버가 처리합니다. LLM이 최종 날짜를 직접 확정하지 않습니다.
- 한국 공휴일, 영업일, 음력 보조 데이터, `하루/이틀/사흘/보름` 같은 한국어 수사
  표현을 기본으로 지원합니다.

파이프라인은 다음과 같습니다.

```
입력 + referenceDate + outputModes
  ↓
[0] LRU 캐시
  ↓ miss
[1] 룰 엔진 (한국어/영어 패턴, 시간 패턴, 로케일 감지)
  ├ full match  → 룰 결과 사용
  ├ partial     → enableLLM 이면 LLM 보완
  └ miss        → enableLLM 이면 LLM 시도
  ↓
[2] 결정론적 리졸버 (모호성/공휴일/음력 포함)
  ↓
[3] outputMode 포맷팅
  ↓
응답 + 캐시 저장
```

## 2. 제공 형태 두 가지

| 구분 | 실행 방식 | 용도 |
|---|---|---|
| 백엔드 테스트 페이지 | `npm run dev` (Express + `/api/*`) | LLM 폴백, 캐시 초기화 등 서버 경로까지 확인 |
| 정적 룰 전용 페이지 | `npm run dev:web` / `build:web` (Vite, 번들 산출물 `web-dist/`) | 백엔드 없이 브라우저에서 바로 룰 엔진 실행, Vercel 정적 배포 |

현재 프로덕션 배포는 정적 페이지입니다: <https://datetime-extractor.vercel.app/>

## 3. "정적 페이지"에서만 가능한 것과 결과

정적 페이지는 의도적으로 "룰 엔진만" 동작하도록 구성되어 있습니다. 이 제약은 배포
특성(서버 없음)을 그대로 반영한 것입니다.

### 가능한 것

- 브라우저에서 즉시 추출 실행, API 왕복 없음.
- 전체 UI가 한국어로 제공되며, 모든 옵션에 한글 툴팁이 붙어 있습니다.
- 상세 옵션을 그대로 조정 가능:
  - `ambiguityStrategy` (past/future/both)
  - `defaultMeridiem` (없음/am/pm)
  - `fiscalYearStart`, `weekStartsOn`
  - `contextDate`, `presentRangeEnd`, `dateOnlyForDateModes`, `defaultToToday`
- 결과 탭 세 가지를 즉시 확인:
  - **하이라이트**: 원문 중 어떤 구간이 날짜로 잡혔는지, 상단에 결과 요약 카드 제공.
  - **DSL**: 룰 엔진이 만든 중간 `DateExpression` JSON.
  - **해석 결과**: 최종 계산된 날짜/기간/시간 JSON.
- 공휴일/영업일 계산은 번들된 `2024–2030` 공휴일 데이터(`src/calendar/holidays-fallback.json`)로 수행.

### 제약

- 백엔드 API가 없음 → `/api/extract`, `/api/cache/clear` 경로 없음.
- **LLM 폴백 사용 불가**: `enableLLM`, `forceLLM` 옵션은 비활성(disabled) 상태로 표시하여 제한을 명시.
- 실행 경로(meta.path)는 항상 `rule` 또는 `cache`만 나타납니다. 이는 정상 동작입니다.
- 공휴일 데이터 범위(`2024–2030`)를 벗어난 영업일/공휴일 질의는 명시적 오류를 반환합니다.

### 결과(정확도)

현재 저장소의 벤치마크 리포트(모두 `benchmarks/reports/`) 기준, 룰 전용 경로만으로도
대부분의 일상적 표현을 무손실에 가깝게 처리합니다.

| 벤치마크 | 총 케이스 | 통과 | 정확도 |
|---|---|---|---|
| datetime-eval-suite (rule-only) | 1,127 | — | 세부 카테고리 전부 100% (참고: `datetime-eval-rule-only-report.json`) |
| humanlike-500 | 500 | 500 | 100% |
| date-diversity-500 | 500 | 500 | 100% |
| realistic-rule-benchmark | 1,150 | 1,145 | 99.6% |

즉, **정적 페이지에서도 동일한 룰 엔진이 그대로 돌기 때문에 품질 차이는 없고,
LLM이 필요할 만큼 복잡하거나 비정형적인 문장에서만 해석이 제한**됩니다.

## 4. 라이브러리 관점에서의 결과물

정적 페이지와 별개로, 라이브러리 자체는 npm 패키지 형태로 사용됩니다.

```ts
import { extract } from "datetime-extractor";

const res = await extract({
  text: "저번달 영업일",
  referenceDate: "2026-04-17",
  outputModes: ["business_days"],
});
```

응답(`ExtractResponse`) 구조의 주요 필드:

- `hasDate`: 날짜 감지 여부
- `expressions[]`: 감지된 표현 목록 (원문 구간, 중간 DSL, 모드별 결과, 신뢰도, 과거/현재/미래, 시간 평탄화 정보)
- `meta`: 기준일, 시간대, 처리 경로(`rule`/`cache`/`llm`), 지연 시간 등

지원 표현의 예:

- 절대: `2025-12-25`, `2025년 3월 1일`, `Q2 2025`
- 상대: `지난달`, `3일 전`, `2주 뒤`, `next week`
- 한국어 수사: `하루`, `이틀`, `사흘`, `보름`
- 필터 결합: `저번달 영업일`, `이번 달 평일`, `작년 공휴일`
- 복수 표현: `"3월 4월 잔액 알려줘"` → 두 개의 `expression` 반환
- 시간 포함: `"내일 오후 3시 회의"` → `datetime` 모드에서 ISO 범위 반환

## 5. AI 도구를 어떻게 써서 개발했는가

본 프로젝트는 "정적 페이지에서 LLM을 끄는" 쪽이지만, 라이브러리 자체의 설계는
LLM을 "보조 도구"로만 배치하고 있으며, 개발 과정 전반에서도 AI 도구를 적극적으로
활용했습니다.

### 제품 내부에서의 AI 활용 방식 (런타임)

- **LLM 폴백은 선택 기능**: `enableLLM: true`일 때만 룰이 못 잡는 표현을 LLM이 보완합니다.
- **LLM은 중간 표현(DSL)까지만 생성**: 날짜 산술은 `src/resolver/*`가 전담하므로 모델 환각이 최종 값에 섞이지 않습니다.
- **로컬 오픈소스 모델 기준**: 기본 Ollama + `qwen2.5:3b-instruct`를 상정해 경량·프라이버시 지향.
  - 환경 변수: `OLLAMA_HOST`, `OLLAMA_MODEL`
  - 관련 파일: `src/extractor/ollama-client.ts`, `prompt.ts`, `schema.ts`
- **Zod 스키마로 LLM 응답 검증**: 모델 출력은 스키마 검증을 통과한 경우에만 리졸버에 전달됩니다.
- **기본값은 룰 경로 우선**: `enableLLM`은 기본 `false`. LLM이 꺼져 있어도 품질이 유지되도록 룰 엔진을 의도적으로 크게 투자했습니다.

### 개발 워크플로에서의 AI 도구 활용

- **Claude Code / Codex 기반 개발**: 저장소에 `AGENTS.md`, `CLAUDE.md`가 포함되어 있고,
  커밋 로그에는 `codex/vercel-static-rule-page` 등 AI 에이전트가 진행한 작업 브랜치가
  그대로 남아 있습니다. 규칙 패턴 확장, 벤치마크 리포트 정비, 정적 페이지 한글화 등
  여러 작업이 이 방식으로 반복 개발되었습니다.
- **룰 커버리지의 LLM-주도 확장**: 벤치마크 실패 케이스를 LLM으로 유형화한 뒤
  결정론 룰(`src/rules/patterns.ts`, `patterns-en.ts`, `time-patterns.ts`, `numerals.ts`)로
  이식하는 루프를 반복해 rule-only 정확도를 올렸습니다.
- **벤치마크 데이터셋 생성**: `benchmarks/datasets/humanlike-500.*`,
  `date-diversity-500.json`, `datetime-eval-suite.json` 등 대규모 데이터셋은 LLM로
  초안을 만들고 사람이 검수·수정하는 방식으로 구축했습니다.
  실행 스크립트는 `benchmarks/scripts/bench.ts` 한 파일로 통합되어 있어,
  `npm run bench`, `npm run bench:humanlike`, `npm run bench:date-diversity`
  같은 명령으로 회귀 측정이 가능합니다.
- **골든 테스트 + 룰 회귀 테스트**: `test/golden.test.ts`, `test/rules.test.ts`는
  LLM이 잡아내기 쉬운 "애매한 한국어 날짜 표현"에 대해 회귀 방지 역할을 하며,
  AI 도구가 만든 패치가 기존 동작을 깨지 않는지 빠르게 검증합니다.
- **커밋 규약**: 이 저장소는 커밋 메시지를 한국어로 작성하도록 `CLAUDE.md`/`AGENTS.md`에
  명시되어 있어, AI 에이전트가 만드는 커밋도 동일 규칙을 따릅니다.

### 요약 한 줄

> "LLM은 어렵고 드문 케이스에서만 쓰고, 정확도는 룰과 결정론 리졸버로 보장한다.
> 개발 과정에서는 AI 도구로 룰을 확장하고 대규모 벤치마크를 돌려 회귀를 막는다."

## 6. 브리핑 포인트 (발표용 요약)

1. **무엇**: 한국어/영어 자연어에서 날짜·기간·시간을 구조화해 뽑아주는 라이브러리.
2. **왜 신뢰 가능**: LLM은 중간 표현까지, 최종 날짜 계산은 결정론 코드가 담당.
3. **어떻게 배포**: 백엔드 테스트 페이지 + 브라우저 정적 룰 전용 페이지(Vercel).
4. **정적 페이지의 결과**: LLM은 꺼져 있어도, 주요 벤치마크 기준 사실상 100%대 정확도.
   경로는 항상 `rule` 또는 `cache`.
5. **AI 도구 활용**: 런타임에서는 선택적 LLM 폴백 + Zod 검증,
   개발에서는 AI 에이전트로 룰 확장·벤치마크 생성·회귀 테스트 루프를 반복.
