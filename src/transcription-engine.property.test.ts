// Property-Based Tests for TranscriptionEngine — Transcript Structural Invariant
// Feature: ai-toastmasters-evaluator, Property 1: Transcript Structural Invariant

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { TranscriptionEngine } from "./transcription-engine.js";
import type {
  OpenAITranscriptionClient,
  OpenAITranscriptionResponse,
} from "./transcription-engine.js";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import type { TranscriptSegment } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Asserts the Transcript Structural Invariant on a list of segments:
 * 1. Every segment has non-negative startTime <= endTime
 * 2. Every word within a segment has timestamps within the segment's time range
 */
function assertStructuralInvariant(segments: TranscriptSegment[]): void {
  for (const seg of segments) {
    // Segment startTime must be non-negative
    expect(seg.startTime).toBeGreaterThanOrEqual(0);
    // Segment startTime must be <= endTime
    expect(seg.startTime).toBeLessThanOrEqual(seg.endTime);

    for (const word of seg.words) {
      // Word startTime must be non-negative
      expect(word.startTime).toBeGreaterThanOrEqual(0);
      // Word startTime must be <= word endTime
      expect(word.startTime).toBeLessThanOrEqual(word.endTime);
      // Word startTime must be >= segment startTime
      expect(word.startTime).toBeGreaterThanOrEqual(seg.startTime);
      // Word endTime must be <= segment endTime
      expect(word.endTime).toBeLessThanOrEqual(seg.endTime);
    }
  }
}

// ─── Mock Factories ─────────────────────────────────────────────────────────────

/**
 * Creates a mock OpenAI transcription client that returns the given response.
 */
function createMockOpenAIClient(
  response: OpenAITranscriptionResponse,
): OpenAITranscriptionClient {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue(response),
      },
    },
  };
}

/**
 * Creates a mock Deepgram client with controllable event emission.
 * Event handlers are captured so tests can simulate Deepgram transcript events.
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

// ─── Generators: OpenAI Response Shapes ─────────────────────────────────────────

/** Pool of realistic words for transcript text. */
const WORD_POOL = [
  "today", "want", "talk", "about", "importance", "public", "speaking",
  "helps", "connect", "others", "share", "ideas", "effectively", "community",
  "together", "forward", "project", "meeting", "everyone", "believe",
  "strong", "clear", "message", "audience", "practice", "confidence",
  "growth", "learning", "experience", "challenge", "opportunity", "success",
  "leadership", "teamwork", "communication", "feedback", "improve", "develop",
];

/**
 * Generate a random word from the pool.
 */
function arbitraryWord(): fc.Arbitrary<string> {
  return fc.constantFrom(...WORD_POOL);
}

/**
 * Generate an OpenAI response with word-level AND segment-level timestamps.
 * Words are placed within segment boundaries so the response is structurally valid.
 */
