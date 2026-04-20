# datetime-extractor

한국어/영어 자연어에서 날짜, 기간, 시간 표현을 추출하는 TypeScript 라이브러리입니다.

- 룰 엔진을 우선 사용하고, 필요할 때만 LLM 폴백을 붙일 수 있습니다.
- 실제 날짜 계산은 결정론적 리졸버가 담당합니다.
- 한국 공휴일, 영업일, 음력 보조 데이터, 한국어 수사 표현을 다룹니다.
- 라이브러리, 백엔드 테스트 페이지, 정적 브라우저 페이지를 함께 제공합니다.

## 프로젝트 구성

- `src/`: 라이브러리 본체
- `test-page/`: Express 기반 백엔드 테스트 페이지
- `web/`: 백엔드 없이 동작하는 정적 룰 전용 페이지
- `scripts/`: 공휴일 동기화, 검증 스크립트
- `test/`: 리졸버, 룰, 골든 테스트

## 핵심 특징

- 정확도 우선: LLM은 필요 시 중간 표현 생성에만 관여하고, 실제 날짜 산술은 코드가 처리합니다.
- 빠른 경로: 룰 fast-path와 캐시 경로가 있어 일반적인 입력은 매우 빠르게 처리됩니다.
- 한국 특화: 공휴일, 영업일, 음력 기반 보조 데이터, 한국어 날짜 수사 표현을 지원합니다.
- 복수 표현 지원: 한 문장 안의 여러 날짜 표현을 동시에 반환할 수 있습니다.
- 출력 모드 조합: `single`, `range`, `list`, `business_days`, `weekdays`, `holidays`, `all`, `datetime`

## 빠른 시작

Node.js 18 이상이 필요합니다.

```bash
npm install
```

라이브러리 빌드:

```bash
npm run build
```

테스트:

```bash
npm test
npm run test:rules
npm run test:golden
npm run test:all
```

벤치마크:

```bash
npm run bench
```

## 실행 모드

### 1. 백엔드 테스트 페이지

Express 서버와 `/api/*` 엔드포인트를 사용하는 기존 테스트 페이지입니다.

```bash
npm run dev
```

- 주소: `http://localhost:3000`
- 사용 파일: `test-page/server.ts`, `test-page/public/*`
- LLM 폴백, 캐시 비우기, 예제 로딩 같은 서버 경로를 그대로 테스트할 수 있습니다.

### 2. 정적 룰 전용 페이지

백엔드 없이 브라우저에서 바로 룰 엔진을 실행하는 페이지입니다.

```bash
npm run dev:web
```

정적 미리보기:

```bash
npm run build:web
npm run preview:web
```

