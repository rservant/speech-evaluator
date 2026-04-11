// GCS History Service tests (#123)
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GcsHistoryService,
  sanitizeForPath,
  buildEvaluationPrefix,
  type GcsHistoryClient,
  type SaveEvaluationInput,
  type EvaluationMetadata,
} from "./gcs-history.js";
import type { TranscriptSegment, DeliveryMetrics, StructuredEvaluation } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeTranscript(): TranscriptSegment[] {
  return [
    { text: "Hello world", startTime: 0, endTime: 1, words: [{ word: "Hello", startTime: 0, endTime: 0.5, confidence: 0.95 }, { word: "world", startTime: 0.5, endTime: 1, confidence: 0.95 }], isFinal: true },
  ];
}

function makeMetrics(): DeliveryMetrics {
  return {
    durationSeconds: 60, durationFormatted: "1:00", totalWords: 120, wordsPerMinute: 120,
    fillerWords: [], fillerWordCount: 0, fillerWordFrequency: 0, pauseCount: 0,
    totalPauseDurationSeconds: 0, averagePauseDurationSeconds: 0, intentionalPauseCount: 0,
    hesitationPauseCount: 0, classifiedPauses: [], energyVariationCoefficient: 0,
    energyProfile: { windowDurationMs: 250, windows: [], coefficientOfVariation: 0, silenceThreshold: 0 },
    classifiedFillers: [], visualMetrics: null,
  };
}

function makeEvaluation(): StructuredEvaluation {
  return {
    opening: "Great speech!",
    items: [
      { type: "commendation", summary: "Good pace", explanation: "Steady WPM", evidence_quote: "Hello world", evidence_timestamp: 0 },
    ],
    closing: "Keep it up!",
    structure_commentary: { opening_comment: null, body_comment: null, closing_comment: null },
  };
}

function makeSaveInput(overrides?: Partial<SaveEvaluationInput>): SaveEvaluationInput {
  return {
    speakerName: "Jane Doe",
    speechTitle: "My First Speech",
    mode: "upload" as const,
    durationSeconds: 60,
    wordsPerMinute: 120,
    passRate: 0.8,
    transcript: makeTranscript(),
    metrics: makeMetrics(),
    evaluation: makeEvaluation(),
    evaluationScript: "Great speech! Good pace. Keep it up!",
    ttsAudio: Buffer.from([1, 2, 3, 4, 5]),
    ...overrides,
  };
}

function createMockClient(): GcsHistoryClient & {
  saveFile: ReturnType<typeof vi.fn>;
  listPrefixes: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  getSignedReadUrl: ReturnType<typeof vi.fn>;
  fileExists: ReturnType<typeof vi.fn>;
  deletePrefix: ReturnType<typeof vi.fn>;
} {
  return {
    saveFile: vi.fn().mockResolvedValue(undefined),
    listPrefixes: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue("{}"),
    getSignedReadUrl: vi.fn().mockResolvedValue("https://signed-url.example.com"),
    fileExists: vi.fn().mockResolvedValue(true),
    deletePrefix: vi.fn().mockResolvedValue(0),
  };
}

// ─── sanitizeForPath ────────────────────────────────────────────────────────────

describe("sanitizeForPath", () => {
  it("lowercases input", () => {
    expect(sanitizeForPath("Hello World")).toBe("hello-world");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeForPath("my speech title")).toBe("my-speech-title");
  });

  it("removes special characters", () => {
    expect(sanitizeForPath("Hello! @World# $%")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeForPath("hello---world")).toBe("hello-world");
  });

  it("trims leading/trailing hyphens", () => {
    expect(sanitizeForPath("-hello-")).toBe("hello");
  });

  it("truncates to max length", () => {
    const long = "a".repeat(100);
    expect(sanitizeForPath(long, 20).length).toBeLessThanOrEqual(20);
  });

  it("returns 'untitled' for empty input", () => {
    expect(sanitizeForPath("")).toBe("untitled");
    expect(sanitizeForPath("   ")).toBe("untitled");
    expect(sanitizeForPath("!!!")).toBe("untitled");
  });

  it("handles unicode by stripping non-ascii chars", () => {
    expect(sanitizeForPath("café résumé")).toBe("caf-rsum");
  });
});

// ─── buildEvaluationPrefix ──────────────────────────────────────────────────────

