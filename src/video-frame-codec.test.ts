/**
 * Unit tests for video-frame-codec.ts
 * Validates: Requirements 10.4, 15.8
 */

import { describe, it, expect } from "vitest";
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeVideoHeader(overrides?: Partial<FrameHeader>): FrameHeader {
  return {
    timestamp: 1.5,
    seq: 0,
    width: 640,
    height: 480,
    ...overrides,
  };
}

function makeAudioHeader(overrides?: Partial<AudioFrameHeader>): AudioFrameHeader {
  return {
    timestamp: 1.5,
    seq: 0,
    ...overrides,
  };
}

/** Create a fake JPEG buffer of given size */
function makeJpeg(size = 100): Buffer {
  return Buffer.alloc(size, 0xff);
}

/** Create a fake PCM buffer of given size */
function makePcm(size = 200): Buffer {
  return Buffer.alloc(size, 0x42);
}

// ─── Video Frame Round-Trip ─────────────────────────────────────────────────────

describe("encodeVideoFrame / decodeVideoFrame round-trip", () => {
  it("round-trips a valid video frame", () => {
    const header = makeVideoHeader();
    const jpeg = makeJpeg();
    const encoded = encodeVideoFrame(header, jpeg);
    const decoded = decodeVideoFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.header).toEqual(header);
    expect(decoded!.jpegBuffer).toEqual(jpeg);
  });

  it("round-trips with zero timestamp and seq", () => {
    const header = makeVideoHeader({ timestamp: 0, seq: 0 });
    const jpeg = makeJpeg(50);
    const encoded = encodeVideoFrame(header, jpeg);
    const decoded = decodeVideoFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.header.timestamp).toBe(0);
    expect(decoded!.header.seq).toBe(0);
  });

  it("round-trips with max resolution 1920x1080", () => {
    const header = makeVideoHeader({ width: 1920, height: 1080 });
    const jpeg = makeJpeg();
    const encoded = encodeVideoFrame(header, jpeg);
    const decoded = decodeVideoFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.header.width).toBe(1920);
    expect(decoded!.header.height).toBe(1080);
  });

  it("preserves JPEG payload bytes exactly", () => {
    const jpeg = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, jpeg);
    const decoded = decodeVideoFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(Buffer.compare(decoded!.jpegBuffer, jpeg)).toBe(0);
  });

  it("round-trips with empty JPEG payload", () => {
    const header = makeVideoHeader();
    const jpeg = Buffer.alloc(0);
    const encoded = encodeVideoFrame(header, jpeg);
    const decoded = decodeVideoFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.jpegBuffer.length).toBe(0);
  });
});

// ─── Audio Frame Round-Trip ─────────────────────────────────────────────────────

describe("encodeAudioFrame / decodeAudioFrame round-trip", () => {
  it("round-trips a valid audio frame", () => {
    const header = makeAudioHeader();
    const pcm = makePcm();
    const encoded = encodeAudioFrame(header, pcm);
    const decoded = decodeAudioFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.header).toEqual(header);
    expect(decoded!.pcmBuffer).toEqual(pcm);
  });

  it("round-trips with zero timestamp and seq", () => {
    const header = makeAudioHeader({ timestamp: 0, seq: 0 });
    const pcm = makePcm(50);
    const encoded = encodeAudioFrame(header, pcm);
    const decoded = decodeAudioFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.header.timestamp).toBe(0);
    expect(decoded!.header.seq).toBe(0);
  });

  it("preserves PCM payload bytes exactly", () => {
    const pcm = Buffer.from([0x00, 0x80, 0x7f, 0xff]);
    const header = makeAudioHeader();
    const encoded = encodeAudioFrame(header, pcm);
    const decoded = decodeAudioFrame(encoded);

    expect(decoded).not.toBeNull();
    expect(Buffer.compare(decoded!.pcmBuffer, pcm)).toBe(0);
  });
});

// ─── Malformed Input Handling ───────────────────────────────────────────────────

