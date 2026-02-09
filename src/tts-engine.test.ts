// Unit tests for TTSEngine
// Tests: estimateDuration, trimToFit, synthesize
// Requirements: 5.1, 5.2

import { describe, it, expect, vi } from "vitest";
import { TTSEngine, type OpenAITTSClient } from "./tts-engine.js";

// ─── Mock OpenAI TTS client ────────────────────────────────────────────────────

function createMockClient(audioData: Buffer = Buffer.from("fake-audio")): OpenAITTSClient {
  return {
    audio: {
      speech: {
        create: vi.fn().mockResolvedValue({
          arrayBuffer: () => Promise.resolve(audioData.buffer.slice(
            audioData.byteOffset,
            audioData.byteOffset + audioData.byteLength,
          )),
        }),
      },
    },
  };
}

// ─── estimateDuration ───────────────────────────────────────────────────────────

describe("TTSEngine.estimateDuration", () => {
  const client = createMockClient();
  const engine = new TTSEngine(client);

  it("returns 0 for empty text", () => {
    expect(engine.estimateDuration("")).toBe(0);
    expect(engine.estimateDuration("   ")).toBe(0);
  });

  it("computes duration using default WPM (150)", () => {
    // 150 words at 150 WPM = 60 seconds
    const words = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words)).toBeCloseTo(60, 1);
  });

  it("computes duration with custom WPM", () => {
    // 100 words at 100 WPM = 60 seconds
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(engine.estimateDuration(words, 100)).toBeCloseTo(60, 1);
  });

  it("handles single word", () => {
    // 1 word at 150 WPM = 0.4 seconds
    expect(engine.estimateDuration("hello", 150)).toBeCloseTo(0.4, 1);
  });

  it("returns 0 for zero or negative WPM", () => {
    expect(engine.estimateDuration("hello world", 0)).toBe(0);
    expect(engine.estimateDuration("hello world", -10)).toBe(0);
  });

  it("handles text with extra whitespace", () => {
    // "hello   world" is 2 words
    expect(engine.estimateDuration("  hello   world  ", 150)).toBeCloseTo(0.8, 1);
  });
});

// ─── trimToFit ──────────────────────────────────────────────────────────────────

describe("TTSEngine.trimToFit", () => {
  const client = createMockClient();
  const engine = new TTSEngine(client);

  it("returns text unchanged if it fits within maxSeconds", () => {
    const text = "This is a short sentence.";
    expect(engine.trimToFit(text, 60)).toBe(text);
  });

  it("trims sentences from the end to fit", () => {
    // At 150 WPM, each word takes 0.4s. 
    // Build a text with multiple sentences that exceeds the limit.
    // 10 words = 4 seconds at 150 WPM
    const text = "First sentence here now. Second sentence here now. Third sentence here now.";
    // 12 words total = 4.8s at 150 WPM. Set max to 4s (10 words max).
    const trimmed = engine.trimToFit(text, 4, 150);
    // Should drop "Third sentence here now." to get 8 words = 3.2s
    expect(trimmed).toBe("First sentence here now. Second sentence here now.");
  });

  it("preserves at least the first sentence even if it exceeds the limit", () => {
    const text = "This is a very long first sentence that exceeds the limit. Second sentence.";
    // Set a very short max that even the first sentence exceeds
    const trimmed = engine.trimToFit(text, 0.1, 150);
    expect(trimmed).toBe("This is a very long first sentence that exceeds the limit.");
  });

  it("returns single sentence text unchanged", () => {
    const text = "Just one sentence here.";
    expect(engine.trimToFit(text, 0.1, 150)).toBe(text);
  });

  it("handles empty text", () => {
    expect(engine.trimToFit("", 60)).toBe("");
  });

  it("handles text with exclamation and question marks as sentence boundaries", () => {
    const text = "Great job! How did you do that? Let me explain. And more details.";
    // 14 words = 5.6s at 150 WPM. Set max to 3s (7.5 words).
    const trimmed = engine.trimToFit(text, 3, 150);
    // Should keep removing from end until it fits
    expect(trimmed).toContain("Great job!");
    expect(engine.estimateDuration(trimmed, 150)).toBeLessThanOrEqual(3);
  });

  it("progressively removes sentences until fit", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} here.`);
    const text = sentences.join(" ");
    // Each sentence is 4 words. 40 words total = 16s at 150 WPM.
    // Set max to 8s = 20 words = 5 sentences.
    const trimmed = engine.trimToFit(text, 8, 150);
    expect(engine.estimateDuration(trimmed, 150)).toBeLessThanOrEqual(8);
    expect(trimmed).toContain("Sentence number 1 here.");
  });
});

// ─── synthesize ─────────────────────────────────────────────────────────────────

describe("TTSEngine.synthesize", () => {
  it("calls OpenAI TTS API with correct parameters", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);

    await engine.synthesize("Hello world.", { voice: "nova", maxDurationSeconds: 210, calibratedWPM: 150 });

    expect(mockClient.audio.speech.create).toHaveBeenCalledWith({
      model: "tts-1",
      voice: "nova",
      input: "Hello world.",
    });
  });

  it("returns a Buffer with audio data", async () => {
    const audioData = Buffer.from("test-audio-data");
    const mockClient = createMockClient(audioData);
    const engine = new TTSEngine(mockClient);

    const result = await engine.synthesize("Hello world.");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe("test-audio-data");
  });

  it("uses default config when none provided", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);

    await engine.synthesize("Hello world.");

    expect(mockClient.audio.speech.create).toHaveBeenCalledWith({
      model: "tts-1",
      voice: "nova",
      input: "Hello world.",
    });
  });

  it("trims text before synthesis if it exceeds maxDurationSeconds", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);

    // Build a long text that exceeds 2 seconds at 150 WPM
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence. Eighth sentence. Ninth sentence. Tenth sentence.";
    
    await engine.synthesize(text, { voice: "nova", maxDurationSeconds: 2, calibratedWPM: 150 });

    // The input passed to the API should be trimmed
    const callArgs = (mockClient.audio.speech.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const inputText = callArgs.input as string;
    expect(engine.estimateDuration(inputText, 150)).toBeLessThanOrEqual(2);
  });

  it("uses custom voice from config", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);

    await engine.synthesize("Hello.", { voice: "nova", maxDurationSeconds: 210, calibratedWPM: 150 });

    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "nova" }),
    );
  });

  it("allows partial config with defaults for missing fields", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient);

    await engine.synthesize("Hello.", { voice: "nova" } as any);

    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "nova" }),
    );
  });

  it("uses custom model when specified in constructor", async () => {
    const mockClient = createMockClient();
    const engine = new TTSEngine(mockClient, "tts-1-hd");

    await engine.synthesize("Hello.");

    expect(mockClient.audio.speech.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "tts-1-hd" }),
    );
  });
});