describe("buildEvaluationPrefix", () => {
  it("builds correct prefix format", () => {
    const date = new Date(2026, 2, 20, 14, 30); // March 20, 2026 2:30 PM
    const prefix = buildEvaluationPrefix("Jane Doe", "My Speech", date);

    expect(prefix).toBe("results/jane-doe/2026-03-20-1430-my-speech/");
  });

  it("uses 'untitled' for empty speech title", () => {
    const date = new Date(2026, 0, 1, 9, 0);
    const prefix = buildEvaluationPrefix("Speaker", "", date);

    expect(prefix).toContain("untitled");
  });

  it("sanitizes special characters in names", () => {
    const date = new Date(2026, 5, 15, 12, 0);
    const prefix = buildEvaluationPrefix("John O'Brien", "Speech: The Basics!", date);

    expect(prefix).toBe("results/john-obrien/2026-06-15-1200-speech-the-basics/");
  });

  it("starts with results/ prefix", () => {
    const prefix = buildEvaluationPrefix("Speaker", "Title");
    expect(prefix.startsWith("results/")).toBe(true);
  });

  it("ends with trailing slash", () => {
    const prefix = buildEvaluationPrefix("Speaker", "Title");
    expect(prefix.endsWith("/")).toBe(true);
  });
});

// ─── GcsHistoryService.saveEvaluationResults ────────────────────────────────────

describe("GcsHistoryService - saveEvaluationResults", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("saves 5 files (metadata, transcript, metrics, evaluation, audio) for complete input", async () => {
    const input = makeSaveInput();
    const prefix = await service.saveEvaluationResults(input);

    expect(prefix).not.toBeNull();
    expect(client.saveFile).toHaveBeenCalledTimes(5);

    // Verify file names
    const savedPaths = client.saveFile.mock.calls.map((c: any[]) => c[0]);
    expect(savedPaths.some((p: string) => p.endsWith("metadata.json"))).toBe(true);
    expect(savedPaths.some((p: string) => p.endsWith("transcript.json"))).toBe(true);
    expect(savedPaths.some((p: string) => p.endsWith("metrics.json"))).toBe(true);
    expect(savedPaths.some((p: string) => p.endsWith("evaluation.json"))).toBe(true);
    expect(savedPaths.some((p: string) => p.endsWith("evaluation_audio.mp3"))).toBe(true);
  });

  it("saves 6 files when speech audio is provided (#187)", async () => {
    const input = makeSaveInput({ speechAudio: Buffer.from([1, 2, 3, 4]) });
    await service.saveEvaluationResults(input);

    expect(client.saveFile).toHaveBeenCalledTimes(6);
    const savedPaths = client.saveFile.mock.calls.map((c: any[]) => c[0]);
    expect(savedPaths.some((p: string) => p.endsWith("speech_audio.wav"))).toBe(true);
  });

  it("speech audio is saved as WAV with header (#187)", async () => {
    const pcm = Buffer.from([0, 0, 1, 0]); // minimal PCM data
    const input = makeSaveInput({ speechAudio: pcm });
    await service.saveEvaluationResults(input);

    const wavCall = client.saveFile.mock.calls.find((c: any[]) => c[0].endsWith("speech_audio.wav"));
    expect(wavCall).toBeDefined();
    const wavBuffer = wavCall![1] as Buffer;
    // WAV header starts with "RIFF"
    expect(wavBuffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wavCall![2]).toBe("audio/wav");
  });

  it("saves 4 files when no TTS audio", async () => {
    const input = makeSaveInput({ ttsAudio: undefined });
    await service.saveEvaluationResults(input);

    expect(client.saveFile).toHaveBeenCalledTimes(4);
  });

  it("saves 4 files when TTS audio is empty buffer", async () => {
    const input = makeSaveInput({ ttsAudio: Buffer.alloc(0) });
    await service.saveEvaluationResults(input);

    expect(client.saveFile).toHaveBeenCalledTimes(4);
  });

  it("includes reEvaluatedFrom in metadata when provided (#187)", async () => {
    const input = makeSaveInput({ reEvaluatedFrom: "results/alice/2026-04-01-original/" });
    await service.saveEvaluationResults(input);

    const metadataCall = client.saveFile.mock.calls.find((c: any[]) => c[0].endsWith("metadata.json"));
    const parsed = JSON.parse(metadataCall![1] as string);
    expect(parsed.reEvaluatedFrom).toBe("results/alice/2026-04-01-original/");
  });

  it("metadata.json contains correct fields", async () => {
    const input = makeSaveInput({ passRate: 0.75, projectType: "persuasive" });
    await service.saveEvaluationResults(input);

    const metadataCall = client.saveFile.mock.calls.find((c: any[]) => c[0].endsWith("metadata.json"));
    expect(metadataCall).toBeDefined();

    const parsed = JSON.parse(metadataCall![1] as string) as EvaluationMetadata;
    expect(parsed.speakerName).toBe("Jane Doe");
    expect(parsed.speechTitle).toBe("My First Speech");
    expect(parsed.passRate).toBe(0.75);
    expect(parsed.projectType).toBe("persuasive");
    expect(parsed.mode).toBe("upload");
    expect(parsed.durationSeconds).toBe(60);
    expect(parsed.wordsPerMinute).toBe(120);
    expect(parsed.date).toBeTruthy();
    expect(parsed.prefix).toContain("results/jane-doe/");
  });

  it("returns null and logs on GCS error", async () => {
    client.saveFile.mockRejectedValue(new Error("GCS unavailable"));

    const input = makeSaveInput();
    const result = await service.saveEvaluationResults(input);

    expect(result).toBeNull();
  });

  it("uses correct content types", async () => {
    const input = makeSaveInput();
    await service.saveEvaluationResults(input);

    const contentTypes = client.saveFile.mock.calls.map((c: any[]) => c[2]);
    expect(contentTypes.filter((t: string) => t === "application/json").length).toBe(4);
    expect(contentTypes.filter((t: string) => t === "audio/mpeg").length).toBe(1);
  });
});

