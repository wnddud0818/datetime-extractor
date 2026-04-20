import { describe, expect, it } from "vitest";
import { extract, HolidayDataUnavailableError } from "../src/index.js";

describe("holiday data availability", () => {
  it("단순 날짜 추출은 공휴일 데이터 범위 밖 연도에서도 동작한다", async () => {
    const res = await extract({
      text: "내일",
      referenceDate: "2031-06-01",
      outputModes: ["single"],
    });

    expect(res.hasDate).toBe(true);
    expect(res.expressions[0].results[0]).toEqual({
      mode: "single",
      value: "2031-06-02",
    });
  });

  it("공휴일 목록이 필요한 요청은 데이터가 없으면 명시적으로 실패한다", async () => {
    await expect(
      extract({
        text: "2031년 공휴일",
        referenceDate: "2031-06-01",
        outputModes: ["holidays"],
      }),
    ).rejects.toBeInstanceOf(HolidayDataUnavailableError);
  });

  it("다음 공휴일처럼 공휴일 달력을 직접 참조하는 표현도 명시적으로 실패한다", async () => {
    await expect(
      extract({
        text: "다음 공휴일",
        referenceDate: "2030-12-31",
        outputModes: ["single"],
      }),
    ).rejects.toMatchObject({
      code: "HOLIDAY_DATA_UNAVAILABLE",
      year: 2031,
    });
  });
});
