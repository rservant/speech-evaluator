// Property-Based Test: Binary video frame format round-trip
// Feature: phase-4-multimodal-video, Property 7

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  encodeVideoFrame,
  decodeVideoFrame,
  encodeAudioFrame,
  decodeAudioFrame,
  isVideoFrame,
  isTMFrame,
  getFrameType,
} from "./video-frame-codec.js";
import type { FrameHeader, AudioFrameHeader } from "./types.js";

// ─── Generators ─────────────────────────────────────────────────────────────────

/** Generator for valid FrameHeader within safety limits. */
const arbitraryFrameHeader = (): fc.Arbitrary<FrameHeader> =>
  fc.record({
    timestamp: fc.double({ min: 0, max: 86400, noNaN: true, noDefaultInfinity: true }),
    seq: fc.integer({ min: 0, max: 2 ** 24 - 1 }),
    width: fc.integer({ min: 1, max: 1920 }),
    height: fc.integer({ min: 1, max: 1080 }),
  });

/** Generator for valid AudioFrameHeader. */
const arbitraryAudioFrameHeader = (): fc.Arbitrary<AudioFrameHeader> =>
  fc.record({
    timestamp: fc.double({ min: 0, max: 86400, noNaN: true, noDefaultInfinity: true }),
    seq: fc.integer({ min: 0, max: 2 ** 24 - 1 }),
  });

/**
 * Generator for JPEG-like payloads within the 2MB safety limit.
 * Uses small buffers to keep tests fast while still exercising arbitrary byte content.
 */
const arbitraryJpegBuffer = (): fc.Arbitrary<Buffer> =>
  fc.uint8Array({ minLength: 0, maxLength: 4096 }).map((arr) => Buffer.from(arr));

/**
 * Generator for PCM-like payloads with arbitrary byte content.
 */
const arbitraryPcmBuffer = (): fc.Arbitrary<Buffer> =>
  fc.uint8Array({ minLength: 0, maxLength: 4096 }).map((arr) => Buffer.from(arr));

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 7: Binary video frame format round-trip", () => {
  /**
   * **Validates: Requirements 10.4**
   *
   * For any valid FrameHeader and JPEG byte payload within safety limits,
   * encoding into the wire format and then decoding SHALL produce an
   * identical FrameHeader and identical JPEG bytes.
   */

  it("video frame encode → decode produces identical header and payload", () => {
    fc.assert(
      fc.property(arbitraryFrameHeader(), arbitraryJpegBuffer(), (header, jpegBuffer) => {
        const encoded = encodeVideoFrame(header, jpegBuffer);
        const decoded = decodeVideoFrame(encoded);

        expect(decoded).not.toBeNull();
        expect(decoded!.header).toEqual(header);
        expect(Buffer.compare(decoded!.jpegBuffer, jpegBuffer)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * For any valid AudioFrameHeader and PCM byte payload,
   * encoding into the wire format and then decoding SHALL produce an
   * identical AudioFrameHeader and identical PCM bytes.
   */

  it("audio frame encode → decode produces identical header and payload", () => {
    fc.assert(
      fc.property(arbitraryAudioFrameHeader(), arbitraryPcmBuffer(), (header, pcmBuffer) => {
        const encoded = encodeAudioFrame(header, pcmBuffer);
        const decoded = decodeAudioFrame(encoded);

        expect(decoded).not.toBeNull();
        expect(decoded!.header).toEqual(header);
        expect(Buffer.compare(decoded!.pcmBuffer, pcmBuffer)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * For any valid video frame, isVideoFrame returns true, isTMFrame returns true,
   * and getFrameType returns 'video'.
   */

  it("encoded video frames are correctly identified by inspection functions", () => {
    fc.assert(
      fc.property(arbitraryFrameHeader(), arbitraryJpegBuffer(), (header, jpegBuffer) => {
        const encoded = encodeVideoFrame(header, jpegBuffer);

        expect(isVideoFrame(encoded)).toBe(true);
        expect(isTMFrame(encoded)).toBe(true);
        expect(getFrameType(encoded)).toBe("video");
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * For any valid audio frame, isVideoFrame returns false,
   * isTMFrame returns true, and getFrameType returns 'audio'.
   */

  it("encoded audio frames are correctly identified by inspection functions", () => {
    fc.assert(
      fc.property(arbitraryAudioFrameHeader(), arbitraryPcmBuffer(), (header, pcmBuffer) => {
        const encoded = encodeAudioFrame(header, pcmBuffer);

        expect(isVideoFrame(encoded)).toBe(false);
        expect(isTMFrame(encoded)).toBe(true);
        expect(getFrameType(encoded)).toBe("audio");
      }),
      { numRuns: 200 },
    );
  });
});
