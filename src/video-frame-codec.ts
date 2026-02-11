/**
 * Binary frame codec for TM-prefixed wire format.
 *
 * Wire format: [0x54 0x4D magic ("TM")][type byte][3-byte big-endian uint24 header JSON length][UTF-8 header JSON][payload bytes]
 *
 * Video frames: type byte 0x56, payload = JPEG bytes
 * Audio frames: type byte 0x41, payload = PCM bytes
 *
 * Requirements: 10.4, 15.8
 */

import type { FrameHeader, AudioFrameHeader, FrameType } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

const TM_MAGIC_0 = 0x54; // 'T'
const TM_MAGIC_1 = 0x4d; // 'M'
const TYPE_VIDEO = 0x56; // 'V'
const TYPE_AUDIO = 0x41; // 'A'

/** Minimum valid frame size: 2 (magic) + 1 (type) + 3 (header len) = 6 bytes */
const MIN_FRAME_SIZE = 6;

/** Maximum header JSON size in bytes */
const MAX_HEADER_JSON_BYTES = 4096;

/** Maximum JPEG payload size for video frames (2 MB) */
const MAX_VIDEO_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** Maximum resolution for video frames */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

// ─── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Encode a video frame into the TM-prefixed wire format.
 * Produces: [0x54 0x4D][0x56][uint24 header len][header JSON][JPEG bytes]
 */
export function encodeVideoFrame(header: FrameHeader, jpegBuffer: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
  const totalLen = 2 + 1 + 3 + headerJson.length + jpegBuffer.length;
  const buf = Buffer.alloc(totalLen);

  let offset = 0;
  buf[offset++] = TM_MAGIC_0;
  buf[offset++] = TM_MAGIC_1;
  buf[offset++] = TYPE_VIDEO;

  // Write uint24 big-endian header length
  buf[offset++] = (headerJson.length >> 16) & 0xff;
  buf[offset++] = (headerJson.length >> 8) & 0xff;
  buf[offset++] = headerJson.length & 0xff;

  headerJson.copy(buf, offset);
  offset += headerJson.length;

  jpegBuffer.copy(buf, offset);

  return buf;
}

/**
 * Encode an audio frame into the TM-prefixed wire format.
 * Produces: [0x54 0x4D][0x41][uint24 header len][header JSON][PCM bytes]
 */
export function encodeAudioFrame(header: AudioFrameHeader, pcmBuffer: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
  const totalLen = 2 + 1 + 3 + headerJson.length + pcmBuffer.length;
  const buf = Buffer.alloc(totalLen);

  let offset = 0;
  buf[offset++] = TM_MAGIC_0;
  buf[offset++] = TM_MAGIC_1;
  buf[offset++] = TYPE_AUDIO;

  // Write uint24 big-endian header length
  buf[offset++] = (headerJson.length >> 16) & 0xff;
  buf[offset++] = (headerJson.length >> 8) & 0xff;
  buf[offset++] = headerJson.length & 0xff;

  headerJson.copy(buf, offset);
  offset += headerJson.length;

  pcmBuffer.copy(buf, offset);

  return buf;
}

// ─── Decode ─────────────────────────────────────────────────────────────────────

/**
 * Validate a FrameHeader has all required fields with correct types.
 * Returns true if valid, false otherwise.
 */
function isValidFrameHeader(obj: unknown): obj is FrameHeader {
  if (typeof obj !== "object" || obj === null) return false;
  const h = obj as Record<string, unknown>;

  // timestamp: number >= 0
  if (typeof h.timestamp !== "number" || !isFinite(h.timestamp) || h.timestamp < 0) return false;

  // seq: non-negative integer
  if (typeof h.seq !== "number" || !Number.isInteger(h.seq) || h.seq < 0) return false;

  // width: positive integer
  if (typeof h.width !== "number" || !Number.isInteger(h.width) || h.width <= 0) return false;

  // height: positive integer
  if (typeof h.height !== "number" || !Number.isInteger(h.height) || h.height <= 0) return false;

  return true;
}

/**
 * Validate an AudioFrameHeader has all required fields with correct types.
 */
function isValidAudioFrameHeader(obj: unknown): obj is AudioFrameHeader {
  if (typeof obj !== "object" || obj === null) return false;
  const h = obj as Record<string, unknown>;

  if (typeof h.timestamp !== "number" || !isFinite(h.timestamp) || h.timestamp < 0) return false;
  if (typeof h.seq !== "number" || !Number.isInteger(h.seq) || h.seq < 0) return false;

  return true;
}

