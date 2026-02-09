// Unit tests for TTSEngine
// Tests: estimateDuration (with safety margin), trimToFit (structured), synthesize, parseScriptSections
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6

import { describe, it, expect, vi } from "vitest";
import { TTSEngine, parseScriptSections, type OpenAITTSClient } from "./tts-engine.js";

// ─── Mock OpenAI TTS client ────────────────────────────────────────────────────

function createMockClient(audioData: Buffer = Buffer.from("fake-audio")): OpenAITTSClient {
  return {
    audio: {
      speech: {
        create: vi.fn().mockResolvedValue({
          arrayBuffer: () =>
            Promise.resolve(
              audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength),
            ),
        }),
      },
    },
  };
}

// ─── Helper: build a realistic evaluation script ────────────────────────────────

function buildScript(opts?: {
  commendations?: number;
  recommendations?: number;
  structureCommentary?: boolean;
  longExplanations?: boolean;
}): string {
  const { commendations = 2, recommendations = 1, structureCommentary = false, longExplanations = false } = opts ?? {};
  const parts: string[] = [];
  parts.push("Thank you for sharing your speech with us today. It was a pleasure to listen to your presentation.");
  if (structureCommentary) {
    parts.push(
      "Your speech opening was engaging and drew the audience in. The body of your speech was well organized with clear main points. Your closing left a lasting impression.",
    );
  }
  const commPhrases = [
    "One thing you did really well was your use of vivid language.",
    "I also really liked your pacing throughout the speech.",
    "I noticed that your transitions between points were smooth and natural.",
  ];
  const commExpl = [
    " This made your speech come alive and helped the audience visualize your points clearly and effectively throughout the entire presentation.",
    " You maintained a steady rhythm that kept the audience engaged and allowed them to absorb each point before moving on to the next one.",
    " Each transition helped guide the audience through your narrative in a logical and compelling way.",
  ];
  for (let i = 0; i < commendations && i < 3; i++) {
    parts.push(commPhrases[i] + (longExplanations ? commExpl[i] : ""));
  }
  const recPhrases = [
    "Something to consider for next time is adding more pauses for emphasis.",
    "You might also try incorporating more vocal variety.",
  ];
  const recExpl = [
    " Strategic pauses can give your audience time to reflect on key points and can add dramatic effect to your delivery.",
    " Varying your pitch and volume can help maintain audience interest and emphasize important points in your speech.",
  ];
  for (let i = 0; i < recommendations && i < 2; i++) {
    parts.push(recPhrases[i] + (longExplanations ? recExpl[i] : ""));
  }
  parts.push("Overall, great job on this speech. Keep up the excellent work and keep practicing!");
  return parts.join(" ");
}


// ─── estimateDuration ───────────────────────────────────────────────────────────

describe("TTSEngine.estimateDuration", () => {
  const engine = new TTSEngine(createMockClient());

  it("returns 0 for empty text", () => {
    expect(engine.estimateDuration("")).toBe(0);
    expect(engine.estimateDuration("   ")).toBe(0);
  });

  it("computes duration using default WPM (150)", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words)).toBeCloseTo(60, 1);
  });

  it("computes duration with custom WPM", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 100)).toBeCloseTo(60, 1);
  });

  it("handles single word", () => {
    expect(engine.estimateDuration("hello", 150)).toBeCloseTo(0.4, 1);
  });

  it("returns 0 for zero or negative WPM", () => {
    expect(engine.estimateDuration("hello world", 0)).toBe(0);
    expect(engine.estimateDuration("hello world", -10)).toBe(0);
  });

  it("handles text with extra whitespace", () => {
    expect(engine.estimateDuration("  hello   world  ", 150)).toBeCloseTo(0.8, 1);
  });

  it("applies safety margin percentage to duration estimate", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 150, 10)).toBeCloseTo(66, 1);
  });

  it("applies 8% safety margin when specified", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 150, 8)).toBeCloseTo(64.8, 1);
  });

  it("returns 0 for empty text regardless of safety margin", () => {
    expect(engine.estimateDuration("", 150, 50)).toBe(0);
    expect(engine.estimateDuration("   ", 150, 100)).toBe(0);
  });

  it("returns 0 for zero WPM regardless of safety margin", () => {
    expect(engine.estimateDuration("hello", 0, 10)).toBe(0);
  });

  it("handles 0% safety margin (backward compatible)", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 150, 0)).toBeCloseTo(60, 1);
  });

  it("backward compatible: no safety margin param defaults to 0", () => {
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 150)).toBe(engine.estimateDuration(words, 150, 0));
  });
});