- Vite 루트: `web/`
- 산출물: `web-dist/`
- 주요 파일: `web/index.html`, `web/main.ts`, `web/style.css`
- 현재 프로덕션: [https://datetime-extractor.vercel.app/](https://datetime-extractor.vercel.app/)

정적 페이지 특징:

- 전체 UI가 한글로 제공됩니다.
- 각 옵션에 한글 툴팁이 붙어 있습니다.
- 하이라이트 탭 상단에 결과 요약 카드가 표시됩니다.
- LLM 관련 항목은 의도적으로 비활성화되어 있습니다.
- 공휴일/영업일 계산은 번들된 `2024~2030` 공휴일 데이터를 사용합니다.

정적 페이지 제약:

- 백엔드 API가 없습니다.
- Ollama / LLM 폴백을 사용할 수 없습니다.
- 결과 경로는 정상적으로 `rule` 또는 `cache`만 나타납니다.

## Vercel 배포

정적 페이지는 Vercel 배포용으로 이미 설정되어 있습니다.

- 설정 파일: `vercel.json`
- 빌드 명령: `npm run build:web`
- 출력 디렉터리: `web-dist`

직접 배포할 때:

```bash
npx vercel
npx vercel --prod
```

## 라이브러리 사용 예

기본 사용:

```ts
import { extract } from "datetime-extractor";

const res = await extract({
  text: "저번달 영업일",
  referenceDate: "2026-04-17",
  outputModes: ["business_days"],
});
```

복잡한 표현에만 LLM 폴백 허용:

```ts
const res = await extract({
  text: "3개월 전부터 보름 동안의 평일",
  referenceDate: "2026-04-17",
  outputModes: ["weekdays"],
  enableLLM: true,
});
```

복수 표현:

```ts
const res = await extract({
  text: "3월 4월 잔액 알려줘",
  referenceDate: "2026-04-17",
  outputModes: ["range"],
});

// res.expressions.length === 2
```

시간 포함 결과:

```ts
const res = await extract({
  text: "내일 오후 3시 회의",
  referenceDate: "2026-04-17",
  outputModes: ["datetime"],
});
```

날짜 없는 입력:

```ts
const res = await extract({
  text: "안녕하세요",
});

// res.hasDate === false
// res.expressions === []
```

`defaultToToday` 사용:

```ts
const res = await extract({
  text: "증권 계좌 잔액",
  referenceDate: "2025-11-17",
  defaultToToday: true,
});
```

## 요청 옵션 (`ExtractRequest`)

| 필드 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `text` | `string` | - | 추출 대상 자연어 |
| `referenceDate` | `string` | 오늘 | 상대 표현 기준일 |
| `timezone` | `string` | `"Asia/Seoul"` | 시간대 |
| `locale` | `"ko" \| "en" \| "auto"` | `"auto"` | 언어 힌트 |
| `outputModes` | `OutputMode[]` | 라이브러리 기본값 사용 | 결과 포맷 조합 |
| `enableLLM` | `boolean` | `false` | 부분 매칭/미매칭 시 LLM 폴백 허용 |
| `forceLLM` | `boolean` | `false` | 룰 경로를 건너뛰고 LLM만 사용 |
| `defaultToToday` | `boolean` | `false` | 날짜 미감지 시 기준일로 기본 응답 생성 |
| `ambiguityStrategy` | `"past" \| "future" \| "both"` | `"past"` | 연/월 생략 표현의 해석 방향 |
| `fiscalYearStart` | `number` | `1` | 회계연도 시작월 |
| `weekStartsOn` | `0 \| 1` | `1` | 주 시작 요일 (`0=일`, `1=월`) |
| `timePeriodBounds` | `Partial<Record<TimePeriod, TimePeriodBounds>>` | 내부 기본값 | 아침/저녁 같은 퍼지 시간 경계 오버라이드 |
| `defaultMeridiem` | `"am" \| "pm"` | 없음 | 오전/오후가 빠진 `N시` 해석 보정 |
| `dateOnlyForDateModes` | `boolean` | `true` | `single`/`range` 결과를 날짜만 유지할지 여부 |
| `contextDate` | `string` | 없음 | 직전 문맥 기준일 |
| `presentRangeEnd` | `"period" \| "today"` | `"period"` | 현재를 포함하는 기간의 종료 처리 |
| `monthBoundaryMode` | `"single" \| "range"` | `"single"` | `월말`, `연초` 같은 경계 표현 해석 방식 |
| `fuzzyDayWindow` | `number` | `3` | `N일쯤`, `이맘때` 같은 퍼지 표현의 ±일수 창 |

### 자주 쓰는 옵션

`ambiguityStrategy`

- `past`: 가장 가까운 과거로 해석
- `future`: 가장 가까운 미래로 해석
- `both`: 현재는 `past`와 동일하게 동작하며 확장 여지가 있는 모드

`presentRangeEnd`

- `period`: 이번 달, 올해 같은 표현을 기간 끝까지 반환
- `today`: 기준일까지만 잘라서 반환

`dateOnlyForDateModes`

- `true`: `single`, `range`는 시간 표현이 있어도 날짜만 반환
- `false`: 시간 표현이 있으면 ISO 8601 datetime 범위를 반환

`contextDate`

```ts
await extract({
  text: "15일 잔액",
  referenceDate: "2025-11-17",
  contextDate: "2025-06-01",
});
// -> 2025-06-15
```

## 응답 구조

`ExtractResponse`

- `hasDate`: 날짜 감지 여부
- `expressions`: 감지된 표현 목록
- `meta`: 기준일, 시간대, 경로, 지연 시간 등 메타 정보

`ExtractedExpression`

| 필드 | 타입 | 설명 |
|---|---|---|
| `text` | `string` | 감지된 원문 구간 |
| `expression` | `DateExpression` | 중간 DSL |
| `results` | `ResolvedValue[]` | 요청한 출력 모드별 결과 |
| `confidence` | `number` | 0~1 신뢰도 |
| `temporality` | `"past" \| "present" \| "future"` | 기준일 대비 위치 |
| `time` | `{ startTime, endTime, period? }` | 시간 표현이 있을 때의 평탄화 정보 |

`ResolvedValue`

- `single`
- `range`
- `list`
- `business_days`
- `weekdays`
- `holidays`
- `datetime`
- `all`

## 아키텍처

```text
입력 + referenceDate + outputModes
  ↓
[0] 캐시 조회
  ↓ miss
[1] 룰 엔진
  ├ full match -> 룰 결과 반환
  ├ partial match -> enableLLM=true 이면 LLM 보완
  └ miss -> enableLLM=true 이면 LLM 시도
  ↓
[2] 결정론적 리졸버
  ↓
[3] outputMode별 포맷
  ↓
응답 + 캐시 저장
```

핵심 원칙:

- LLM이 직접 최종 날짜를 확정하지 않습니다.
- 실제 날짜 산술과 기간 계산은 결정론적 코드가 담당합니다.

## 지원 표현 예시

절대 표현:

- `2025-12-25`, `2025/12/25`, `2025.12.25`
- `2025년 3월 1일`, `3월 1일`
- `3월`, `2025년`, `Q2 2025`

상대 표현:

- `작년`, `올해`, `내년`
- `지난달`, `이번달`, `다음달`
- `지난주`, `이번주`, `다음주`
- `3일 전`, `2주 뒤`, `3개월 전`
- `last month`, `next week`, `3 days ago`

한국어 수사:

- `하루`, `이틀`, `사흘`, `보름`

일상어:

- `어제`, `오늘`, `내일`, `모레`, `그저께`
- `yesterday`, `today`, `tomorrow`

필터 결합:

- `저번달 영업일`
- `이번 달 평일`
- `작년 공휴일`

## 공휴일 데이터

조회 순서:

1. 메모리 캐시
2. 디스크 캐시
3. 공공데이터포털 API
4. 번들 폴백 (`src/calendar/holidays-fallback.json`)

공휴일 동기화:

```bash
HOLIDAY_API_KEY=발급키 npm run sync-holidays -- 2024 2030
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `HOLIDAY_API_KEY` | 없음 | 공공데이터포털 특일 API 키 |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama 엔드포인트 |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | 폴백 LLM 모델 |

LLM 폴백을 쓰려면 먼저 Ollama를 준비해야 합니다.

```bash
ollama pull qwen2.5:3b-instruct
```

## 현재 페이지별 차이

### 백엔드 테스트 페이지

- Express 서버 기반
- `/api/extract`, `/api/cache/clear`, `/api/examples`, `/api/health`
- LLM 경로 테스트 가능
- 기존 개발용 실험 페이지

### 정적 룰 전용 페이지

- Vite + 브라우저 런타임
- API 없음
- LLM 비활성화
- 한국어 UI, 한글 툴팁, 하이라이트 결과 요약 제공
- Vercel 정적 배포에 바로 사용 가능

## 알려진 제약

- 정적 페이지에서는 LLM 폴백을 사용할 수 없습니다.
- 공휴일 번들 폴백 범위는 현재 `2024~2030`입니다.
- `timezone`은 메타에 반영되지만, 일부 실제 계산 경계는 런타임 환경 영향이 있을 수 있습니다.
- 아주 복잡한 자연어는 `enableLLM: true`가 필요한 경우가 있습니다.

## 라이선스

MIT
