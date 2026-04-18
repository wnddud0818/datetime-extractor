import { describe, it, expect } from "vitest";
import { runRules } from "../src/rules/engine.js";

describe("Korean time — standalone", () => {
  it("오후 3시 → point time (base=today)", () => {
    const r = runRules("오후 3시에 만나");
    const dt = r.expressions[0];
    expect(dt.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "named", name: "today" },
      time: { type: "point", hour: 3, meridiem: "pm" },
    });
  });

  it("오전 9시 30분 → minute", () => {
    const r = runRules("오전 9시 30분 회의");
    const dt = r.expressions[0];
    expect(dt.expression).toMatchObject({
      kind: "datetime",
      time: { type: "point", hour: 9, minute: 30, meridiem: "am" },
    });
  });

  it("3시 반 → minute=30", () => {
    const r = runRules("3시 반에 가자");
    const dt = r.expressions[0];
    expect((dt.expression as any).time).toMatchObject({
      type: "point",
      hour: 3,
      minute: 30,
    });
  });

  it("15:30 → 24h parse", () => {
    const r = runRules("15:30 시작");
    const dt = r.expressions[0];
    expect((dt.expression as any).time).toMatchObject({
      type: "point",
      hour: 15,
      minute: 30,
    });
  });

  it("새벽 2시 → period가 meridiem을 am으로 결정", () => {
    const r = runRules("새벽 2시");
    const dt = r.expressions[0];
    expect((dt.expression as any).time).toMatchObject({
      type: "point",
      hour: 2,
      meridiem: "am",
    });
  });

  it("저녁 → period alone", () => {
    const r = runRules("저녁에 전화해");
    const top = r.expressions[0];
    expect((top.expression as any).time).toMatchObject({
      type: "period",
      period: "evening",
    });
  });

  it("오전 9시부터 11시까지 → range", () => {
    const r = runRules("오전 9시부터 11시까지");
    const dt = r.expressions[0];
    expect((dt.expression as any).time).toMatchObject({
      type: "range",
      start: { hour: 9, meridiem: "am" },
      end: { hour: 11, meridiem: "am" },
    });
  });
});

describe("Korean time — attached to dates", () => {
  it("내일 오후 3시 → datetime wrapping named tomorrow", () => {
    const r = runRules("내일 오후 3시 회의");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "named", name: "tomorrow" },
      time: { type: "point", hour: 3, meridiem: "pm" },
    });
  });

  it("다음주 월요일 오전 10시 → datetime wrapping weekday_in_week", () => {
    const r = runRules("다음주 월요일 오전 10시");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "weekday_in_week", weekOffset: 1, weekday: 1 },
      time: { type: "point", hour: 10, meridiem: "am" },
    });
  });

  it("오늘 저녁 → datetime with period", () => {
    const r = runRules("오늘 저녁에 만나자");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "named", name: "today" },
      time: { type: "period", period: "evening" },
    });
  });

  it("2025-12-25 오후 3시 → absolute + time", () => {
    const r = runRules("2025-12-25 오후 3시");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "absolute", year: 2025, month: 12, day: 25 },
      time: { type: "point", hour: 3, meridiem: "pm" },
    });
  });
});

describe("English time — standalone", () => {
  it("3pm → point time", () => {
    const r = runRules("meeting at 3pm");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      time: { type: "point", hour: 3, meridiem: "pm" },
    });
  });

  it("9:30 AM → minute", () => {
    const r = runRules("call at 9:30 AM");
    const top = r.expressions[0];
    expect((top.expression as any).time).toMatchObject({
      type: "point",
      hour: 9,
      minute: 30,
      meridiem: "am",
    });
  });

  it("noon → period", () => {
    const r = runRules("noon meeting");
    const top = r.expressions[0];
    expect((top.expression as any).time).toMatchObject({
      type: "period",
      period: "noon",
    });
  });

  it("from 9am to 5pm → range", () => {
    const r = runRules("from 9am to 5pm");
    const top = r.expressions[0];
    expect((top.expression as any).time).toMatchObject({
      type: "range",
      start: { hour: 9, meridiem: "am" },
      end: { hour: 5, meridiem: "pm" },
    });
  });

  it("half past 3 → minute=30", () => {
    const r = runRules("half past 3");
    const top = r.expressions[0];
    expect((top.expression as any).time).toMatchObject({
      type: "point",
      hour: 3,
      minute: 30,
    });
  });
});

describe("English time — attached to dates", () => {
  it("tomorrow morning → datetime period", () => {
    const r = runRules("tomorrow morning");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "named", name: "tomorrow" },
      time: { type: "period", period: "morning" },
    });
  });

  it("next Friday 5pm → datetime + weekday_in_week", () => {
    const r = runRules("next Friday 5pm");
    const top = r.expressions[0];
    expect(top.expression).toMatchObject({
      kind: "datetime",
      base: { kind: "weekday_in_week", weekOffset: 1, weekday: 5 },
      time: { type: "point", hour: 5, meridiem: "pm" },
    });
  });
});

describe("Time meta", () => {
  it("오후 3시 → full_match (시/분이 전부 소비됨)", () => {
    const r = runRules("오후 3시");
    expect(r.confidence).toBe(1.0);
  });

  it("내일 오후 3시 → full_match", () => {
    const r = runRules("내일 오후 3시");
    expect(r.confidence).toBe(1.0);
  });
});
