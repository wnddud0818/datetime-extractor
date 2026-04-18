# datetime-extractor

한국어/영어 자연어 질의에서 **정확한 날짜·시간**을 추출하는 TypeScript 라이브러리.

- **정확도 최우선**: LLM은 중간 DSL만 생성하고, 실제 날짜 계산은 결정론적 리졸버가 담당 → 할루시네이션이 실제 날짜에 섞이지 않음
- **속도 최우선**: 기본은 룰 fast-path(<10ms) + LRU 캐시(<1ms), 필요할 때만 LLM 폴백(~수백 ms)
- **한국 특화**: 공공데이터포털 공휴일 + 음력 변환 + 한국어 수사 (사흘, 보름 등)
- **복수 표현**: "3월 4월 잔액" 같이 한 질의에서 여러 날짜 범위를 동시 반환
- **outputMode 선택**: single / range / list / business_days / weekdays / holidays / all 을 호출 측에서 조합 가능

## 빠른 시작

```bash
npm install
npm test          # 리졸버 단위 테스트 (15개)
npm run test:rules    # 룰 엔진 테스트 (15개)
npm run test:golden   # 골든 데이터셋 end-to-end (24개)
npm run bench     # 성능 측정
npm run dev       # 테스트 페이지 (http://localhost:3000)
```

LLM 폴백을 쓰려면 Ollama 설치 후:

```bash
ollama pull qwen2.5:3b-instruct
```

## 사용 예

```typescript
import { extract } from "datetime-extractor";

const res = await extract({
  text: "저번달 영업일",
  referenceDate: "2026-04-17",
  outputModes: ["business_days"],
});

// res.hasDate === true
// res.expressions[0].results[0].value === ["2026-03-03", "2026-03-04", ...]
// res.meta.path === "rule"  (LLM 안 씀)
// res.meta.latencyMs < 10
```

복잡한 표현에만 LLM을 opt-in:

```typescript
const res = await extract({
  text: "3개월 전부터 보름 동안의 평일",
  referenceDate: "2026-04-17",
  outputModes: ["weekdays"],
  enableLLM: true,
});
```

복수 표현:

```typescript
const res = await extract({
  text: "3월 4월 잔액 알려줘",
  referenceDate: "2026-04-17",
  outputModes: ["range"],
});
// res.expressions.length === 2
// res.expressions[0].results[0].value === { start: "2026-03-01", end: "2026-03-31" }
// res.expressions[1].results[0].value === { start: "2026-04-01", end: "2026-04-30" }
```

날짜 없는 입력:

```typescript
const res = await extract({ text: "안녕하세요" });
// res.hasDate === false
// res.expressions === []
```

`defaultToToday` 옵션 (금융/운영 도메인):

```typescript
const res = await extract({
  text: "증권 계좌 잔액",      // 날짜 표현 없음
  referenceDate: "2025-11-17",
  defaultToToday: true,
});
// res.hasDate === true
// res.expressions[0].results → { single: "2025-11-17" }
// confidence === 0  (기본값 폴백임을 시그널링)
```

"날짜 미지정 = 현재 시점"이 관습인 환경에서 사용. 명시적 날짜가 있으면 이 옵션은 무시됨.

## 요청 옵션 (`ExtractRequest`)

| 필드 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `text` | `string` | — | 추출 대상 자연어 (필수) |
| `referenceDate` | `string` (ISO) | 오늘 | 상대 표현의 기준일 |
| `timezone` | `string` | `"Asia/Seoul"` | 타임존 |
| `locale` | `"ko" \| "en" \| "auto"` | `"auto"` | 언어 힌트 |
| `outputModes` | `OutputMode[]` | `["range","single"]` | 결과 포맷 조합 |
| `enableLLM` | `boolean` | `false` | 룰이 부분 매칭/미매칭일 때만 LLM 폴백 허용 |
| `forceLLM` | `boolean` | `false` | 룰 스킵하고 LLM만 사용 |
| `defaultToToday` | `boolean` | `false` | 날짜 미감지 시 오늘로 폴백 |
| `ambiguityStrategy` | `"past" \| "future" \| "both"` | `"past"` | 연/월 생략 표현의 해석 방향 |
| `fiscalYearStart` | `number` (1~12) | `1` | 회계연도 시작월 (분기/반기 해석) |
| `weekStartsOn` | `0 \| 1` | `1` | 주 시작 요일 (0=일, 1=월) |
| `contextDate` | `string` (ISO) | — | 직전 문맥 기준일 (연/월 보간) |

### `ambiguityStrategy`

기준일 2025-11-17에서 "3월"이 주어졌을 때:
- `"past"`(기본): 2025-03 (올해 유지)
- `"future"`: 이미 지난 월이므로 2026-03
- `"both"`: `"past"`와 동일 (향후 확장)

### `fiscalYearStart`

`7`로 설정하면 1분기 = 7~9월, 상반기 = 7~12월. 기본값 1은 캘린더 연도.

### `contextDate`

앞선 문장에서 "2025년 6월"이 언급되었다면 후속 문장의 "15일"을 `contextDate: "2025-06-01"`로 넘겨 2025-06-15로 해석.

```typescript
await extract({
  text: "15일 잔액",
  referenceDate: "2025-11-17",
  contextDate: "2025-06-01",
});
// → 2025-06-15
```

## 응답 필드 (`ExtractedExpression`)

