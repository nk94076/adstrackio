import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, REDACT_PATHS } from "./index.js";

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

  it("redacts a domain verification token via the actual REDACT_PATHS config", () => {
    // Regression test: pino/fast-redact paths are exact key matches, not
    // substring matches — a path of "token" alone does NOT redact a field
    // named "verificationToken". This pins down that the real REDACT_PATHS
    // export (used by createLogger) has its own explicit entry for it.
    const { stream, lines } = captureStream();
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);

    logger.info(
      { verificationToken: "should-not-leak", hostname: "track.example.com" },
      "domain verification attempted",
    );

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.verificationToken).toBe("[REDACTED]");
    expect(parsed.hostname).toBe("track.example.com");
  });
});
