export const SYSTEM_PROMPT = `당신은 한국어/영어 자연어에서 날짜·시간 표현을 추출하여 표준 DSL JSON으로 변환하는 전문가입니다.

## 출력 규칙
- 반드시 다음 JSON 스키마에 맞춰 응답합니다:
  {"expressions": [{"text": "원문 조각", "expression": {...DateExpression}, "confidence": 0~1}]}
- 날짜 표현이 없으면 {"expressions": []} 를 반환합니다.
- **실제 날짜를 직접 계산하지 마세요.** 중간 DSL만 만드세요. 실제 날짜 계산은 별도 엔진이 담당합니다.

## DateExpression 종류
1. absolute: {"kind":"absolute", "year"?, "month"?, "day"?, "lunar"?, "hour"?, "minute"?}
2. relative: {"kind":"relative", "unit":"day|week|month|quarter|half|year", "offset":정수}
   - 음수: 과거, 0: 현재 기준, 양수: 미래
3. named: {"kind":"named", "name":NamedToken, "direction":"past|future"?}
   - NamedToken: today, yesterday, tomorrow, 그저께, 엊그제, 모레, 글피, 그글피, 하루, 이틀, 사흘, 나흘, 닷새, 엿새, 이레, 여드레, 아흐레, 열흘, 보름
4. range: {"kind":"range", "start":DateExpression, "end":DateExpression}
5. filter: {"kind":"filter", "base":DateExpression, "filter":"business_days|weekdays|weekends|holidays|saturdays|sundays"}
6. datetime: {"kind":"datetime", "base":DateExpression, "time":TimeOfDay}
   - 날짜 표현에 시간을 덧씌울 때 사용. base는 임의의 DateExpression.
   - TimeOfDay 형태:
     - point: {"type":"point", "hour":0-23, "minute"?:0-59, "meridiem"?:"am|pm"}
     - range: {"type":"range", "start":{"hour","minute"?,"meridiem"?}, "end":{"hour","minute"?,"meridiem"?}}
     - period: {"type":"period", "period":"dawn|morning|noon|afternoon|evening|night|midnight"}
   - 오전→am, 오후→pm. 새벽→am, 아침→morning, 점심/정오→noon, 저녁→evening, 밤→night, 자정→midnight.
   - "3시 반" → minute=30. "오전 9시 30분" → hour=9, minute=30, meridiem=am.
   - 시간만 있고 날짜가 없으면 base는 {"kind":"named","name":"today"}.

## 한국어 수사 매핑 (참고만 — 계산은 엔진이 함)
- 사흘=3일, 나흘=4일, 닷새=5일, 엿새=6일, 이레=7일, 여드레=8일, 아흐레=9일, 열흘=10일, 보름=15일
- "사흘 전" → {"kind":"named","name":"사흘","direction":"past"}

## 상대 기간 매핑
- 저번달/지난달 → relative month offset=-1
- 이번달 → relative month offset=0
- 다음달 → relative month offset=1
- 작년 → relative year offset=-1
- 올해 → relative year offset=0
- 내년 → relative year offset=1
- 지난주 → relative week offset=-1
- 이번주 → relative week offset=0
- 다음주 → relative week offset=1

## 복수 표현
한 문장에 여러 날짜 표현이 있으면 모두 expressions 배열에 넣습니다.
예: "3월 4월 잔액" → [{"text":"3월","expression":{"kind":"absolute","month":3}}, {"text":"4월","expression":{"kind":"absolute","month":4}}]

## 필터 결합
"저번달 영업일" → {"kind":"filter","base":{"kind":"relative","unit":"month","offset":-1},"filter":"business_days"}
"이번 달 평일" → {"kind":"filter","base":{"kind":"relative","unit":"month","offset":0},"filter":"weekdays"}
"작년 공휴일" → {"kind":"filter","base":{"kind":"relative","unit":"year","offset":-1},"filter":"holidays"}

## 영어
"yesterday" → named yesterday
"last month" → relative month offset=-1
"next week" → relative week offset=1
"3 days ago" → relative day offset=-3
"Q2 2025" → quarter q=2 year=2025
"first half of 2024" → half 1 year=2024
"H1 2025" → half 1 year=2025
"past 30 days" → duration day amount=30 direction=past
"March 15, 2025" → absolute year=2025 month=3 day=15
"3/15/2025" → absolute year=2025 month=3 day=15 (미국식 M/D/Y)
"in 5 days" → relative day offset=5
"day after tomorrow" → named "모레"
"day before yesterday" → named "그저께"
"fortnight ago" → named "보름" direction=past
"next Monday" → weekday_in_week weekOffset=1 weekday=1
"business days" suffix → filter business_days
"weekdays" suffix → filter weekdays
"holidays" suffix → filter holidays

날짜 형식이 모호한 "3/1"처럼 연도가 없는 슬래시 표기는 미국식(M/D)로 해석.
`;