function arbitraryResponseWithWordTimestamps(): fc.Arbitrary<OpenAITranscriptionResponse> {
  return fc
    .array(
      fc.tuple(
        // Number of words in this segment (1 to 8)
        fc.integer({ min: 1, max: 8 }),
        // Duration per word (0.1 to 1.0 seconds)
        fc.double({ min: 0.1, max: 1.0, noNaN: true }),
        // Gap between words within segment (0 to 0.3 seconds)
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        // Gap after this segment (0.1 to 3.0 seconds)
        fc.double({ min: 0.1, max: 3.0, noNaN: true }),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .chain((segmentSpecs) => {
      // Generate word texts for each segment
      const wordCountTotal = segmentSpecs.reduce((sum, [wc]) => sum + wc, 0);
      return fc
        .array(arbitraryWord(), {
          minLength: wordCountTotal,
          maxLength: wordCountTotal,
        })
        .map((allWordTexts) => {
          const segments: Array<{ id: number; start: number; end: number; text: string }> = [];
          const words: Array<{ word: string; start: number; end: number }> = [];
          let currentTime = 0;
          let wordIdx = 0;

          for (let segIdx = 0; segIdx < segmentSpecs.length; segIdx++) {
            const [wordCount, wordDuration, intraGap, interGap] = segmentSpecs[segIdx];
            const segStart = currentTime;
            const segWordTexts: string[] = [];

            for (let w = 0; w < wordCount; w++) {
              const wordStart = currentTime;
              const wordEnd = currentTime + wordDuration;
              const wordText = allWordTexts[wordIdx++];
              segWordTexts.push(wordText);

              words.push({ word: wordText, start: wordStart, end: wordEnd });
              currentTime = wordEnd + (w < wordCount - 1 ? intraGap : 0);
            }

            const segEnd = currentTime;
            segments.push({
              id: segIdx,
              start: segStart,
              end: segEnd,
              text: segWordTexts.join(" "),
            });

            currentTime = segEnd + interGap;
          }

          const fullText = segments.map((s) => s.text).join(" ");
          const duration = segments[segments.length - 1].end;

          return {
            text: fullText,
            duration,
            segments,
            words,
          } as OpenAITranscriptionResponse;
        });
    });
}

/**
 * Generate an OpenAI response with word-level timestamps but NO segment boundaries.
 * The engine should create a single segment spanning all words.
 */
function arbitraryResponseWithWordsOnly(): fc.Arbitrary<OpenAITranscriptionResponse> {
  return fc
    .tuple(
      // Number of words (1 to 15)
      fc.integer({ min: 1, max: 15 }),
      // Duration per word (0.1 to 0.8 seconds)
      fc.double({ min: 0.1, max: 0.8, noNaN: true }),
      // Gap between words (0 to 0.3 seconds)
      fc.double({ min: 0, max: 0.3, noNaN: true }),
    )
    .chain(([wordCount, wordDuration, gap]) =>
      fc
        .array(arbitraryWord(), { minLength: wordCount, maxLength: wordCount })
        .map((wordTexts) => {
          const words: Array<{ word: string; start: number; end: number }> = [];
          let currentTime = 0;

          for (const text of wordTexts) {
            const wordStart = currentTime;
            const wordEnd = currentTime + wordDuration;
            words.push({ word: text, start: wordStart, end: wordEnd });
            currentTime = wordEnd + gap;
          }

          const fullText = wordTexts.join(" ");
          const duration = words[words.length - 1].end;

          return {
            text: fullText,
            duration,
            words,
            // No segments — engine creates a single segment
          } as OpenAITranscriptionResponse;
        }),
    );
}

/**
 * Generate an OpenAI response with segment-level timestamps only (no word timestamps).
 * The engine should produce segments with empty words arrays.
 */
function arbitraryResponseWithSegmentsOnly(): fc.Arbitrary<OpenAITranscriptionResponse> {
  return fc
    .array(
      fc.tuple(
        // Number of words in segment text (1 to 10)
        fc.integer({ min: 1, max: 10 }),
        // Segment duration (0.5 to 10 seconds)
        fc.double({ min: 0.5, max: 10, noNaN: true }),
        // Gap after segment (0.1 to 3.0 seconds)
        fc.double({ min: 0.1, max: 3.0, noNaN: true }),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .chain((segmentSpecs) => {
      const wordCountTotal = segmentSpecs.reduce((sum, [wc]) => sum + wc, 0);
      return fc
        .array(arbitraryWord(), {
          minLength: wordCountTotal,
          maxLength: wordCountTotal,
        })
        .map((allWordTexts) => {
          const segments: Array<{ id: number; start: number; end: number; text: string }> = [];
          let currentTime = 0;
          let wordIdx = 0;

          for (let segIdx = 0; segIdx < segmentSpecs.length; segIdx++) {
            const [wordCount, duration, gap] = segmentSpecs[segIdx];
            const segStart = currentTime;
            const segEnd = segStart + duration;
            const segWords = allWordTexts.slice(wordIdx, wordIdx + wordCount);
            wordIdx += wordCount;

            segments.push({
              id: segIdx,
              start: segStart,
              end: segEnd,
              text: segWords.join(" "),
            });

            currentTime = segEnd + gap;
          }

          const fullText = segments.map((s) => s.text).join(" ");
          const duration = segments[segments.length - 1].end;

          return {
            text: fullText,
            duration,
            segments,
            // No words — segment-level fallback
          } as OpenAITranscriptionResponse;
        });
    });
}

/**
 * Generate an OpenAI response with text only (no segments, no words).
 * This is the gpt-4o-transcribe fallback path.
 */
function arbitraryResponseTextOnly(): fc.Arbitrary<OpenAITranscriptionResponse> {
  return fc
    .tuple(
      fc.array(arbitraryWord(), { minLength: 1, maxLength: 20 }),
      // Optional duration (0 means no duration provided)
      fc.oneof(
        fc.constant(undefined),
        fc.double({ min: 1, max: 600, noNaN: true }),
      ),
    )
    .map(([wordTexts, duration]) => ({
      text: wordTexts.join(" "),
      duration,
    }));
}

// ─── Generators: Deepgram Transcript Events ─────────────────────────────────────

/**
 * Generate a realistic Deepgram transcript event with valid structural properties.
 * Words are placed within the event's [start, start+duration] time range.
 */
function arbitraryDeepgramEvent(): fc.Arbitrary<{
  transcript: string;
  start: number;
  duration: number;
  is_final: boolean;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    punctuated_word: string;
  }>;
}> {
  return fc
    .tuple(
      // Event start time (0 to 600 seconds)
      fc.double({ min: 0, max: 600, noNaN: true }),
      // Event duration (0.1 to 5 seconds)
      fc.double({ min: 0.1, max: 5, noNaN: true }),
      // Number of words (1 to 8)
      fc.integer({ min: 1, max: 8 }),
      // Is final
      fc.boolean(),
      // Word confidence (0.5 to 1.0)
      fc.double({ min: 0.5, max: 1.0, noNaN: true }),
    )
    .chain(([start, duration, wordCount, isFinal, confidence]) =>
      fc
        .array(arbitraryWord(), { minLength: wordCount, maxLength: wordCount })
        .map((wordTexts) => {
          const words = wordTexts.map((text, i) => {
            const wordDuration = duration / wordCount;
            const wordStart = start + i * wordDuration;
            const wordEnd = wordStart + wordDuration;
            return {
              word: text.toLowerCase(),
              start: wordStart,
              end: Math.min(wordEnd, start + duration),
              confidence,
              punctuated_word: text,
            };
          });

          return {
            transcript: wordTexts.join(" "),
            start,
            duration,
            is_final: isFinal,
            words,
          };
        }),
    );
}

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: ai-toastmasters-evaluator, Property 1: Transcript Structural Invariant", () => {
  // ─── finalize() path: OpenAI post-speech transcription ──────────────────────

  describe("finalize() — OpenAI post-speech transcription", () => {
    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (word + segment timestamps)
     *
     * For any OpenAI response with both word-level and segment-level timestamps,
     * every segment produced by finalize() SHALL have non-negative startTime <= endTime,
     * and every word within a segment SHALL have timestamps within the segment's range.
     */
    it("structural invariant holds for responses with word + segment timestamps", () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryResponseWithWordTimestamps(),
          async (response) => {
            const deepgramMock = createMockDeepgramClient();
            const openaiClient = createMockOpenAIClient(response);
            const engine = new TranscriptionEngine(
              deepgramMock.client,
              openaiClient,
              undefined,
              "whisper-1",
            );

            const segments = await engine.finalize(Buffer.alloc(3200));
            assertStructuralInvariant(segments);
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (words only, no segments)
     *
     * For any OpenAI response with word-level timestamps but no segment boundaries,
     * finalize() creates a single segment and the structural invariant SHALL hold.
     */
    it("structural invariant holds for responses with words only (no segments)", () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryResponseWithWordsOnly(),
          async (response) => {
            const deepgramMock = createMockDeepgramClient();
            const openaiClient = createMockOpenAIClient(response);
            const engine = new TranscriptionEngine(
              deepgramMock.client,
              openaiClient,
              undefined,
              "whisper-1",
            );

            const segments = await engine.finalize(Buffer.alloc(3200));
            assertStructuralInvariant(segments);
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (segment-level only)
     *
     * For any OpenAI response with segment-level timestamps but no word timestamps,
     * every segment produced by finalize() SHALL have non-negative startTime <= endTime
     * and an empty words array (segment-level fallback).
     */
    it("structural invariant holds for responses with segment-level timestamps only", () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryResponseWithSegmentsOnly(),
          async (response) => {
            const deepgramMock = createMockDeepgramClient();
            const openaiClient = createMockOpenAIClient(response);
            const engine = new TranscriptionEngine(
              deepgramMock.client,
              openaiClient,
            );

            const segments = await engine.finalize(Buffer.alloc(3200));
            assertStructuralInvariant(segments);

            // Segment-level fallback: words array should be empty
            for (const seg of segments) {
              expect(seg.words).toEqual([]);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (text-only fallback)
     *
     * For any OpenAI response with text only (gpt-4o-transcribe path),
     * finalize() produces a single segment with non-negative startTime <= endTime
     * and an empty words array.
     */
    it("structural invariant holds for text-only responses (gpt-4o-transcribe fallback)", () => {
      fc.assert(
        fc.asyncProperty(
          arbitraryResponseTextOnly(),
          async (response) => {
            const deepgramMock = createMockDeepgramClient();
            const openaiClient = createMockOpenAIClient(response);
            const engine = new TranscriptionEngine(
              deepgramMock.client,
              openaiClient,
            );

            const segments = await engine.finalize(Buffer.alloc(3200));
            assertStructuralInvariant(segments);

            // Text-only: single segment with empty words
            expect(segments.length).toBeLessThanOrEqual(1);
            for (const seg of segments) {
              expect(seg.words).toEqual([]);
              expect(seg.isFinal).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── startLive() path: Deepgram live captions ───────────────────────────────

  describe("startLive() — Deepgram live captions", () => {
    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (live captions)
     *
     * For any Deepgram transcript event with words and timing data,
     * the segment emitted via the onSegment callback SHALL have
     * non-negative startTime <= endTime, and every word within the segment
     * SHALL have timestamps within the segment's time range.
     */
    it("structural invariant holds for segments emitted from Deepgram live caption events", () => {
      fc.assert(
        fc.property(
          arbitraryDeepgramEvent(),
          (eventData) => {
            const deepgramMock = createMockDeepgramClient();
            const engine = new TranscriptionEngine(deepgramMock.client);

            const emittedSegments: TranscriptSegment[] = [];
            engine.startLive((segment) => {
              emittedSegments.push(segment);
            });

            // Build a Deepgram-shaped event object
            const deepgramEvent = {
              type: "Results",
              channel_index: [0, 1],
              duration: eventData.duration,
              start: eventData.start,
              is_final: eventData.is_final,
              speech_final: false,
              channel: {
                alternatives: [
                  {
                    transcript: eventData.transcript,
                    confidence: 0.95,
                    words: eventData.words,
                  },
                ],
              },
            };

            // Emit the event through the mock
            deepgramMock.emit(
              LiveTranscriptionEvents.Transcript,
              deepgramEvent,
            );

            // Should have emitted exactly one segment
            expect(emittedSegments).toHaveLength(1);
            assertStructuralInvariant(emittedSegments);

            engine.stopLive();
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 2.2**
     *
     * Property 1: Transcript Structural Invariant (multiple live events)
     *
     * For any sequence of Deepgram transcript events, every segment emitted
     * via the onSegment callback SHALL satisfy the structural invariant.
     */
    it("structural invariant holds across multiple sequential Deepgram events", () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryDeepgramEvent(), { minLength: 1, maxLength: 10 }),
          (events) => {
            const deepgramMock = createMockDeepgramClient();
            const engine = new TranscriptionEngine(deepgramMock.client);

            const emittedSegments: TranscriptSegment[] = [];
            engine.startLive((segment) => {
              emittedSegments.push(segment);
            });

            for (const eventData of events) {
              const deepgramEvent = {
                type: "Results",
                channel_index: [0, 1],
                duration: eventData.duration,
                start: eventData.start,
                is_final: eventData.is_final,
                speech_final: false,
                channel: {
                  alternatives: [
                    {
                      transcript: eventData.transcript,
                      confidence: 0.95,
                      words: eventData.words,
                    },
                  ],
                },
              };

              deepgramMock.emit(
                LiveTranscriptionEvents.Transcript,
                deepgramEvent,
              );
            }

            // Every emitted segment must satisfy the invariant
            expect(emittedSegments).toHaveLength(events.length);
            assertStructuralInvariant(emittedSegments);

            engine.stopLive();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
