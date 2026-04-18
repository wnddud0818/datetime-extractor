import { z } from "zod";

const namedTokens = [
  "today",
  "yesterday",
  "tomorrow",
  "그저께",
  "엊그제",
  "모레",
  "글피",
  "그글피",
  "하루",
  "이틀",
  "사흘",
  "나흘",
  "닷새",
  "엿새",
  "이레",
  "여드레",
  "아흐레",
  "열흘",
  "보름",
] as const;

const filterKinds = [
  "business_days",
  "weekdays",
  "weekends",
  "holidays",
  "saturdays",
  "sundays",
] as const;

const relativeUnits = [
  "day",
  "week",
  "month",
  "quarter",
  "half",
  "year",
] as const;

const timePeriods = [
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "evening",
  "night",
  "midnight",
] as const;

const timeSpecSchema = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).optional(),
  meridiem: z.enum(["am", "pm"]).optional(),
});

export const timeOfDaySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("point"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59).optional(),
    meridiem: z.enum(["am", "pm"]).optional(),
  }),
  z.object({
    type: z.literal("range"),
    start: timeSpecSchema,
    end: timeSpecSchema,
  }),
  z.object({
    type: z.literal("period"),
    period: z.enum(timePeriods),
  }),
]);

export const absoluteSchema = z.object({
  kind: z.literal("absolute"),
  year: z.number().int().optional(),
  month: z.number().int().min(1).max(12).optional(),
  day: z.number().int().min(1).max(31).optional(),
  lunar: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  endHour: z.number().int().min(0).max(24).optional(),
  endMinute: z.number().int().min(0).max(59).optional(),
  timePeriod: z.enum(timePeriods).optional(),
});

export const relativeSchema = z.object({
  kind: z.literal("relative"),
  unit: z.enum(relativeUnits),
  offset: z.number().int(),
});

export const namedSchema = z.object({
  kind: z.literal("named"),
  name: z.enum(namedTokens),
  direction: z.enum(["past", "future"]).optional(),
});

export const dateExpressionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    absoluteSchema,
    relativeSchema,
    namedSchema,
    z.object({
      kind: z.literal("range"),
      start: dateExpressionSchema,
      end: dateExpressionSchema,
    }),
    z.object({
      kind: z.literal("filter"),
      base: dateExpressionSchema,
      filter: z.enum(filterKinds),
    }),
    z.object({
      kind: z.literal("datetime"),
      base: dateExpressionSchema,
      time: timeOfDaySchema,
    }),
  ]),
);

export const llmOutputSchema = z.object({
  expressions: z.array(
    z.object({
      text: z.string(),
      expression: dateExpressionSchema,
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
});

export type LLMOutput = z.infer<typeof llmOutputSchema>;

// JSON Schema for Ollama `format` 파라미터 (LLM에 스키마 강제)
export const ollamaJsonSchema = {
  type: "object",
  properties: {
    expressions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          expression: { type: "object" },
          confidence: { type: "number" },
        },
        required: ["text", "expression"],
      },
    },
  },
  required: ["expressions"],
} as const;
