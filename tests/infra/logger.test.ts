import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/infra/logger.js";

describe("logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log info messages", () => {
    logger.configure({ level: "info", verbose: false });
    logger.info("test message");
    expect(console.error).toHaveBeenCalled();
  });

  it("should not log debug messages when level is info", () => {
    logger.configure({ level: "info", verbose: false });
    logger.debug("debug message");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("should log debug messages when level is debug", () => {
    logger.configure({ level: "debug", verbose: true });
    logger.debug("debug message");
    expect(console.error).toHaveBeenCalled();
  });

  it("should log success messages", () => {
    logger.configure({ level: "info", verbose: false });
    logger.success("success message");
    expect(console.error).toHaveBeenCalled();
  });

  it("should log warning messages", () => {
    logger.configure({ level: "warn", verbose: false });
    logger.warn("warning message");
    expect(console.warn).toHaveBeenCalled();
  });
});
