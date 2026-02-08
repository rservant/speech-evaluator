import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptionEngine } from "./transcription-engine.js";
import type { OpenAITranscriptionClient, OpenAITranscriptionResponse } from "./transcription-engine.js";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import type { TranscriptSegment } from "./types.js";

/**
 * Creates a mock Deepgram client with a controllable ListenLiveClient.
 * Event handlers are captured so tests can simulate Deepgram events.
 */
function createMockDeepgramClient() {
  const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  const mockLiveClient = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!eventHandlers[event]) {
        eventHandlers[event] = [];
      }
      eventHandlers[event].push(handler);
    }),
    send: vi.fn(),
    requestClose: vi.fn(),
  };

  const mockDeepgramClient = {
    listen: {
      live: vi.fn(() => mockLiveClient),
    },
  };

  function emit(event: string, ...args: unknown[]) {
    const handlers = eventHandlers[event] ?? [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: mockDeepgramClient as any, liveClient: mockLiveClient, emit };
}

/**
 * Creates a realistic Deepgram transcript event for testing.
 */
function createDeepgramEvent(options: {
  transcript: string;
  start: number;
  duration: number;
  is_final?: boolean;
  words?: Array<{ word: string; start: number; end: number; confidence: number; punctuated_word?: string }>;
}) {
  return {
    type: "Results",
    channel_index: [0, 1],
    duration: options.duration,
    start: options.start,
    is_final: options.is_final ?? false,
    speech_final: false,
    channel: {
      alternatives: [
        {
          transcript: options.transcript,
          confidence: 0.95,
          words: options.words ?? [
            {
              word: options.transcript.split(" ")[0],
              start: options.start,
              end: options.start + options.duration,
              confidence: 0.95,
              punctuated_word: options.transcript.split(" ")[0],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Creates a mock OpenAI transcription client for testing finalize().
 * The `create` method returns a configurable response.
 */
function createMockOpenAIClient(
  response: OpenAITranscriptionResponse,
): { client: OpenAITranscriptionClient; createSpy: ReturnType<typeof vi.fn> } {
  const createSpy = vi.fn().mockResolvedValue(response);
  const client: OpenAITranscriptionClient = {
    audio: {
      transcriptions: {
        create: createSpy,
      },
    },
  };
  return { client, createSpy };
}

describe("TranscriptionEngine", () => {
  let mock: ReturnType<typeof createMockDeepgramClient>;
  let engine: TranscriptionEngine;

  beforeEach(() => {
    mock = createMockDeepgramClient();
    engine = new TranscriptionEngine(mock.client);
  });

  describe("startLive", () => {
    it("should open a Deepgram WebSocket with correct audio format config", () => {
      engine.startLive(vi.fn());

      expect(mock.client.listen.live).toHaveBeenCalledWith(
        expect.objectContaining({
          encoding: "linear16",
          sample_rate: 16000,
          channels: 1,
          interim_results: true,
        })
      );
    });

    it("should register event handlers for Transcript, Error, and Close", () => {
      engine.startLive(vi.fn());

      const registeredEvents = mock.liveClient.on.mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(registeredEvents).toContain(LiveTranscriptionEvents.Transcript);
      expect(registeredEvents).toContain(LiveTranscriptionEvents.Error);
      expect(registeredEvents).toContain(LiveTranscriptionEvents.Close);
    });

    it("should throw if called while a session is already active", () => {
      engine.startLive(vi.fn());

      expect(() => engine.startLive(vi.fn())).toThrow(
        "Live transcription session already active"
      );
    });

    it("should reset quality warning on new session", () => {
      // First session: simulate error to set quality warning
      engine.startLive(vi.fn());
      mock.emit(LiveTranscriptionEvents.Error, new Error("test"));
      expect(engine.qualityWarning).toBe(true);

      engine.stopLive();

      // Second session: quality warning should be reset
      engine.startLive(vi.fn());
      expect(engine.qualityWarning).toBe(false);
    });
  });

  describe("feedAudio", () => {
    it("should forward audio chunk to Deepgram live client", () => {
      engine.startLive(vi.fn());

      const chunk = Buffer.alloc(1600); // 50ms of 16kHz 16-bit mono
      engine.feedAudio(chunk);

      expect(mock.liveClient.send).toHaveBeenCalledTimes(1);
    });

    it("should throw if no live session is active", () => {
      const chunk = Buffer.alloc(1600);

      expect(() => engine.feedAudio(chunk)).toThrow(
        "No active live transcription session"
      );
    });

    it("should throw after stopLive is called", () => {
      engine.startLive(vi.fn());
      engine.stopLive();

      const chunk = Buffer.alloc(1600);
      expect(() => engine.feedAudio(chunk)).toThrow(
        "No active live transcription session"
      );
    });
  });

  describe("stopLive", () => {
    it("should request graceful close from Deepgram", () => {
      engine.startLive(vi.fn());
      engine.stopLive();

      expect(mock.liveClient.requestClose).toHaveBeenCalledTimes(1);
    });

    it("should be a no-op if no session is active", () => {
      // Should not throw
      engine.stopLive();
    });

    it("should be idempotent (calling twice is safe)", () => {
      engine.startLive(vi.fn());
      engine.stopLive();
      engine.stopLive(); // second call should be no-op

      expect(mock.liveClient.requestClose).toHaveBeenCalledTimes(1);
    });

    it("should not set quality warning on intentional close", () => {
      engine.startLive(vi.fn());
      engine.stopLive();

      // Simulate the close event firing after we've already nulled liveClient
      mock.emit(LiveTranscriptionEvents.Close);

      expect(engine.qualityWarning).toBe(false);
    });

    it("should handle requestClose throwing gracefully", () => {
      mock.liveClient.requestClose.mockImplementation(() => {
        throw new Error("Connection already closed");
      });

      engine.startLive(vi.fn());

      // Should not throw
      expect(() => engine.stopLive()).not.toThrow();
    });
  });

  describe("transcript event handling", () => {
    it("should emit a TranscriptSegment for interim results", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "hello everyone",
        start: 0.5,
        duration: 1.2,
        is_final: false,
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      expect(onSegment).toHaveBeenCalledTimes(1);
      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.text).toBe("hello everyone");
      expect(segment.startTime).toBe(0.5);
      expect(segment.endTime).toBeCloseTo(1.7);
      expect(segment.isFinal).toBe(false);
    });

    it("should emit a TranscriptSegment for final results", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "hello everyone today I want to talk about",
        start: 0.5,
        duration: 3.0,
        is_final: true,
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      expect(onSegment).toHaveBeenCalledTimes(1);
      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.isFinal).toBe(true);
    });

    it("should convert Deepgram words to TranscriptWord format", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "hello world",
        start: 1.0,
        duration: 1.5,
        words: [
          { word: "hello", start: 1.0, end: 1.3, confidence: 0.98, punctuated_word: "Hello" },
          { word: "world", start: 1.4, end: 1.8, confidence: 0.95, punctuated_word: "world" },
        ],
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.words).toHaveLength(2);
      expect(segment.words[0]).toEqual({
        word: "Hello",
        startTime: 1.0,
        endTime: 1.3,
        confidence: 0.98,
      });
      expect(segment.words[1]).toEqual({
        word: "world",
        startTime: 1.4,
        endTime: 1.8,
        confidence: 0.95,
      });
    });

    it("should use word field when punctuated_word is missing", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "test",
        start: 0,
        duration: 0.5,
        words: [
          { word: "test", start: 0, end: 0.5, confidence: 0.9 },
        ],
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.words[0].word).toBe("test");
    });

    it("should ignore events with empty transcript text", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "",
        start: 0,
        duration: 0.5,
      });
      // Override to have empty transcript
      event.channel.alternatives[0].transcript = "";

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      expect(onSegment).not.toHaveBeenCalled();
    });

    it("should ignore events with no alternatives", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = {
        type: "Results",
        channel_index: [0, 1],
        duration: 0.5,
        start: 0,
        channel: { alternatives: [] },
      };

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      expect(onSegment).not.toHaveBeenCalled();
    });
  });

  describe("quality warning", () => {
    it("should default to false", () => {
      expect(engine.qualityWarning).toBe(false);
    });

    it("should be set to true on Deepgram error event", () => {
      engine.startLive(vi.fn());

      mock.emit(LiveTranscriptionEvents.Error, new Error("connection failed"));

      expect(engine.qualityWarning).toBe(true);
    });

    it("should be set to true on unexpected connection close", () => {
      engine.startLive(vi.fn());

      // Simulate unexpected close (liveClient still set)
      mock.emit(LiveTranscriptionEvents.Close);

      expect(engine.qualityWarning).toBe(true);
    });
  });

  describe("finalize", () => {
    it("should throw if no OpenAI client was provided", async () => {
      // engine was created without an OpenAI client
      await expect(engine.finalize(Buffer.alloc(100))).rejects.toThrow(
        "No OpenAI client configured"
      );
    });

    it("should return empty array for empty audio buffer", async () => {
      const { client } = createMockOpenAIClient({ text: "" });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(0));
      expect(result).toEqual([]);
    });

    it("should call OpenAI API with correct parameters for gpt-4o-transcribe", async () => {
      const { client, createSpy } = createMockOpenAIClient({
        text: "Hello everyone, today I want to talk about leadership.",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const audioBuffer = Buffer.alloc(3200); // some audio data
      await engineWithOpenAI.finalize(audioBuffer);

      expect(createSpy).toHaveBeenCalledTimes(1);
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.model).toBe("gpt-4o-transcribe");
      expect(callArgs.language).toBe("en");
      expect(callArgs.response_format).toBe("json");
      expect(callArgs.file).toBeInstanceOf(File);
      expect(callArgs.file.name).toBe("speech.wav");
      // gpt-4o-transcribe should NOT request timestamp_granularities
      expect(callArgs.timestamp_granularities).toBeUndefined();
    });

    it("should call OpenAI API with verbose_json for whisper-1 model", async () => {
      const { client, createSpy } = createMockOpenAIClient({
        text: "Hello everyone.",
        duration: 5.0,
        words: [
          { word: "Hello", start: 0.0, end: 0.5 },
          { word: "everyone.", start: 0.6, end: 1.2 },
        ],
      });
      const engineWithOpenAI = new TranscriptionEngine(
        mock.client, client, undefined, "whisper-1"
      );

      await engineWithOpenAI.finalize(Buffer.alloc(3200));

      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.model).toBe("whisper-1");
      expect(callArgs.response_format).toBe("verbose_json");
      expect(callArgs.timestamp_granularities).toEqual(["word", "segment"]);
    });

    it("should parse text-only response into a single segment (gpt-4o-transcribe fallback)", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone, today I want to talk about leadership.",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Hello everyone, today I want to talk about leadership.");
      expect(result[0].startTime).toBe(0);
      expect(result[0].endTime).toBe(0); // no duration available
      expect(result[0].words).toEqual([]);
      expect(result[0].isFinal).toBe(true);
    });

    it("should use duration from response when available in text-only mode", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone.",
        duration: 45.5,
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      expect(result).toHaveLength(1);
      expect(result[0].startTime).toBe(0);
      expect(result[0].endTime).toBe(45.5);
    });

    it("should return empty array when response text is empty", async () => {
      const { client } = createMockOpenAIClient({
        text: "",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));
      expect(result).toEqual([]);
    });

    it("should return empty array when response text is whitespace only", async () => {
      const { client } = createMockOpenAIClient({
        text: "   \n  ",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));
      expect(result).toEqual([]);
    });

    it("should parse response with word-level timestamps", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone today I want to talk about leadership",
        duration: 8.0,
        words: [
          { word: "Hello", start: 0.0, end: 0.4 },
          { word: "everyone", start: 0.5, end: 1.0 },
          { word: "today", start: 1.1, end: 1.5 },
          { word: "I", start: 1.6, end: 1.7 },
          { word: "want", start: 1.8, end: 2.1 },
          { word: "to", start: 2.2, end: 2.3 },
          { word: "talk", start: 2.4, end: 2.7 },
          { word: "about", start: 2.8, end: 3.1 },
          { word: "leadership", start: 3.2, end: 4.0 },
        ],
      });
      const engineWithOpenAI = new TranscriptionEngine(
        mock.client, client, undefined, "whisper-1"
      );

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      // Single segment with all words
      expect(result).toHaveLength(1);
      expect(result[0].words).toHaveLength(9);
      expect(result[0].startTime).toBe(0.0);
      expect(result[0].endTime).toBe(4.0);
      expect(result[0].isFinal).toBe(true);

      // Verify word structure
      expect(result[0].words[0]).toEqual({
        word: "Hello",
        startTime: 0.0,
        endTime: 0.4,
        confidence: 1.0,
      });
      expect(result[0].words[8]).toEqual({
        word: "leadership",
        startTime: 3.2,
        endTime: 4.0,
        confidence: 1.0,
      });
    });

    it("should parse response with both word and segment timestamps", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone. Today I want to talk about leadership.",
        duration: 8.0,
        segments: [
          { id: 0, start: 0.0, end: 2.0, text: "Hello everyone." },
          { id: 1, start: 2.5, end: 6.0, text: "Today I want to talk about leadership." },
        ],
        words: [
          { word: "Hello", start: 0.0, end: 0.4 },
          { word: "everyone.", start: 0.5, end: 1.0 },
          { word: "Today", start: 2.5, end: 2.9 },
          { word: "I", start: 3.0, end: 3.1 },
          { word: "want", start: 3.2, end: 3.5 },
          { word: "to", start: 3.6, end: 3.7 },
          { word: "talk", start: 3.8, end: 4.1 },
          { word: "about", start: 4.2, end: 4.5 },
          { word: "leadership.", start: 4.6, end: 5.5 },
        ],
      });
      const engineWithOpenAI = new TranscriptionEngine(
        mock.client, client, undefined, "whisper-1"
      );

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      // Two segments, each with their words
      expect(result).toHaveLength(2);

      expect(result[0].text).toBe("Hello everyone.");
      expect(result[0].startTime).toBe(0.0);
      expect(result[0].endTime).toBe(2.0);
      expect(result[0].words).toHaveLength(2);
      expect(result[0].isFinal).toBe(true);

      expect(result[1].text).toBe("Today I want to talk about leadership.");
      expect(result[1].startTime).toBe(2.5);
      expect(result[1].endTime).toBe(6.0);
      expect(result[1].words).toHaveLength(7);
      expect(result[1].isFinal).toBe(true);
    });

    it("should parse response with segment-level timestamps only (no words)", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone. Today I want to talk about leadership.",
        duration: 8.0,
        segments: [
          { id: 0, start: 0.0, end: 2.0, text: "Hello everyone." },
          { id: 1, start: 2.5, end: 6.0, text: "Today I want to talk about leadership." },
        ],
        // No words array — segment-level fallback
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      expect(result).toHaveLength(2);

      // Segment-level: words array should be empty (signals fallback to downstream)
      expect(result[0].text).toBe("Hello everyone.");
      expect(result[0].startTime).toBe(0.0);
      expect(result[0].endTime).toBe(2.0);
      expect(result[0].words).toEqual([]);
      expect(result[0].isFinal).toBe(true);

      expect(result[1].text).toBe("Today I want to talk about leadership.");
      expect(result[1].startTime).toBe(2.5);
      expect(result[1].endTime).toBe(6.0);
      expect(result[1].words).toEqual([]);
      expect(result[1].isFinal).toBe(true);
    });

    it("should filter out empty segments from segment-level response", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello everyone.",
        duration: 5.0,
        segments: [
          { id: 0, start: 0.0, end: 2.0, text: "Hello everyone." },
          { id: 1, start: 2.5, end: 3.0, text: "  " }, // empty/whitespace segment
          { id: 2, start: 3.5, end: 5.0, text: "" },    // empty segment
        ],
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Hello everyone.");
    });

    it("should mark all segments as isFinal", async () => {
      const { client } = createMockOpenAIClient({
        text: "First segment. Second segment. Third segment.",
        duration: 15.0,
        segments: [
          { id: 0, start: 0.0, end: 5.0, text: "First segment." },
          { id: 1, start: 5.5, end: 10.0, text: "Second segment." },
          { id: 2, start: 10.5, end: 15.0, text: "Third segment." },
        ],
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      for (const segment of result) {
        expect(segment.isFinal).toBe(true);
      }
    });

    it("should propagate API errors", async () => {
      const createSpy = vi.fn().mockRejectedValue(new Error("API rate limit exceeded"));
      const client: OpenAITranscriptionClient = {
        audio: {
          transcriptions: { create: createSpy },
        },
      };
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      await expect(engineWithOpenAI.finalize(Buffer.alloc(3200))).rejects.toThrow(
        "API rate limit exceeded"
      );
    });

    it("should handle words with no segments by creating a single segment", async () => {
      const { client } = createMockOpenAIClient({
        text: "Hello world",
        duration: 2.0,
        words: [
          { word: "Hello", start: 0.0, end: 0.5 },
          { word: "world", start: 0.6, end: 1.2 },
        ],
        // No segments array
      });
      const engineWithOpenAI = new TranscriptionEngine(
        mock.client, client, undefined, "whisper-1"
      );

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200));

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("Hello world");
      expect(result[0].startTime).toBe(0.0);
      expect(result[0].endTime).toBe(1.2);
      expect(result[0].words).toHaveLength(2);
    });
  });

  describe("custom config", () => {
    it("should merge custom config with defaults", () => {
      const customEngine = new TranscriptionEngine(mock.client, undefined, {
        model: "nova-3",
        language: "es",
      });

      customEngine.startLive(vi.fn());

      expect(mock.client.listen.live).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "nova-3",
          language: "es",
          encoding: "linear16",
          sample_rate: 16000,
          channels: 1,
        })
      );
    });
  });
});
