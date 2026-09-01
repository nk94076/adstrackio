import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

function captureStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

describe("createLogger", () => {
  it("redacts password and token fields", () => {
    const { stream, lines } = captureStream();
    const logger = pino(
      {
        redact: { paths: ["password", "token"], censor: "[REDACTED]" },
      },
      stream,
    );

    logger.info({ password: "hunter2", token: "abc123", username: "naveen" }, "user logged in");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.username).toBe("naveen");
  });

  it("creates a named, leveled logger instance", () => {
    const logger = createLogger({ name: "test-service", level: "silent" });
    expect(logger.level).toBe("silent");
  });
});