export const FEW_SHOT_EXAMPLES = [
  {
    user: "저번 달 잔액 알려줘",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "저번 달",
          expression: { kind: "relative", unit: "month", offset: -1 },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "3월 4월 잔액 알려줘",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "3월",
          expression: { kind: "absolute", month: 3 },
          confidence: 1.0,
        },
        {
          text: "4월",
          expression: { kind: "absolute", month: 4 },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "사흘 전 날씨",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "사흘 전",
          expression: { kind: "named", name: "사흘", direction: "past" },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "저번달 영업일",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "저번달 영업일",
          expression: {
            kind: "filter",
            base: { kind: "relative", unit: "month", offset: -1 },
            filter: "business_days",
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "작년 공휴일",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "작년 공휴일",
          expression: {
            kind: "filter",
            base: { kind: "relative", unit: "year", offset: -1 },
            filter: "holidays",
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "3개월 전부터 보름 동안의 평일",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "3개월 전부터 보름 동안의 평일",
          expression: {
            kind: "filter",
            base: {
              kind: "range",
              start: { kind: "relative", unit: "month", offset: -3 },
              end: { kind: "named", name: "보름", direction: "future" },
            },
            filter: "weekdays",
          },
          confidence: 0.8,
        },
      ],
    }),
  },
  {
    user: "안녕하세요",
    assistant: JSON.stringify({ expressions: [] }),
  },
  {
    user: "2025-12-25 매출",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "2025-12-25",
          expression: {
            kind: "absolute",
            year: 2025,
            month: 12,
            day: 25,
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "last Monday sales",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "last Monday",
          expression: { kind: "weekday_in_week", weekOffset: -1, weekday: 1 },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "Q2 2025 revenue",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "Q2 2025",
          expression: { kind: "quarter", quarter: 2, year: 2025 },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "first half of 2024",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "first half of 2024",
          expression: { kind: "half", half: 1, year: 2024 },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "past 30 days sales",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "past 30 days",
          expression: {
            kind: "duration",
            unit: "day",
            amount: 30,
            direction: "past",
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "March 15, 2025 meeting",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "March 15, 2025",
          expression: {
            kind: "absolute",
            year: 2025,
            month: 3,
            day: 15,
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "next month business days",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "next month business days",
          expression: {
            kind: "filter",
            base: { kind: "relative", unit: "month", offset: 1 },
            filter: "business_days",
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "day after tomorrow appointment",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "day after tomorrow",
          expression: { kind: "named", name: "모레" },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "내일 오후 3시 회의",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "내일 오후 3시",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "tomorrow" },
            time: { type: "point", hour: 3, meridiem: "pm" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "다음주 월요일 오전 9시 30분",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "다음주 월요일 오전 9시 30분",
          expression: {
            kind: "datetime",
            base: { kind: "weekday_in_week", weekOffset: 1, weekday: 1 },
            time: { type: "point", hour: 9, minute: 30, meridiem: "am" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "오늘 저녁 약속",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "오늘 저녁",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "today" },
            time: { type: "period", period: "evening" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "새벽 2시",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "새벽 2시",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "today" },
            time: { type: "point", hour: 2, meridiem: "am" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "오전 9시부터 11시까지",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "오전 9시부터 11시까지",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "today" },
            time: {
              type: "range",
              start: { hour: 9, meridiem: "am" },
              end: { hour: 11, meridiem: "am" },
            },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "3시 반에 만나",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "3시 반",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "today" },
            time: { type: "point", hour: 3, minute: 30 },
          },
          confidence: 0.9,
        },
      ],
    }),
  },
  {
    user: "next Monday at 3pm",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "next Monday at 3pm",
          expression: {
            kind: "datetime",
            base: { kind: "weekday_in_week", weekOffset: 1, weekday: 1 },
            time: { type: "point", hour: 3, meridiem: "pm" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "tomorrow morning",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "tomorrow morning",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "tomorrow" },
            time: { type: "period", period: "morning" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "from 9am to 5pm today",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "from 9am to 5pm today",
          expression: {
            kind: "datetime",
            base: { kind: "named", name: "today" },
            time: {
              type: "range",
              start: { hour: 9, meridiem: "am" },
              end: { hour: 5, meridiem: "pm" },
            },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
  {
    user: "2025-12-25 오후 3시 30분 미팅",
    assistant: JSON.stringify({
      expressions: [
        {
          text: "2025-12-25 오후 3시 30분",
          expression: {
            kind: "datetime",
            base: { kind: "absolute", year: 2025, month: 12, day: 25 },
            time: { type: "point", hour: 3, minute: 30, meridiem: "pm" },
          },
          confidence: 1.0,
        },
      ],
    }),
  },
];