// ─── GcsHistoryService.listEvaluations ──────────────────────────────────────────

describe("GcsHistoryService - listEvaluations", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("returns empty results for speaker with no evaluations", async () => {
    client.listPrefixes.mockResolvedValue([]);

    const result = await service.listEvaluations("Jane");

    expect(result.results).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("returns evaluations sorted newest-first", async () => {
    const prefixes = [
      "results/jane/2026-01-01-0900-first/",
      "results/jane/2026-03-15-1400-third/",
      "results/jane/2026-02-10-1000-second/",
    ];
    client.listPrefixes.mockResolvedValue(prefixes);

    const metadata1: EvaluationMetadata = {
      date: "2026-01-01T09:00:00Z", speakerName: "Jane", speechTitle: "First",
      durationSeconds: 60, wordsPerMinute: 120, passRate: 0.8, mode: "upload",
      prefix: prefixes[0],
    };
    const metadata2: EvaluationMetadata = {
      date: "2026-02-10T10:00:00Z", speakerName: "Jane", speechTitle: "Second",
      durationSeconds: 120, wordsPerMinute: 130, passRate: 0.9, mode: "live",
      prefix: prefixes[2],
    };
    const metadata3: EvaluationMetadata = {
      date: "2026-03-15T14:00:00Z", speakerName: "Jane", speechTitle: "Third",
      durationSeconds: 90, wordsPerMinute: 110, passRate: 0.7, mode: "upload",
      prefix: prefixes[1],
    };

    // readFile returns metadata based on path
    client.readFile.mockImplementation((path: string) => {
      if (path.includes("third")) return JSON.stringify(metadata3);
      if (path.includes("second")) return JSON.stringify(metadata2);
      return JSON.stringify(metadata1);
    });

    const result = await service.listEvaluations("Jane");

    expect(result.results.length).toBe(3);
    // Newest first (March > February > January)
    expect(result.results[0].metadata.speechTitle).toBe("Third");
    expect(result.results[1].metadata.speechTitle).toBe("Second");
    expect(result.results[2].metadata.speechTitle).toBe("First");
  });

  it("supports pagination with limit and cursor", async () => {
    const prefixes = [
      "results/jane/2026-01-01-0900-a/",
      "results/jane/2026-02-01-0900-b/",
      "results/jane/2026-03-01-0900-c/",
    ];
    client.listPrefixes.mockResolvedValue(prefixes);

    const metaA: EvaluationMetadata = {
      date: "2026-01-01", speakerName: "Jane", speechTitle: "A",
      durationSeconds: 60, wordsPerMinute: 100, passRate: 0.5, mode: "upload", prefix: prefixes[0],
    };
    const metaB: EvaluationMetadata = { ...metaA, speechTitle: "B", prefix: prefixes[1] };
    const metaC: EvaluationMetadata = { ...metaA, speechTitle: "C", prefix: prefixes[2] };

    client.readFile.mockImplementation((path: string) => {
      if (path.includes("-c/")) return JSON.stringify(metaC);
      if (path.includes("-b/")) return JSON.stringify(metaB);
      return JSON.stringify(metaA);
    });

    // First page: limit 2
    const page1 = await service.listEvaluations("Jane", 2);
    expect(page1.results.length).toBe(2);
    expect(page1.nextCursor).toBeDefined();

    // Second page using cursor
    const page2 = await service.listEvaluations("Jane", 2, page1.nextCursor);
    expect(page2.results.length).toBe(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("skips evaluations with corrupted metadata", async () => {
    client.listPrefixes.mockResolvedValue([
      "results/jane/2026-01-01-0900-good/",
      "results/jane/2026-02-01-0900-bad/",
    ]);

    client.readFile.mockImplementation((path: string) => {
      if (path.includes("bad")) throw new Error("Corrupted");
      return JSON.stringify({
        date: "2026-01-01", speakerName: "Jane", speechTitle: "Good",
        durationSeconds: 60, wordsPerMinute: 100, passRate: 0.5, mode: "upload",
        prefix: "results/jane/2026-01-01-0900-good/",
      });
    });

    const result = await service.listEvaluations("Jane");

    // Only the good evaluation is returned
    expect(result.results.length).toBe(1);
    expect(result.results[0].metadata.speechTitle).toBe("Good");
  });

  it("generates signed URLs for existing files", async () => {
    client.listPrefixes.mockResolvedValue(["results/jane/2026-01-01-0900-test/"]);
    client.readFile.mockResolvedValue(JSON.stringify({
      date: "2026-01-01", speakerName: "Jane", speechTitle: "Test",
      durationSeconds: 60, wordsPerMinute: 100, passRate: 0.5, mode: "upload",
      prefix: "results/jane/2026-01-01-0900-test/",
    }));
    client.fileExists.mockResolvedValue(true);
    client.getSignedReadUrl.mockResolvedValue("https://signed.example.com/file");

    const result = await service.listEvaluations("Jane");

    expect(result.results[0].urls.transcript).toBeDefined();
    expect(result.results[0].urls.metrics).toBeDefined();
    expect(result.results[0].urls.evaluation).toBeDefined();
    expect(result.results[0].urls.audio).toBeDefined();
    expect(result.results[0].urls.metadata).toBeDefined();
  });

  it("omits URLs for non-existent files", async () => {
    client.listPrefixes.mockResolvedValue(["results/jane/2026-01-01-0900-test/"]);
    client.readFile.mockResolvedValue(JSON.stringify({
      date: "2026-01-01", speakerName: "Jane", speechTitle: "Test",
      durationSeconds: 60, wordsPerMinute: 100, passRate: 0.5, mode: "upload",
      prefix: "results/jane/2026-01-01-0900-test/",
    }));

    // Only audio doesn't exist
    client.fileExists.mockImplementation((path: string) =>
      Promise.resolve(!path.endsWith(".mp3")),
    );

    const result = await service.listEvaluations("Jane");

    expect(result.results[0].urls.transcript).toBeDefined();
    expect(result.results[0].urls.audio).toBeUndefined();
  });

  it("sanitizes speaker name for prefix", async () => {
    client.listPrefixes.mockResolvedValue([]);

    await service.listEvaluations("Jane O'Brien");

    expect(client.listPrefixes).toHaveBeenCalledWith(
      "results/jane-obrien/",
      "/",
    );
  });
});

// ─── GcsHistoryService.deleteEvaluation ─────────────────────────────────────────

describe("GcsHistoryService - deleteEvaluation", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("deletes files under the given prefix", async () => {
    client.deletePrefix.mockResolvedValue(5);

    const count = await service.deleteEvaluation("results/jane/2026-01-01-0900-test/");

    expect(count).toBe(5);
    expect(client.deletePrefix).toHaveBeenCalledWith("results/jane/2026-01-01-0900-test/");
  });

  it("returns 0 when no files found", async () => {
    client.deletePrefix.mockResolvedValue(0);

    const count = await service.deleteEvaluation("results/jane/2026-01-01-0900-nonexistent/");

    expect(count).toBe(0);
  });

  it("rejects invalid prefix not starting with results/", async () => {
    await expect(service.deleteEvaluation("other/jane/test/")).rejects.toThrow("Invalid evaluation prefix");
  });
});

// ─── GcsHistoryService.deleteSpeakerHistory ─────────────────────────────────────

describe("GcsHistoryService - deleteSpeakerHistory", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("deletes all files under the speaker prefix", async () => {
    client.deletePrefix.mockResolvedValue(15);

    const count = await service.deleteSpeakerHistory("Jane Doe");

    expect(count).toBe(15);
    expect(client.deletePrefix).toHaveBeenCalledWith("results/jane-doe/");
  });

  it("sanitizes speaker name", async () => {
    client.deletePrefix.mockResolvedValue(0);

    await service.deleteSpeakerHistory("John O'Brien");

    expect(client.deletePrefix).toHaveBeenCalledWith("results/john-obrien/");
  });

  it("returns 0 for speaker with no history", async () => {
    client.deletePrefix.mockResolvedValue(0);

    const count = await service.deleteSpeakerHistory("Unknown Speaker");

    expect(count).toBe(0);
  });
});

// ─── GcsHistoryService.getProgressData (#140) ───────────────────────────────────

describe("GcsHistoryService - getProgressData", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("returns empty array for speaker with no evaluations", async () => {
    client.listPrefixes.mockResolvedValue([]);

    const progress = await service.getProgressData("Unknown Speaker");

    expect(progress).toEqual([]);
  });

  it("returns entries sorted oldest-first (chronological)", async () => {
    const prefixes = [
      "results/jane/2026-03-15-1400-third/",
      "results/jane/2026-01-01-0900-first/",
      "results/jane/2026-02-10-1000-second/",
    ];
    client.listPrefixes.mockResolvedValue(prefixes);

    client.readFile.mockImplementation((path: string) => {
      if (path.includes("first") && path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-01-01T09:00:00Z", speechTitle: "First",
          wordsPerMinute: 100, passRate: 0.6, durationSeconds: 60, speakerName: "Jane", mode: "live", prefix: prefixes[1],
        });
      }
      if (path.includes("second") && path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-02-10T10:00:00Z", speechTitle: "Second",
          wordsPerMinute: 120, passRate: 0.75, durationSeconds: 90, speakerName: "Jane", mode: "live", prefix: prefixes[2],
        });
      }
      if (path.includes("third") && path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-03-15T14:00:00Z", speechTitle: "Third",
          wordsPerMinute: 130, passRate: 0.85, durationSeconds: 120, speakerName: "Jane", mode: "live", prefix: prefixes[0],
        });
      }
      // metrics.json not found
      throw new Error("Not found");
    });

    const progress = await service.getProgressData("Jane");

    expect(progress.length).toBe(3);
    // Oldest first
    expect(progress[0].speechTitle).toBe("First");
    expect(progress[0].wordsPerMinute).toBe(100);
    expect(progress[1].speechTitle).toBe("Second");
    expect(progress[2].speechTitle).toBe("Third");
    expect(progress[2].wordsPerMinute).toBe(130);
  });

  it("includes fillerWordFrequency from metrics.json when available", async () => {
    client.listPrefixes.mockResolvedValue(["results/jane/2026-01-01-0900-test/"]);

    client.readFile.mockImplementation((path: string) => {
      if (path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-01-01T09:00:00Z", speechTitle: "Test",
          wordsPerMinute: 110, passRate: 0.7, durationSeconds: 60, speakerName: "Jane", mode: "live",
          prefix: "results/jane/2026-01-01-0900-test/",
        });
      }
      if (path.endsWith("metrics.json")) {
        return JSON.stringify({ fillerWordFrequency: 3.5 });
      }
      throw new Error("Not found");
    });

    const progress = await service.getProgressData("Jane");

    expect(progress.length).toBe(1);
    expect(progress[0].fillerWordFrequency).toBe(3.5);
  });

  it("sets fillerWordFrequency to undefined when metrics.json is missing", async () => {
    client.listPrefixes.mockResolvedValue(["results/jane/2026-01-01-0900-test/"]);

    client.readFile.mockImplementation((path: string) => {
      if (path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-01-01T09:00:00Z", speechTitle: "Test",
          wordsPerMinute: 110, passRate: 0.7, durationSeconds: 60, speakerName: "Jane", mode: "live",
          prefix: "results/jane/2026-01-01-0900-test/",
        });
      }
      throw new Error("Not found");
    });

    const progress = await service.getProgressData("Jane");

    expect(progress.length).toBe(1);
    expect(progress[0].fillerWordFrequency).toBeUndefined();
  });

  it("skips evaluations with corrupted metadata", async () => {
    client.listPrefixes.mockResolvedValue([
      "results/jane/2026-01-01-0900-good/",
      "results/jane/2026-02-01-0900-bad/",
    ]);

    client.readFile.mockImplementation((path: string) => {
      if (path.includes("bad")) throw new Error("Corrupted");
      if (path.endsWith("metadata.json")) {
        return JSON.stringify({
          date: "2026-01-01T09:00:00Z", speechTitle: "Good",
          wordsPerMinute: 110, passRate: 0.8, durationSeconds: 60, speakerName: "Jane", mode: "live",
          prefix: "results/jane/2026-01-01-0900-good/",
        });
      }
      throw new Error("Not found");
    });

    const progress = await service.getProgressData("Jane");

    expect(progress.length).toBe(1);
    expect(progress[0].speechTitle).toBe("Good");
  });

  it("caps at maxEntries most recent evaluations", async () => {
    const prefixes = Array.from({ length: 10 }, (_, i) =>
      `results/jane/2026-01-${String(i + 1).padStart(2, "0")}-0900-speech-${i}/`,
    );
    client.listPrefixes.mockResolvedValue(prefixes);

    client.readFile.mockImplementation((path: string) => {
      if (path.endsWith("metadata.json")) {
        const match = path.match(/speech-(\d+)/);
        const idx = match ? parseInt(match[1]) : 0;
        return JSON.stringify({
          date: `2026-01-${String(idx + 1).padStart(2, "0")}T09:00:00Z`,
          speechTitle: `Speech ${idx}`, wordsPerMinute: 100 + idx * 5,
          passRate: 0.5 + idx * 0.05, durationSeconds: 60 + idx * 10,
          speakerName: "Jane", mode: "live",
          prefix: `results/jane/2026-01-${String(idx + 1).padStart(2, "0")}-0900-speech-${idx}/`,
        });
      }
      throw new Error("Not found");
    });

    const progress = await service.getProgressData("Jane", 3);

    // Should return only the 3 most recent (speeches 7, 8, 9)
    expect(progress.length).toBe(3);
    expect(progress[0].speechTitle).toBe("Speech 7");
    expect(progress[2].speechTitle).toBe("Speech 9");
  });

  it("sanitizes speaker name", async () => {
    client.listPrefixes.mockResolvedValue([]);

    await service.getProgressData("Jane O'Brien");

    expect(client.listPrefixes).toHaveBeenCalledWith("results/jane-obrien/", "/");
  });
});

