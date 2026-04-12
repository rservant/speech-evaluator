/**
 * Prompt Loader Tests — verify style templates are loaded and appended (#194)
 */

import { describe, it, expect } from "vitest";
import { buildSystemPromptFromTemplates } from "./prompt-loader.js";

describe("buildSystemPromptFromTemplates", () => {
  it("returns base prompt for classic style (no style template)", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "classic" });
    expect(prompt).toContain("commendation");
    expect(prompt).not.toContain("Socratic");
    expect(prompt).not.toContain("SBI");
  });

  it("appends Socratic style template when style is socratic", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "socratic" });
    expect(prompt).toContain("Socratic");
    expect(prompt).toContain("question");
    expect(prompt).toContain("style_items");
  });

  it("appends SBI style template when style is sbi", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "sbi" });
    expect(prompt).toContain("SBI");
    expect(prompt).toContain("situation");
    expect(prompt).toContain("behavior");
    expect(prompt).toContain("impact");
  });

  it("appends COIN style template when style is coin", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "coin" });
    expect(prompt).toContain("COIN");
    expect(prompt).toContain("context");
    expect(prompt).toContain("observation");
  });

  it("appends Feedforward style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "feedforward" });
    expect(prompt).toContain("Feedforward");
  });

  it("appends Holistic style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "holistic" });
    expect(prompt).toContain("Holistic");
  });

  it("appends EEC style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "eec" });
    expect(prompt).toContain("EEC");
  });

  it("appends Radical Candour style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "radical_candour" });
    expect(prompt).toContain("Radical Candour");
  });

  it("appends Comparative style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "comparative" });
    expect(prompt).toContain("Comparative");
  });

  it("appends Micro-Focus style template", () => {
    const prompt = buildSystemPromptFromTemplates({ evaluationStyle: "micro_focus" });
    expect(prompt).toContain("Micro-Focus");
  });

  it("includes category scores for all styles", () => {
    const styles = ["classic", "socratic", "sbi", "coin", "feedforward", "holistic", "eec", "radical_candour", "comparative", "micro_focus"];
    for (const style of styles) {
      const prompt = buildSystemPromptFromTemplates({ evaluationStyle: style });
      expect(prompt).toContain("category_scores");
    }
  });

  it("no style = same as classic (no style addendum)", () => {
    const noStyle = buildSystemPromptFromTemplates({});
    const classic = buildSystemPromptFromTemplates({ evaluationStyle: "classic" });
    expect(noStyle).toBe(classic);
  });
});
