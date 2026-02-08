import { describe, it, expect } from "vitest";
import { APP_NAME, APP_VERSION } from "./index.js";

describe("Project setup", () => {
  it("should export app name", () => {
    expect(APP_NAME).toBe("AI Toastmasters Evaluator");
  });

  it("should export app version", () => {
    expect(APP_VERSION).toBe("0.1.0");
  });
});