// ─── Meeting Methods (#176) ────────────────────────────────────────────────

describe("saveMeetingRecord", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("saves meeting.json under meetings/{meetingId}/", async () => {
    const record = {
      meetingId: "abc-123",
      clubName: "Test Club",
      meetingDate: "2026-04-10",
      slots: [{ slotId: "s1", type: "speech" as const, speakerName: "Alice", status: "completed" as const }],
      createdAt: "2026-04-10T19:00:00Z",
    };

    await service.saveMeetingRecord(record);

    expect(client.saveFile).toHaveBeenCalledTimes(1);
    expect(client.saveFile).toHaveBeenCalledWith(
      "meetings/abc-123/meeting.json",
      expect.any(String),
      "application/json",
    );
    const saved = JSON.parse(client.saveFile.mock.calls[0][1] as string);
    expect(saved.meetingId).toBe("abc-123");
    expect(saved.clubName).toBe("Test Club");
  });

  it("handles save errors gracefully", async () => {
    client.saveFile.mockRejectedValue(new Error("GCS error"));

    // Should not throw
    await service.saveMeetingRecord({
      meetingId: "fail",
      meetingDate: "2026-04-10",
      slots: [],
      createdAt: "2026-04-10T19:00:00Z",
    });
  });
});

describe("saveMeetingSlotEvaluation", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("saves evaluation files under meetings/{meetingId}/slots/{slotId}/", async () => {
    const input = makeSaveInput();

    const prefix = await service.saveMeetingSlotEvaluation("mtg-1", "slot-1", input);

    expect(prefix).toBe("meetings/mtg-1/slots/slot-1/");
    expect(client.saveFile).toHaveBeenCalledTimes(5); // metadata, transcript, metrics, evaluation, audio
    expect(client.saveFile.mock.calls[0][0]).toBe("meetings/mtg-1/slots/slot-1/metadata.json");
  });

  it("skips audio if not provided", async () => {
    const input = makeSaveInput({ ttsAudio: undefined });

    await service.saveMeetingSlotEvaluation("mtg-1", "slot-1", input);

    expect(client.saveFile).toHaveBeenCalledTimes(4);
  });

  it("returns null on error", async () => {
    client.saveFile.mockRejectedValue(new Error("GCS error"));

    const prefix = await service.saveMeetingSlotEvaluation("mtg-1", "slot-1", makeSaveInput());

    expect(prefix).toBeNull();
  });
});