/**
 * Decode a video frame from the TM-prefixed wire format.
 * Returns null on malformed input.
 */
export function decodeVideoFrame(data: Buffer): { header: FrameHeader; jpegBuffer: Buffer } | null {
  // Check minimum size
  if (!Buffer.isBuffer(data) || data.length < MIN_FRAME_SIZE) return null;

  // Check TM magic prefix
  if (data[0] !== TM_MAGIC_0 || data[1] !== TM_MAGIC_1) return null;

  // Check type byte
  if (data[2] !== TYPE_VIDEO) return null;

  // Read uint24 big-endian header length
  const headerLen = (data[3] << 16) | (data[4] << 8) | data[5];

  // Validate header length
  if (headerLen <= 0 || headerLen > MAX_HEADER_JSON_BYTES) return null;

  // Check we have enough bytes for the header
  if (data.length < MIN_FRAME_SIZE + headerLen) return null;

  // Parse header JSON
  let header: unknown;
  try {
    const headerStr = data.toString("utf-8", MIN_FRAME_SIZE, MIN_FRAME_SIZE + headerLen);
    header = JSON.parse(headerStr);
  } catch {
    return null;
  }

  // Validate header fields
  if (!isValidFrameHeader(header)) return null;

  // Validate resolution limits
  if (header.width > MAX_WIDTH || header.height > MAX_HEIGHT) return null;

  // Extract JPEG payload
  const jpegBuffer = data.subarray(MIN_FRAME_SIZE + headerLen);

  // Validate JPEG payload size
  if (jpegBuffer.length > MAX_VIDEO_PAYLOAD_BYTES) return null;

  return { header, jpegBuffer };
}

/**
 * Decode an audio frame from the TM-prefixed wire format.
 * Returns null on malformed input.
 */
export function decodeAudioFrame(data: Buffer): { header: AudioFrameHeader; pcmBuffer: Buffer } | null {
  // Check minimum size
  if (!Buffer.isBuffer(data) || data.length < MIN_FRAME_SIZE) return null;

  // Check TM magic prefix
  if (data[0] !== TM_MAGIC_0 || data[1] !== TM_MAGIC_1) return null;

  // Check type byte
  if (data[2] !== TYPE_AUDIO) return null;

  // Read uint24 big-endian header length
  const headerLen = (data[3] << 16) | (data[4] << 8) | data[5];

  // Validate header length
  if (headerLen <= 0 || headerLen > MAX_HEADER_JSON_BYTES) return null;

  // Check we have enough bytes for the header
  if (data.length < MIN_FRAME_SIZE + headerLen) return null;

  // Parse header JSON
  let header: unknown;
  try {
    const headerStr = data.toString("utf-8", MIN_FRAME_SIZE, MIN_FRAME_SIZE + headerLen);
    header = JSON.parse(headerStr);
  } catch {
    return null;
  }

  // Validate header fields
  if (!isValidAudioFrameHeader(header)) return null;

  // Extract PCM payload
  const pcmBuffer = data.subarray(MIN_FRAME_SIZE + headerLen);

  return { header, pcmBuffer };
}

// ─── Inspection ─────────────────────────────────────────────────────────────────

/**
 * Check if a buffer is a TM-prefixed frame (any type).
 * Checks for the 0x54 0x4D magic prefix.
 */
export function isTMFrame(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 2) return false;
  return data[0] === TM_MAGIC_0 && data[1] === TM_MAGIC_1;
}

/**
 * Check if a buffer is a TM-prefixed video frame.
 * Checks magic prefix 0x54 0x4D and type byte 0x56.
 */
export function isVideoFrame(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 3) return false;
  return data[0] === TM_MAGIC_0 && data[1] === TM_MAGIC_1 && data[2] === TYPE_VIDEO;
}

/**
 * Get the frame type from a TM-prefixed buffer.
 * Returns 'audio', 'video', or null if not a valid TM frame.
 */
export function getFrameType(data: Buffer): FrameType | null {
  if (!Buffer.isBuffer(data) || data.length < 3) return null;
  if (data[0] !== TM_MAGIC_0 || data[1] !== TM_MAGIC_1) return null;

  if (data[2] === TYPE_VIDEO) return "video";
  if (data[2] === TYPE_AUDIO) return "audio";

  return null;
}