| 필드 | 타입 | 설명 |
|---|---|---|
| `text` | `string` | 매칭된 원문 구간 |
| `expression` | `DateExpression` | 중간 DSL |
| `results` | `ResolvedValue[]` | 요청한 `outputModes`별 계산 결과 |
| `confidence` | `number` | 0~1 (룰 full=1.0, 폴백=0.85, defaultToToday=0) |
| `temporality` | `"past" \| "present" \| "future"` | 기준일 대비 위치 |

`temporality` 계산 규칙:
- range 전체가 기준일보다 이전 → `past`
- range 전체가 기준일보다 이후 → `future`
- 기준일을 포함하거나 걸침 → `present`

## 아키텍처

```
입력 + referenceDate + outputModes + enableLLM?
  ↓
[0] LRU 캐시 조회 ─ hit → 즉시 반환 (<1ms)
  ↓ miss
[1a] 룰 엔진 (정규식 + 사전)
  ├ confidence 1.0 → LLM 스킵
  ├ 0.85 → enableLLM=true면 잔여를 LLM로, 아니면 룰 결과만 반환
  └ 0.0 → enableLLM=true면 전체 LLM, 아니면 hasDate=false
  ↓
[1b] Ollama LLM (폴백) — format=JSON Schema 강제 + Zod 검증
  ↓
[2] 결정론적 리졸버 (순수 TS) — 실제 날짜 계산, 공휴일 API 연동
  ↓
[3] outputMode별 포맷
  ↓
캐시에 저장 → 응답
```

**핵심 원칙**: LLM은 날짜를 직접 생성하지 않습니다. 중간 DSL(`DateExpression`)만 만들고, 실제 날짜 산술은 결정론적 코드가 수행합니다.

## 성능 (로컬 벤치, Windows, Node 22)

| 경로 | P50 | P95 |
|---|---|---|
| 캐시 hit | <0.01ms | 0.01ms |
| 룰 full_match | <0.01ms | <0.1ms |
| LLM 폴백 (qwen2.5:3b) | 실측 필요 | 실측 필요 |

## 지원 표현

### 절대
- ISO: `2025-12-25`, `2025/12/25`, `2025.12.25`
- 한국어 연월일: `2025년 3월 1일`, `3월 1일`
- 월 단독: `3월`, `3월 4월`
- 연도: `2025년`
- 음력(LLM 경유): `음력 1월 1일`

### 상대
- 연: `작년`, `올해`, `내년`, `재작년`
- 월: `저번달`, `지난달`, `이번달`, `다음달`, `지지난달`
- 주: `지난주`, `이번주`, `다음주`, `지지난주`
- 일수: `N일 전`, `N일 뒤`, `N주 전`, `N개월 뒤`
- 영어: `last month`, `next week`, `3 days ago`

### 한국어 수사
`하루, 이틀, 사흘, 나흘, 닷새, 엿새, 이레, 여드레, 아흐레, 열흘, 보름` + `전/뒤`

### 일상어
`어제, 오늘, 내일, 모레, 글피, 그글피, 그저께, 엊그제`
`yesterday, today, tomorrow`

### 필터 결합
앞 표현 + `영업일 / 평일 / 공휴일 / 주말 / 휴일` → 해당 조건의 날짜 배열
- `저번달 영업일` → 전월 영업일 배열
- `이번 달 평일` → 금월 평일 배열
- `작년 공휴일` → 작년 공휴일 목록

## 공휴일 데이터

1. 메모리 캐시 → 2. 디스크 캐시 (`~/.datetime-extractor-cache/{year}.json`) → 3. 공공데이터포털 API → 4. 번들 폴백 (`src/calendar/holidays-fallback.json`, 2024~2030)

동기화:
```bash
HOLIDAY_API_KEY=발급키 npx tsx scripts/sync-holidays.ts 2024 2030
```

## 알려진 한계 / TODO

- **LLM 경로 검증 미완료**: 기본값은 LLM 비활성화입니다. 룰 엔진이 80%+를 커버하지만, 복잡한 자연어(예: "3개월 전부터 보름 동안의 평일")는 `enableLLM: true`로 Ollama 폴백을 켜야 합니다. `ollama pull qwen2.5:3b-instruct` 후 테스트 페이지에서 실제 동작을 확인하세요. Zod 스키마 검증은 `npm run test:all`로 오프라인 확인됩니다.
- **timezone 파라미터**: 현재는 meta 반영만. 실제 날짜 연산은 로컬 TZ(개발 환경 KST 가정)에서 수행. UTC 컨테이너 배포 시 `date-fns-tz`의 `toZonedTime` 호출 추가 필요.
- **ambiguity 규칙**: 연/월 생략 표현은 `ambiguityStrategy`·`contextDate`로 제어. "지난 3월" 같은 지시어 + 월 복합 표현은 일부만 지원.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLIDAY_API_KEY` | (없음) | 공공데이터포털 특일 API 키. 없으면 번들 폴백 사용 |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama 엔드포인트 |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | 폴백 LLM 모델 |

## 테스트 페이지

`npm run dev` 실행 후 `http://localhost:3000`

- 기준 날짜 피커 (내일/사흘 전 테스트에 필수)
- outputMode 다중 선택 체크박스
- 경로 배지 (🟢 cache / 🟡 rule / 🔴 llm / 🟠 rule+llm)
- 지연 시간 breakdown (cache/rule/llm/resolver 단위)
- 골든 예제 원클릭 버튼
- "LLM 폴백 사용" 토글 — 기본 꺼짐
- "LLM 경로 강제" 토글 — 룰 스킵하고 벤치마크
- "캐시 비우기" 버튼

## 라이선스

MIT