describe("listMeetings", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("returns empty array when no meetings exist", async () => {
    client.listPrefixes.mockResolvedValue([]);

    const result = await service.listMeetings();

    expect(result.results).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("reads meeting.json for each prefix and sorts by date", async () => {
    client.listPrefixes.mockResolvedValue(["meetings/mtg-1/", "meetings/mtg-2/"]);
    client.readFile
      .mockResolvedValueOnce(JSON.stringify({
        meetingId: "mtg-1", meetingDate: "2026-04-01", slots: [], createdAt: "2026-04-01T19:00:00Z",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        meetingId: "mtg-2", meetingDate: "2026-04-10", slots: [{ status: "completed" }], createdAt: "2026-04-10T19:00:00Z",
      }));

    const result = await service.listMeetings();

    expect(result.results).toHaveLength(2);
    expect(result.results[0].meetingId).toBe("mtg-2"); // newest first
    expect(result.results[1].meetingId).toBe("mtg-1");
  });

  it("skips meetings with corrupt meeting.json", async () => {
    client.listPrefixes.mockResolvedValue(["meetings/good/", "meetings/bad/"]);
    client.readFile
      .mockResolvedValueOnce(JSON.stringify({
        meetingId: "good", meetingDate: "2026-04-10", slots: [], createdAt: "2026-04-10T19:00:00Z",
      }))
      .mockRejectedValueOnce(new Error("File not found"));

    const result = await service.listMeetings();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].meetingId).toBe("good");
  });
});

