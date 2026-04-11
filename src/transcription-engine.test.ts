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
  words?: Array<{ word: string; start: number; end: number; confidence: number; punctuated_word?: string; speaker?: number }>;
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

    it("should reset quality warning on new session", async () => {
      // Force reconnection failure by making listen.live throw after first call
      let callCount = 0;
      const originalLive = mock.client.listen.live;
      mock.client.listen.live = vi.fn(() => {
        callCount++;
        if (callCount > 1) throw new Error("Cannot reconnect");
        return originalLive();
      });

      // First session: simulate error, wait for reconnection to exhaust
      engine = new TranscriptionEngine(mock.client);
      engine.startLive(vi.fn());
      mock.emit(LiveTranscriptionEvents.Error, new Error("test"));

      // Wait for reconnection loop to exhaust (qualityWarning set async)
      await vi.waitFor(() => {
        expect(engine.qualityWarning).toBe(true);
      }, { timeout: 10000 });

      engine.stopLive();

      // Reset the mock to allow reconnection again
      callCount = 0;
      mock.client.listen.live = originalLive;

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

  describe("speaker diarization (#157)", () => {
    it("should propagate speakerId from Deepgram words to TranscriptWord", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "hello from speaker zero",
        start: 0,
        duration: 2.0,
        is_final: true,
        words: [
          { word: "hello", start: 0, end: 0.4, confidence: 0.99, punctuated_word: "Hello", speaker: 0 },
          { word: "from", start: 0.5, end: 0.7, confidence: 0.98, punctuated_word: "from", speaker: 0 },
          { word: "speaker", start: 0.8, end: 1.2, confidence: 0.97, punctuated_word: "speaker", speaker: 0 },
          { word: "zero", start: 1.3, end: 1.8, confidence: 0.96, punctuated_word: "zero", speaker: 0 },
        ],
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.words[0].speakerId).toBe(0);
      expect(segment.words[1].speakerId).toBe(0);
      expect(segment.words[2].speakerId).toBe(0);
      expect(segment.words[3].speakerId).toBe(0);
    });

    it("should set segment-level speakerId from mode of word speakers", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      // 3 words from speaker 1, 1 word from speaker 0 → segment speaker = 1
      const event = createDeepgramEvent({
        transcript: "a mixed speaker segment",
        start: 5.0,
        duration: 3.0,
        is_final: true,
        words: [
          { word: "a", start: 5.0, end: 5.2, confidence: 0.9, speaker: 1 },
          { word: "mixed", start: 5.3, end: 5.6, confidence: 0.9, speaker: 0 },
          { word: "speaker", start: 5.7, end: 6.1, confidence: 0.9, speaker: 1 },
          { word: "segment", start: 6.2, end: 6.8, confidence: 0.9, speaker: 1 },
        ],
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.speakerId).toBe(1); // mode of [1, 0, 1, 1] = 1
    });

    it("should omit speakerId when Deepgram words have no speaker field", () => {
      const onSegment = vi.fn();
      engine.startLive(onSegment);

      const event = createDeepgramEvent({
        transcript: "no speaker info",
        start: 0,
        duration: 1.0,
        is_final: true,
        words: [
          { word: "no", start: 0, end: 0.3, confidence: 0.9 },
          { word: "speaker", start: 0.4, end: 0.7, confidence: 0.9 },
          { word: "info", start: 0.8, end: 1.0, confidence: 0.9 },
        ],
      });

      mock.emit(LiveTranscriptionEvents.Transcript, event);

      const segment: TranscriptSegment = onSegment.mock.calls[0][0];
      expect(segment.speakerId).toBeUndefined();
      expect(segment.words[0].speakerId).toBeUndefined();
    });

    it("should enable diarize in default live config", () => {
      engine.startLive(vi.fn());

      expect(mock.client.listen.live).toHaveBeenCalledWith(
        expect.objectContaining({
          diarize: true,
        })
      );
    });
  });

  describe("quality warning", () => {
    it("should default to false", () => {
      expect(engine.qualityWarning).toBe(false);
    });

    it("should be set to true after reconnection attempts exhausted on error", async () => {
      // Make listen.live throw after first call to force reconnection failure
      let callCount = 0;
      const originalLive = mock.client.listen.live;
      mock.client.listen.live = vi.fn(() => {
        callCount++;
        if (callCount > 1) throw new Error("Cannot reconnect");
        return originalLive();
      });
      engine = new TranscriptionEngine(mock.client);
      engine.startLive(vi.fn());

      mock.emit(LiveTranscriptionEvents.Error, new Error("connection failed"));

      // Quality warning is set asynchronously after reconnection loop exhausts
      await vi.waitFor(() => {
        expect(engine.qualityWarning).toBe(true);
      }, { timeout: 10000 });
    });

    it("should be set to true after reconnection attempts exhausted on close", async () => {
      // Make listen.live throw after first call to force reconnection failure
      let callCount = 0;
      const originalLive = mock.client.listen.live;
      mock.client.listen.live = vi.fn(() => {
        callCount++;
        if (callCount > 1) throw new Error("Cannot reconnect");
        return originalLive();
      });
      engine = new TranscriptionEngine(mock.client);
      engine.startLive(vi.fn());

      // Simulate unexpected close
      mock.emit(LiveTranscriptionEvents.Close);

      // Quality warning is set asynchronously after reconnection loop exhausts
      await vi.waitFor(() => {
        expect(engine.qualityWarning).toBe(true);
      }, { timeout: 10000 });
    });

    it("should NOT set quality warning when reconnection succeeds", async () => {
      // Default mock allows successful reconnection
      engine.startLive(vi.fn());

      mock.emit(LiveTranscriptionEvents.Close);

      // Wait for reconnection to succeed
      await new Promise((r) => setTimeout(r, 2000));

      // Quality warning should NOT be set since reconnection succeeded
      expect(engine.qualityWarning).toBe(false);
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

    it("should call OpenAI API with correct parameters for whisper-1 default (#186)", async () => {
      const { client, createSpy } = createMockOpenAIClient({
        text: "Hello everyone, today I want to talk about leadership.",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const audioBuffer = Buffer.alloc(3200); // some audio data
      await engineWithOpenAI.finalize(audioBuffer);

      expect(createSpy).toHaveBeenCalledTimes(1);
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.model).toBe("whisper-1");
      expect(callArgs.language).toBe("en");
      expect(callArgs.response_format).toBe("verbose_json");
      expect(callArgs.file).toBeInstanceOf(File);
      expect(callArgs.file.name).toBe("speech.wav");
      expect(callArgs.timestamp_granularities).toEqual(["word", "segment"]);
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

  describe("finalize with model override", () => {
    it("should use the override model instead of the default when options.model is provided", async () => {
      const { client, createSpy } = createMockOpenAIClient({
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
      // Engine defaults to gpt-4o-transcribe, but override to whisper-1
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(Buffer.alloc(3200), { model: "whisper-1" });

      // Should have called API with whisper-1 and verbose_json
      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.model).toBe("whisper-1");
      expect(callArgs.response_format).toBe("verbose_json");
      expect(callArgs.timestamp_granularities).toEqual(["word", "segment"]);

      // Result should have multiple segments with word timestamps
      expect(result).toHaveLength(2);
      expect(result[0].words.length).toBeGreaterThan(0);
      expect(result[1].words.length).toBeGreaterThan(0);
    });

    it("should use the default model (whisper-1) when no override is provided (#186)", async () => {
      const { client, createSpy } = createMockOpenAIClient({
        text: "Hello everyone.",
      });
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      await engineWithOpenAI.finalize(Buffer.alloc(3200));

      const callArgs = createSpy.mock.calls[0][0];
      expect(callArgs.model).toBe("whisper-1");
      expect(callArgs.response_format).toBe("verbose_json");
    });

    it("should split large audio into chunks and merge results with adjusted timestamps", async () => {
      // Create a buffer larger than 25MB (the Whisper API limit)
      // 25MB = 25 * 1024 * 1024 = 26,214,400 bytes
      // Create a buffer slightly over 25MB to trigger chunking
      const chunkSize = 25 * 1024 * 1024;
      const largeBuffer = Buffer.alloc(chunkSize + 1000);

      // The mock should be called twice (two chunks)
      const createSpy = vi.fn()
        .mockResolvedValueOnce({
          text: "First chunk of speech.",
          duration: 400.0,
          segments: [
            { id: 0, start: 0.0, end: 200.0, text: "First chunk" },
            { id: 1, start: 200.0, end: 400.0, text: "of speech." },
          ],
          words: [
            { word: "First", start: 0.0, end: 0.5 },
            { word: "chunk", start: 0.5, end: 1.0 },
            { word: "of", start: 200.0, end: 200.3 },
            { word: "speech.", start: 200.3, end: 201.0 },
          ],
        } as OpenAITranscriptionResponse)
        .mockResolvedValueOnce({
          text: "Second chunk here.",
          duration: 2.0,
          segments: [
            { id: 0, start: 0.0, end: 2.0, text: "Second chunk here." },
          ],
          words: [
            { word: "Second", start: 0.0, end: 0.5 },
            { word: "chunk", start: 0.5, end: 1.0 },
            { word: "here.", start: 1.0, end: 2.0 },
          ],
        } as OpenAITranscriptionResponse);

      const client: OpenAITranscriptionClient = {
        audio: {
          transcriptions: { create: createSpy },
        },
      };
      const engineWithOpenAI = new TranscriptionEngine(mock.client, client);

      const result = await engineWithOpenAI.finalize(largeBuffer, { model: "whisper-1" });

      // Should have called API twice (once per chunk)
      expect(createSpy).toHaveBeenCalledTimes(2);

      // Should have 3 total segments (2 from first chunk + 1 from second chunk)
      expect(result).toHaveLength(3);

      // First chunk segments should have original timestamps
      expect(result[0].startTime).toBe(0.0);
      expect(result[0].endTime).toBe(200.0);

      // Second chunk segments should have timestamps offset by first chunk's duration
      expect(result[2].startTime).toBeCloseTo(400.0); // 0.0 + 400.0 offset
      expect(result[2].endTime).toBeCloseTo(402.0);   // 2.0 + 400.0 offset

      // Words in second chunk should also be offset
      expect(result[2].words[0].startTime).toBeCloseTo(400.0);
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

  describe("reconnection (#139)", () => {
    /**
     * Creates a mock Deepgram client that tracks multiple live client instances.
     * Each call to listen.live() creates a new mock client, allowing us to simulate
     * reconnection by emitting Close on one and verifying a new one is opened.
     */
    function createReconnectableMockClient() {
      const clients: Array<{
        liveClient: ReturnType<typeof createMockDeepgramClient>["liveClient"];
        emit: ReturnType<typeof createMockDeepgramClient>["emit"];
      }> = [];

      const mockDeepgramClient = {
        listen: {
          live: vi.fn(() => {
            const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
            const liveClient = {
              on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                if (!eventHandlers[event]) eventHandlers[event] = [];
                eventHandlers[event].push(handler);
              }),
              send: vi.fn(),
              requestClose: vi.fn(),
            };
            function emit(event: string, ...args: unknown[]) {
              for (const handler of eventHandlers[event] ?? []) handler(...args);
            }
            clients.push({ liveClient, emit });
            return liveClient;
          }),
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { client: mockDeepgramClient as any, clients };
    }

    it("should attempt reconnection on unexpected close", async () => {
      const { client, clients } = createReconnectableMockClient();
      const engine = new TranscriptionEngine(client);
      const onSegment = vi.fn();
      const onReconnect = vi.fn();

      engine.startLive(onSegment, { onReconnectStatus: onReconnect });

      expect(clients).toHaveLength(1);

      // Simulate unexpected close
      clients[0].emit(LiveTranscriptionEvents.Close);

      // Wait for reconnection attempt (first backoff is 500ms in withRetry default)
      await vi.waitFor(() => {
        expect(clients.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000 });

      // Should have created a new live client
      expect(client.listen.live).toHaveBeenCalledTimes(2);
    });

    it("should buffer audio during reconnection and replay after", async () => {
      const { client, clients } = createReconnectableMockClient();
      const engine = new TranscriptionEngine(client);
      const onSegment = vi.fn();

      engine.startLive(onSegment);

      // Simulate unexpected close
      clients[0].emit(LiveTranscriptionEvents.Close);

      // Feed audio during reconnection gap
      const chunk1 = Buffer.alloc(1600, 1);
      const chunk2 = Buffer.alloc(1600, 2);
      engine.feedAudio(chunk1);
      engine.feedAudio(chunk2);

      // First client should NOT have received these chunks (it's dead)
      expect(clients[0].liveClient.send).toHaveBeenCalledTimes(0);

      // Wait for reconnection
      await vi.waitFor(() => {
        expect(clients.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000 });

      // After reconnection, buffered chunks should be replayed on the new client
      await vi.waitFor(() => {
        expect(clients[1].liveClient.send).toHaveBeenCalledTimes(2);
      }, { timeout: 1000 });
    });

    it("should set quality warning after max reconnection attempts exhausted", async () => {
      const { client, clients } = createReconnectableMockClient();
      // Make listen.live throw after the first call (initial connection)
      let callCount = 0;
      const originalLive = client.listen.live;
      client.listen.live = vi.fn(() => {
        callCount++;
        if (callCount > 1) throw new Error("Cannot reconnect");
        return originalLive();
      });

      const engine = new TranscriptionEngine(client);
      const onReconnect = vi.fn();

      engine.startLive(vi.fn(), { onReconnectStatus: onReconnect });
      expect(engine.qualityWarning).toBe(false);

      // Simulate unexpected close
      clients[0].emit(LiveTranscriptionEvents.Close);

      // After all retries exhausted, quality warning should be set
      // The reconnect loop delays 500/1000/2000ms between attempts
      await vi.waitFor(() => {
        expect(engine.qualityWarning).toBe(true);
      }, { timeout: 15000 });

      // onReconnectStatus should have been called with "failed"
      expect(onReconnect).toHaveBeenCalledWith("reconnecting");
      expect(onReconnect).toHaveBeenCalledWith("failed");
    });

    it("should not reconnect after intentional stopLive", async () => {
      const { client, clients } = createReconnectableMockClient();
      const engine = new TranscriptionEngine(client);

      engine.startLive(vi.fn());
      engine.stopLive();

      // Simulate the Close event firing after stopLive
      clients[0].emit(LiveTranscriptionEvents.Close);

      // Wait a bit to ensure no reconnection happens
      await new Promise((r) => setTimeout(r, 1500));

      // Should still be only 1 client (no reconnection)
      expect(clients).toHaveLength(1);
    });

    it("should continue delivering transcript segments after reconnection", async () => {
      const { client, clients } = createReconnectableMockClient();
      const engine = new TranscriptionEngine(client);
      const onSegment = vi.fn();

      engine.startLive(onSegment);

      // Deliver segments on first connection
      const event1 = createDeepgramEvent({ transcript: "before drop", start: 0, duration: 1 });
      clients[0].emit(LiveTranscriptionEvents.Transcript, event1);
      expect(onSegment).toHaveBeenCalledTimes(1);

      // Simulate drop + reconnect
      clients[0].emit(LiveTranscriptionEvents.Close);

      await vi.waitFor(() => {
        expect(clients.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 3000 });

      // Deliver segments on new connection
      const event2 = createDeepgramEvent({ transcript: "after reconnect", start: 1, duration: 1 });
      clients[1].emit(LiveTranscriptionEvents.Transcript, event2);

      expect(onSegment).toHaveBeenCalledTimes(2);
      expect(onSegment.mock.calls[1][0].text).toBe("after reconnect");
    });
  });
});
