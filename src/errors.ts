export type ExtractValidationField =
  | "referenceDate"
  | "contextDate"
  | "timezone";

class DatetimeExtractorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ExtractValidationError extends DatetimeExtractorError {
  readonly code = "INVALID_REQUEST";

  constructor(
    public readonly field: ExtractValidationField,
    public readonly received: string,
    message?: string,
  ) {
    super(
      message ??
        `Invalid ${field}: expected a valid value, received "${received}".`,
    );
  }
}

export class HolidayDataUnavailableError extends DatetimeExtractorError {
  readonly code = "HOLIDAY_DATA_UNAVAILABLE";

  constructor(
    public readonly year: number,
    message?: string,
  ) {
    super(
      message ??
        `Holiday data for ${year} is unavailable. Configure HOLIDAY_API_KEY or update the bundled holiday data.`,
    );
  }
}
