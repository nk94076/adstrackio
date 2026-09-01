import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "./index.js";

const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(32),
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  TRACKER_URL: "http://localhost:4100",
};

describe("loadEnv", () => {
  it("parses a valid environment", () => {
    const env = loadEnv(validEnv);
    expect(env.NODE_ENV).toBe("test");
    expect(env.API_PORT).toBe(4000);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    expect(() => loadEnv({ ...validEnv, AUTH_SECRET: "too-short" })).toThrow(EnvValidationError);
  });

  it("rejects the placeholder AUTH_SECRET from .env.example", () => {
    expect(() =>
      loadEnv({ ...validEnv, AUTH_SECRET: "replace-with-a-long-random-string-min-32-chars" }),
    ).toThrow(EnvValidationError);
  });

  it("rejects a non-URL APP_URL", () => {
    expect(() => loadEnv({ ...validEnv, APP_URL: "not-a-url" })).toThrow(EnvValidationError);
  });

  it("coerces numeric port strings", () => {
    const env = loadEnv({ ...validEnv, API_PORT: "5001" });
    expect(env.API_PORT).toBe(5001);
  });
});