// ─── parseScriptSections ────────────────────────────────────────────────────────

describe("parseScriptSections", () => {
  it("returns empty array for empty text", () => {
    expect(parseScriptSections("")).toEqual([]);
  });

  it("parses a script into sections with opening and closing", () => {
    const script = buildScript();
    const sections = parseScriptSections(script);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const types = sections.map((s) => s.type);
    expect(types).toContain("opening");
    expect(types).toContain("closing");
  });

  it("identifies commendation sections", () => {
    const sections = parseScriptSections(buildScript({ commendations: 2 }));
    expect(sections.filter((s) => s.type === "commendation").length).toBeGreaterThanOrEqual(1);
  });

  it("identifies recommendation sections", () => {
    const sections = parseScriptSections(buildScript({ recommendations: 1 }));
    expect(sections.filter((s) => s.type === "recommendation").length).toBeGreaterThanOrEqual(1);
  });

  it("identifies structure commentary sections", () => {
    const sections = parseScriptSections(buildScript({ structureCommentary: true }));
    expect(sections.filter((s) => s.type === "structure_commentary").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves all text when reassembled", () => {
    const script = "Hello there. One thing you did well was great pacing. Something to consider is pausing more. Keep it up!";
    const sections = parseScriptSections(script);
    const reassembled = sections.map((s) => s.sentences.join(" ")).join(" ");
    expect(reassembled).toContain("Hello there.");
    expect(reassembled).toContain("Keep it up!");
  });
});


// ─── trimToFit ──────────────────────────────────────────────────────────────────

describe("TTSEngine.trimToFit", () => {
  const engine = new TTSEngine(createMockClient());

  it("returns text unchanged if it fits within maxSeconds", () => {
    expect(engine.trimToFit("This is a short sentence.", 60)).toBe("This is a short sentence.");
  });

  it("returns text unchanged when safety margin still fits", () => {
    expect(engine.trimToFit("This is a short sentence with ten words here now.", 5, 150, 8)).toBe(
      "This is a short sentence with ten words here now.",
    );
  });

  it("trims when safety margin pushes over limit", () => {
    const text = "First sentence here now. Second sentence here now. Third sentence here now.";
    const trimmed = engine.trimToFit(text, 5, 150, 10);
    expect(engine.estimateDuration(trimmed, 150, 10)).toBeLessThanOrEqual(5);
  });

  it("backward compatible: works without safety margin parameter", () => {
    const text = "First sentence here now. Second sentence here now. Third sentence here now.";
    const trimmed = engine.trimToFit(text, 4, 150);
    expect(engine.estimateDuration(trimmed, 150)).toBeLessThanOrEqual(4);
  });

  it("preserves at least the first sentence even if it exceeds the limit", () => {
    const text = "This is a very long first sentence that exceeds the limit. Second sentence.";
    const trimmed = engine.trimToFit(text, 0.1, 150);
    expect(trimmed).toContain("This is a very long first sentence that exceeds the limit.");
  });

  it("returns single sentence text unchanged", () => {
    expect(engine.trimToFit("Just one sentence here.", 0.1, 150)).toBe("Just one sentence here.");
  });

  it("handles empty text", () => {
    expect(engine.trimToFit("", 60)).toBe("");
  });

  it("handles exclamation and question marks as sentence boundaries", () => {
    const text = "Great job! How did you do that? Let me explain. And more details.";
    const trimmed = engine.trimToFit(text, 3, 150);
    expect(trimmed).toContain("Great job!");
    expect(engine.estimateDuration(trimmed, 150)).toBeLessThanOrEqual(3);
  });

  it("progressively removes sentences until fit (simple text)", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} here.`);
    const text = sentences.join(" ");
    const trimmed = engine.trimToFit(text, 8, 150);
    expect(engine.estimateDuration(trimmed, 150)).toBeLessThanOrEqual(8);
    expect(trimmed).toContain("Sentence number 1 here.");
  });

  it("removes structure commentary first when trimming", () => {
    const script = buildScript({ commendations: 2, recommendations: 1, structureCommentary: true, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.7, 150, 8);
    expect(trimmed).not.toContain("speech opening was engaging");
    expect(trimmed).not.toContain("body of your speech was well organized");
    expect(trimmed).toContain("One thing you did really well");
  });

  it("preserves opening and closing after trimming", () => {
    const script = buildScript({ commendations: 3, recommendations: 2, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.4, 150, 8);
    expect(trimmed).toContain("Thank you");
    expect(trimmed).toMatch(/(?:great job|excellent work|keep)/i);
  });

  it("preserves at least one commendation after trimming (Req 6.4)", () => {
    const script = buildScript({ commendations: 3, recommendations: 2, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.3, 150, 8);
    expect(trimmed).toMatch(/(?:you did (?:really )?well|liked|noticed)/i);
  });

  it("preserves strongest recommendation when trimming (Req 6.5)", () => {
    const script = buildScript({ commendations: 2, recommendations: 2, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.3, 150, 8);
    expect(trimmed).toMatch(/(?:consider|next time|try|suggestion)/i);
  });

  it("ensures trimmed script ends with complete sentence (Req 6.6)", () => {
    const script = buildScript({ commendations: 3, recommendations: 2, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.4, 150, 8);
    expect([".", "!", "?"]).toContain(trimmed.trim().slice(-1));
  });

  it("trimming is purely subtractive — no content appended", () => {
    const script = buildScript({ commendations: 2, recommendations: 1, longExplanations: true });
    const fullDuration = engine.estimateDuration(script, 150, 8);
    const trimmed = engine.trimToFit(script, fullDuration * 0.5, 150, 8);
    for (const word of trimmed.split(/\s+/)) {
      expect(script).toContain(word);
    }
  });

  it("hard-minimum fallback: still produces valid output under very tight limit", () => {
    const script = buildScript({ commendations: 2, recommendations: 1, longExplanations: true });
    const trimmed = engine.trimToFit(script, 5, 150, 8);
    expect(trimmed.length).toBeGreaterThan(0);
    expect([".", "!", "?"]).toContain(trimmed.trim().slice(-1));
  });
});


// ─── synthesize ─────────────────────────────────────────────────────────────────

describe("TTSEngine.synthesize", () => {
  it("calls OpenAI TTS API with correct parameters", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    await engine.synthesize("Hello world.", { voice: "nova", maxDurationSeconds: 120, calibratedWPM: 150, safetyMarginPercent: 8 });
    expect(mockClient.audio.speech.create).toHaveBeenCalledWith({ model: "tts-1", voice: "nova", input: "Hello world." });
  });

  it("returns a Buffer with audio data", async () => {
    const audioData = Buffer.from("test-audio-data");
    const engine = new TTSEngine(createMockClient(audioData));
    const result = await engine.synthesize("Hello world.");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe("test-audio-data");
  });

  it("uses default config when none provided (Phase 2 defaults)", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    await engine.synthesize("Hello world.");
    expect(mockClient.audio.speech.create).toHaveBeenCalledWith({ model: "tts-1", voice: "nova", input: "Hello world." });
  });

  it("trims text before synthesis if it exceeds maxDurationSeconds", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence. Eighth sentence. Ninth sentence. Tenth sentence.";
    await engine.synthesize(text, { voice: "nova", maxDurationSeconds: 2, calibratedWPM: 150, safetyMarginPercent: 0 });
    const callArgs = (mockClient.audio.speech.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(engine.estimateDuration(callArgs.input as string, 150)).toBeLessThanOrEqual(2);
  });

  it("applies safety margin during synthesis trimming", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    const text = "First sentence here now. Second sentence here now. Third sentence.";
    await engine.synthesize(text, { voice: "nova", maxDurationSeconds: 5, calibratedWPM: 150, safetyMarginPercent: 50 });
    const callArgs = (mockClient.audio.speech.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(engine.estimateDuration(callArgs.input as string, 150, 50)).toBeLessThanOrEqual(5);
  });

  it("uses custom voice from config", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    await engine.synthesize("Hello.", { voice: "nova", maxDurationSeconds: 120, calibratedWPM: 150, safetyMarginPercent: 8 });
    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(expect.objectContaining({ voice: "nova" }));
  });

  it("allows partial config with defaults for missing fields", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    await engine.synthesize("Hello.", { voice: "nova" } as any);
    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(expect.objectContaining({ voice: "nova" }));
  });

  it("uses custom model when specified in constructor", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient, "tts-1-hd");
    await engine.synthesize("Hello.");
    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(expect.objectContaining({ model: "tts-1-hd" }));
  });

  it("default maxDurationSeconds is 120 (Phase 2)", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const text = words + ". End sentence.";
    await engine.synthesize(text);
    const callArgs = (mockClient.audio.speech.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(engine.estimateDuration(callArgs.input as string, 150, 8)).toBeLessThanOrEqual(120);
  });
});
