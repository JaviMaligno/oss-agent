import { describe, it, expect } from "vitest";
import { ConfigSchema, AIConfigSchema, BudgetConfigSchema } from "../../src/types/config.js";

describe("ConfigSchema", () => {
  it("should parse empty config with defaults", () => {
    const result = ConfigSchema.parse({});

    expect(result.mode).toBe("oss");
    expect(result.ai.provider).toBe("claude");
    expect(result.ai.model).toBe("claude-sonnet-4-20250514");
    expect(result.budget.dailyLimitUsd).toBe(50);
    expect(result.budget.monthlyLimitUsd).toBe(500);
  });

  it("should parse partial config", () => {
    const result = ConfigSchema.parse({
      mode: "b2b",
      budget: {
        dailyLimitUsd: 100,
      },
    });

    expect(result.mode).toBe("b2b");
    expect(result.budget.dailyLimitUsd).toBe(100);
    expect(result.budget.monthlyLimitUsd).toBe(500); // default
  });

  it("should reject invalid mode", () => {
    expect(() =>
      ConfigSchema.parse({
        mode: "invalid",
      })
    ).toThrow();
  });
});

describe("AIConfigSchema", () => {
  it("should parse with defaults", () => {
    const result = AIConfigSchema.parse({});

    expect(result.provider).toBe("claude");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.apiKey).toBeUndefined();
  });

  it("should accept apiKey", () => {
    const result = AIConfigSchema.parse({
      apiKey: "test-key",
    });

    expect(result.apiKey).toBe("test-key");
  });
});

describe("BudgetConfigSchema", () => {
  it("should parse with defaults", () => {
    const result = BudgetConfigSchema.parse({});

    expect(result.dailyLimitUsd).toBe(50);
    expect(result.monthlyLimitUsd).toBe(500);
    expect(result.perIssueLimitUsd).toBe(5);
    expect(result.perFeedbackIterationUsd).toBe(2);
  });

  it("should reject negative values", () => {
    expect(() =>
      BudgetConfigSchema.parse({
        dailyLimitUsd: -10,
      })
    ).toThrow();
  });
});
