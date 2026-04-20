import { describe, expect, it } from "vitest";
import { extract, ExtractValidationError } from "../src/index.js";

describe("input validation", () => {
  it("잘못된 referenceDate는 명시적 validation error를 던진다", async () => {
    await expect(
      extract({
        text: "내일",
        referenceDate: "not-a-date",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      field: "referenceDate",
    });
  });

  it("잘못된 timezone은 명시적 validation error를 던진다", async () => {
    await expect(
      extract({
        text: "내일",
        timezone: "Mars/Olympus",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      field: "timezone",
    });
  });

  it("잘못된 contextDate도 validation error를 던진다", async () => {
    await expect(
      extract({
        text: "15일",
        referenceDate: "2025-11-17",
        contextDate: "2025-02-30",
      }),
    ).rejects.toBeInstanceOf(ExtractValidationError);
  });
});