describe("getMeetingRecord", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("returns parsed meeting record", async () => {
    client.readFile.mockResolvedValue(JSON.stringify({
      meetingId: "mtg-1", meetingDate: "2026-04-10", slots: [], createdAt: "2026-04-10T19:00:00Z",
    }));

    const record = await service.getMeetingRecord("mtg-1");

    expect(record).not.toBeNull();
    expect(record!.meetingId).toBe("mtg-1");
    expect(client.readFile).toHaveBeenCalledWith("meetings/mtg-1/meeting.json");
  });

  it("returns null when not found", async () => {
    client.readFile.mockRejectedValue(new Error("Not found"));

    const record = await service.getMeetingRecord("nonexistent");

    expect(record).toBeNull();
  });
});

describe("getMeetingEvaluations", () => {
  let client: ReturnType<typeof createMockClient>;
  let service: GcsHistoryService;

  beforeEach(() => {
    client = createMockClient();
    service = new GcsHistoryService(client);
  });

  it("returns slot evaluations with signed URLs", async () => {
    client.listPrefixes.mockResolvedValue(["meetings/mtg-1/slots/s1/"]);
    client.readFile.mockResolvedValue(JSON.stringify({
      date: "2026-04-10T19:00:00Z",
      speakerName: "Alice",
      speechTitle: "Ice Breaker",
      durationSeconds: 120,
      wordsPerMinute: 130,
      passRate: 0.9,
      mode: "live",
      prefix: "meetings/mtg-1/slots/s1/",
    }));
    client.fileExists.mockResolvedValue(true);
    client.getSignedReadUrl.mockResolvedValue("https://signed.url");

    const evals = await service.getMeetingEvaluations("mtg-1");

    expect(evals).toHaveLength(1);
    expect(evals[0].metadata.speakerName).toBe("Alice");
    expect(evals[0].urls).toBeDefined();
  });

  it("returns empty array when no slots exist", async () => {
    client.listPrefixes.mockResolvedValue([]);

    const evals = await service.getMeetingEvaluations("mtg-1");

    expect(evals).toEqual([]);
  });
});
