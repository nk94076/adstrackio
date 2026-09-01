import { describe, expect, it } from "vitest";
import { ApiError } from "./api-error.js";

describe("ApiError", () => {
  it("builds a consistent error body", () => {
    const error = ApiError.notFound("Campaign not found");
    expect(error.statusCode).toBe(404);
    expect(error.toBody()).toEqual({
      error: { code: "NOT_FOUND", message: "Campaign not found", details: undefined },
    });
  });

  it("carries validation details through toBody", () => {
    const error = ApiError.validation("Invalid input", { field: "email" });
    expect(error.toBody().error.details).toEqual({ field: "email" });
  });
});