describe("decodeVideoFrame malformed input", () => {
  it("returns null for empty buffer", () => {
    expect(decodeVideoFrame(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for buffer too short", () => {
    expect(decodeVideoFrame(Buffer.from([0x54, 0x4d]))).toBeNull();
  });

  it("returns null for missing TM magic prefix", () => {
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, makeJpeg());
    // Corrupt magic bytes
    encoded[0] = 0x00;
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for wrong type byte (audio type on video decode)", () => {
    const header = makeAudioHeader();
    const encoded = encodeAudioFrame(header, makePcm());
    // This is an audio frame, decodeVideoFrame should reject it
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for unknown type byte", () => {
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, makeJpeg());
    // Set type byte to something invalid
    encoded[2] = 0x99;
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for oversized header JSON (> 4096 bytes)", () => {
    // Craft a buffer with header length claiming > 4096
    const buf = Buffer.alloc(10);
    buf[0] = 0x54;
    buf[1] = 0x4d;
    buf[2] = 0x56;
    // uint24 = 4097
    buf[3] = 0x00;
    buf[4] = 0x10;
    buf[5] = 0x01;
    expect(decodeVideoFrame(buf)).toBeNull();
  });

  it("returns null for oversized JPEG payload (> 2MB)", () => {
    const header = makeVideoHeader();
    const bigJpeg = Buffer.alloc(2 * 1024 * 1024 + 1);
    const encoded = encodeVideoFrame(header, bigJpeg);
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for resolution exceeding 1920x1080", () => {
    const header = makeVideoHeader({ width: 1921, height: 1080 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for height exceeding 1080", () => {
    const header = makeVideoHeader({ width: 1920, height: 1081 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for invalid header JSON (corrupt bytes)", () => {
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, makeJpeg());
    // Corrupt the header JSON region
    const headerStart = 6;
    encoded[headerStart] = 0xff;
    encoded[headerStart + 1] = 0xfe;
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for negative timestamp", () => {
    const header = makeVideoHeader({ timestamp: -1 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for negative seq", () => {
    const header = makeVideoHeader({ seq: -1 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for non-integer seq", () => {
    const header = makeVideoHeader({ seq: 1.5 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for zero width", () => {
    const header = makeVideoHeader({ width: 0 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for zero height", () => {
    const header = makeVideoHeader({ height: 0 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for non-integer width", () => {
    const header = makeVideoHeader({ width: 640.5 });
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeVideoFrame(encoded)).toBeNull();
  });

  it("returns null for missing seq field", () => {
    // Manually craft a frame with header missing seq
    const headerObj = { timestamp: 1.0, width: 640, height: 480 };
    const headerJson = Buffer.from(JSON.stringify(headerObj), "utf-8");
    const jpeg = makeJpeg();
    const buf = Buffer.alloc(6 + headerJson.length + jpeg.length);
    buf[0] = 0x54;
    buf[1] = 0x4d;
    buf[2] = 0x56;
    buf[3] = (headerJson.length >> 16) & 0xff;
    buf[4] = (headerJson.length >> 8) & 0xff;
    buf[5] = headerJson.length & 0xff;
    headerJson.copy(buf, 6);
    jpeg.copy(buf, 6 + headerJson.length);

    expect(decodeVideoFrame(buf)).toBeNull();
  });

  it("returns null for truncated buffer (header length exceeds data)", () => {
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, makeJpeg());
    // Truncate to just past the header length field
    const truncated = encoded.subarray(0, 8);
    expect(decodeVideoFrame(truncated)).toBeNull();
  });

  it("returns null for header length of zero", () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0x54;
    buf[1] = 0x4d;
    buf[2] = 0x56;
    buf[3] = 0x00;
    buf[4] = 0x00;
    buf[5] = 0x00; // header len = 0
    expect(decodeVideoFrame(buf)).toBeNull();
  });
});

describe("decodeAudioFrame malformed input", () => {
  it("returns null for empty buffer", () => {
    expect(decodeAudioFrame(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for missing TM magic", () => {
    const buf = Buffer.from([0x00, 0x00, 0x41, 0x00, 0x00, 0x05]);
    expect(decodeAudioFrame(buf)).toBeNull();
  });

  it("returns null for wrong type byte (video type on audio decode)", () => {
    const header = makeVideoHeader();
    const encoded = encodeVideoFrame(header, makeJpeg());
    expect(decodeAudioFrame(encoded)).toBeNull();
  });

  it("returns null for missing seq in audio header", () => {
    const headerObj = { timestamp: 1.0 };
    const headerJson = Buffer.from(JSON.stringify(headerObj), "utf-8");
    const pcm = makePcm();
    const buf = Buffer.alloc(6 + headerJson.length + pcm.length);
    buf[0] = 0x54;
    buf[1] = 0x4d;
    buf[2] = 0x41;
    buf[3] = (headerJson.length >> 16) & 0xff;
    buf[4] = (headerJson.length >> 8) & 0xff;
    buf[5] = headerJson.length & 0xff;
    headerJson.copy(buf, 6);
    pcm.copy(buf, 6 + headerJson.length);

    expect(decodeAudioFrame(buf)).toBeNull();
  });

  it("returns null for negative timestamp in audio header", () => {
    const header = makeAudioHeader({ timestamp: -0.5 });
    const encoded = encodeAudioFrame(header, makePcm());
    expect(decodeAudioFrame(encoded)).toBeNull();
  });
});

// ─── isVideoFrame ───────────────────────────────────────────────────────────────

describe("isVideoFrame", () => {
  it("returns true for a valid video frame", () => {
    const encoded = encodeVideoFrame(makeVideoHeader(), makeJpeg());
    expect(isVideoFrame(encoded)).toBe(true);
  });

  it("returns false for an audio frame", () => {
    const encoded = encodeAudioFrame(makeAudioHeader(), makePcm());
    expect(isVideoFrame(encoded)).toBe(false);
  });

  it("returns false for buffer without TM magic", () => {
    expect(isVideoFrame(Buffer.from([0x00, 0x00, 0x56]))).toBe(false);
  });

  it("returns false for empty buffer", () => {
    expect(isVideoFrame(Buffer.alloc(0))).toBe(false);
  });

  it("returns false for buffer with only magic bytes (no type)", () => {
    expect(isVideoFrame(Buffer.from([0x54, 0x4d]))).toBe(false);
  });

  it("returns false for unknown type byte", () => {
    expect(isVideoFrame(Buffer.from([0x54, 0x4d, 0x99]))).toBe(false);
  });
});

// ─── isTMFrame ──────────────────────────────────────────────────────────────────

describe("isTMFrame", () => {
  it("returns true for a video frame", () => {
    const encoded = encodeVideoFrame(makeVideoHeader(), makeJpeg());
    expect(isTMFrame(encoded)).toBe(true);
  });

  it("returns true for an audio frame", () => {
    const encoded = encodeAudioFrame(makeAudioHeader(), makePcm());
    expect(isTMFrame(encoded)).toBe(true);
  });

  it("returns true for buffer with TM magic and unknown type", () => {
    expect(isTMFrame(Buffer.from([0x54, 0x4d, 0x99]))).toBe(true);
  });

  it("returns false for empty buffer", () => {
    expect(isTMFrame(Buffer.alloc(0))).toBe(false);
  });

  it("returns false for single byte", () => {
    expect(isTMFrame(Buffer.from([0x54]))).toBe(false);
  });

  it("returns false for wrong magic bytes", () => {
    expect(isTMFrame(Buffer.from([0x00, 0x4d]))).toBe(false);
    expect(isTMFrame(Buffer.from([0x54, 0x00]))).toBe(false);
  });
});

// ─── getFrameType ───────────────────────────────────────────────────────────────

describe("getFrameType", () => {
  it("returns 'video' for a video frame", () => {
    const encoded = encodeVideoFrame(makeVideoHeader(), makeJpeg());
    expect(getFrameType(encoded)).toBe("video");
  });

  it("returns 'audio' for an audio frame", () => {
    const encoded = encodeAudioFrame(makeAudioHeader(), makePcm());
    expect(getFrameType(encoded)).toBe("audio");
  });

  it("returns null for unknown type byte", () => {
    expect(getFrameType(Buffer.from([0x54, 0x4d, 0x99]))).toBeNull();
  });

  it("returns null for missing TM magic", () => {
    expect(getFrameType(Buffer.from([0x00, 0x00, 0x56]))).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(getFrameType(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for buffer too short (2 bytes)", () => {
    expect(getFrameType(Buffer.from([0x54, 0x4d]))).toBeNull();
  });
});
