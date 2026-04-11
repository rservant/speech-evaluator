// AI Speech Evaluator - Transcription Engine
// Manages two transcription passes:
//   1. Deepgram live captions (for UI display during recording) — implemented here
//   2. OpenAI post-speech final transcript (for metrics/evaluation) — implemented in task 7.2
//
// Requirements: 2.1 (audio capture), 2.2 (timestamped transcript), 2.3 (speech duration), 2.4 (live display)
// Privacy: Audio chunks are in-memory only, sent to Deepgram for live transcription
//          and to OpenAI for post-speech transcription. Never written to disk.
//          Live transcript segments are in-memory only, replaced by final transcript after post-pass.

import type { DeepgramClient, ListenLiveClient, LiveSchema } from "@deepgram/sdk";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import type { TranscriptSegment, TranscriptWord } from "./types.js";
import { withRetry } from "./retry.js";

// ─── OpenAI transcription client interface (for testability / dependency injection) ──

/**
 * Minimal interface for the OpenAI audio transcriptions API surface we use.
 * This allows injecting a mock client in tests without importing the full SDK.
 *
 * The `create` method mirrors the OpenAI SDK's `audio.transcriptions.create()`.
 * We define two overloads:
 *   1. With `response_format: "verbose_json"` → returns TranscriptionVerbose (segments + words)
 *   2. With `response_format: "json"` or omitted → returns Transcription (text only)
 *
 * This supports both whisper-1 (verbose_json with timestamps) and gpt-4o-transcribe
 * (json text only), with graceful segment-level fallback when word timestamps are unavailable.
 */
export interface OpenAITranscriptionClient {
  audio: {
    transcriptions: {
      create(params: {
        file: File;
        model: string;
        response_format?: string;
        timestamp_granularities?: Array<"word" | "segment">;
        language?: string;
        prompt?: string;
      }): Promise<OpenAITranscriptionResponse>;
    };
  };
}

/**
 * Union of possible transcription response shapes from the OpenAI API.
 *
 * - `text` is always present (the full transcript text).
 * - `segments` and `words` are only present with `verbose_json` response format
 *   (whisper-1 model). For gpt-4o-transcribe, only `text` is returned.
 * - `duration` is present in verbose_json responses.
 */
export interface OpenAITranscriptionResponse {
  text: string;
  duration?: number;
  language?: string;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
}

/**
 * Default configuration for the Deepgram live transcription connection.
 * Matches the Audio Format Contract: mono, LINEAR16, 16kHz.
 */
const DEFAULT_LIVE_CONFIG: LiveSchema = {
  model: "nova-2",
  language: "en",
  encoding: "linear16",
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  punctuate: true,
  smart_format: true,
  diarize: true, // #157 — speaker diarization
};

/**
 * Optional callbacks for the live transcription session.
 * Used to notify callers about reconnection status (#139).
 */
export interface LiveStartOptions {
  /** Called when connection drops and reconnection starts/completes/fails. */
  onReconnectStatus?: (status: "reconnecting" | "reconnected" | "failed") => void;
}

/**
 * TranscriptionEngine manages live captioning via Deepgram and post-speech
 * transcription via OpenAI. Both clients are injected for testability.
 *
 * Design decisions:
 * - Auto-reconnect on drop: up to 3 attempts with exponential backoff. Audio is
 *   buffered during the gap and replayed after successful reconnect (#139).
 * - Interim vs final segments: both emitted with `isFinal` flag for UI responsiveness.
 * - Post-speech pass (finalize) produces the canonical transcript for metrics/evaluation.
 * - gpt-4o-transcribe returns text-only (no word timestamps), so we use segment-level
 *   fallback by default. If the response includes word-level timestamps (e.g., from
 *   whisper-1 with verbose_json), those are used for higher precision.
 */
export class TranscriptionEngine {
  private deepgramClient: DeepgramClient;
  private openaiClient: OpenAITranscriptionClient | null;
  private liveClient: ListenLiveClient | null = null;
  private onSegmentCallback: ((segment: TranscriptSegment) => void) | null = null;
  private _qualityWarning = false;
  private liveConfig: LiveSchema;
  private openaiModel: string;
  private _reconnecting = false;
  private _stopped = false;
  private reconnectBuffer: Buffer[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectOptions: LiveStartOptions = {};

  constructor(
    deepgramClient: DeepgramClient,
    openaiClient?: OpenAITranscriptionClient,
    config?: Partial<LiveSchema>,
    openaiModel?: string,
  ) {
    this.deepgramClient = deepgramClient;
    this.openaiClient = openaiClient ?? null;
    this.liveConfig = { ...DEFAULT_LIVE_CONFIG, ...config };
    this.openaiModel = openaiModel ?? "whisper-1";
  }

  /**
   * Whether a quality warning has been flagged (e.g., connection drop during recording).
   * When true, the post-speech OpenAI transcription pass still produces a usable final transcript.
   */
  get qualityWarning(): boolean {
    return this._qualityWarning;
  }

  /**
   * Opens a Deepgram WebSocket connection for live captioning.
   * Each transcript result from Deepgram is converted to a TranscriptSegment
   * and emitted via the onSegment callback.
   *
   * On unexpected close or error, automatically reconnects up to 3 times
   * with exponential backoff. Audio is buffered during the gap and replayed
   * after successful reconnect (#139).
   *
   * Audio format: mono LINEAR16 16kHz (per Audio Format Contract).
   *
   * @param onSegment - Callback invoked for each interim or final transcript segment.
   * @param options - Optional reconnection callbacks.
   * @throws Error if a live session is already active.
   */
  startLive(onSegment: (segment: TranscriptSegment) => void, options?: LiveStartOptions): void {
    if (this.liveClient) {
      throw new Error("Live transcription session already active. Call stopLive() first.");
    }

    this._qualityWarning = false;
    this._stopped = false;
    this._reconnecting = false;
    this.reconnectAttempts = 0;
    this.reconnectBuffer = [];
    this.onSegmentCallback = onSegment;
    this.reconnectOptions = options ?? {};

    this.openLiveConnection();
  }

  /**
   * Opens a Deepgram live WebSocket and wires up event handlers.
   * Called from startLive() and from the reconnection loop.
   */
  private openLiveConnection(): void {
    this.liveClient = this.deepgramClient.listen.live(this.liveConfig);

    // Handle transcript results (both interim and final)
    this.liveClient.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
      const event = data as DeepgramTranscriptEvent;
      this.handleTranscriptEvent(event);
    });

    // Handle connection errors — attempt reconnection (#139)
    this.liveClient.on(LiveTranscriptionEvents.Error, (_error: unknown) => {
      if (!this._stopped) {
        this.handleUnexpectedDrop();
      }
    });

    // Handle unexpected close — attempt reconnection (#139)
    this.liveClient.on(LiveTranscriptionEvents.Close, () => {
      if (!this._stopped) {
        this.handleUnexpectedDrop();
      }
    });
  }

  /**
   * Handles an unexpected WebSocket close or error.
   * Initiates async reconnection with exponential backoff.
   * Audio is buffered during the gap and replayed after success.
   */
  private handleUnexpectedDrop(): void {
    if (this._reconnecting || this._stopped) return;
    this._reconnecting = true;
    this.liveClient = null;

    this.reconnectOptions.onReconnectStatus?.("reconnecting");

    this.reconnectLoop().catch(() => {
      // All retries exhausted — quality warning set inside reconnectLoop
    });
  }

  /**
   * Reconnection loop: attempts to re-open the Deepgram WS up to maxReconnectAttempts times.
   */
  private async reconnectLoop(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      if (this._stopped) return;

      this.reconnectAttempts = attempt;

      // Exponential backoff: 500ms, 1000ms, 2000ms
      const delay = 500 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));

      if (this._stopped) return;

      try {
        this.openLiveConnection();
        this._reconnecting = false;

        // Replay buffered audio
        const buffered = this.reconnectBuffer;
        this.reconnectBuffer = [];
        for (const chunk of buffered) {
          if (this.liveClient) {
            this.liveClient.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
          }
        }

        this.reconnectOptions.onReconnectStatus?.("reconnected");
        return;
      } catch {
        // Connection attempt failed, try next
      }
    }

    // All attempts exhausted
    this._reconnecting = false;
    this._qualityWarning = true;
    this.reconnectOptions.onReconnectStatus?.("failed");
  }

  /**
   * Forwards an audio chunk to the active Deepgram WebSocket connection.
   * Audio must be mono LINEAR16 16kHz (per Audio Format Contract).
   *
   * @param chunk - Raw PCM audio buffer (16-bit, mono, 16kHz).
   * @throws Error if no live session is active.
   */
  feedAudio(chunk: Buffer): void {
    // During reconnection, buffer audio for replay after reconnect (#139)
    if (this._reconnecting) {
      this.reconnectBuffer.push(Buffer.from(chunk));
      return;
    }

    if (!this.liveClient) {
      throw new Error("No active live transcription session. Call startLive() first.");
    }

    // Convert Buffer to ArrayBuffer for the Deepgram SDK's SocketDataLike type
    this.liveClient.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }

  /**
   * Gracefully closes the Deepgram WebSocket connection.
   * After calling this, feedAudio() will throw until startLive() is called again.
   */
  stopLive(): void {
    if (!this.liveClient && !this._reconnecting) {
      return; // Already stopped, no-op
    }

    this._stopped = true;
    this._reconnecting = false;
    this.reconnectBuffer = [];

    const client = this.liveClient;
    this.liveClient = null;
    this.onSegmentCallback = null;

    // Request graceful close from Deepgram
    if (client) {
      try {
        client.requestClose();
      } catch {
        // Ignore errors during close — connection may already be dead
      }
    }
  }

  /**
   * Post-speech final transcript via OpenAI gpt-4o-transcribe.
   *
   * Sends the concatenated audio buffer to OpenAI's audio transcription API
   * and parses the response into TranscriptSegment[] with word-level timestamps
   * when available, falling back to segment-level timestamps otherwise.
   *
   * Privacy: Audio is sent to OpenAI in-memory only, never written to disk.
   * The returned transcript is the canonical source for metrics and evidence.
   *
   * @param fullAudio - Concatenated audio buffer (mono LINEAR16 16kHz PCM).
   * @returns Finalized transcript segments, all with `isFinal: true`.
   * @throws Error if no OpenAI client was provided.
   */
  async finalize(fullAudio: Buffer, options?: { model?: string }): Promise<TranscriptSegment[]> {
    if (!this.openaiClient) {
      throw new Error(
        "No OpenAI client configured. Provide an OpenAI client in the constructor for post-speech transcription.",
      );
    }

    if (fullAudio.length === 0) {
      return [];
    }

    // Use override model if provided, otherwise fall back to the constructor default
    const model = options?.model ?? this.openaiModel;
    const useVerboseJson = model === "whisper-1";

    // Whisper API has a 25MB file limit. If the WAV exceeds that, chunk the audio.
    const MAX_CHUNK_BYTES = 24 * 1024 * 1024; // 24MB — leaves headroom for WAV header + multipart encoding overhead under OpenAI's 25MB limit
    if (fullAudio.length > MAX_CHUNK_BYTES) {
      return this.finalizeChunked(fullAudio, model, useVerboseJson);
    }

    const wavBuffer = this.createWavBuffer(fullAudio);
    const audioFile = new File(
      [new Uint8Array(wavBuffer.buffer as ArrayBuffer, wavBuffer.byteOffset, wavBuffer.byteLength)],
      "speech.wav",
      { type: "audio/wav" },
    );

    const response = await withRetry(
      () => this.openaiClient!.audio.transcriptions.create({
        file: audioFile,
        model,
        language: "en",
        ...(useVerboseJson
          ? {
              response_format: "verbose_json",
              timestamp_granularities: ["word", "segment"],
            }
          : {
              response_format: "json",
            }),
      }),
      { label: "openai-transcription" },
    );

    return this.parseTranscriptionResponse(response);
  }

  /**
   * Transcribe audio in chunks when it exceeds the 25MB Whisper API limit.
   * Each chunk is transcribed independently, then segments are merged with
   * timestamp offsets based on the cumulative duration of previous chunks.
   */
  private async finalizeChunked(
    fullAudio: Buffer,
    model: string,
    useVerboseJson: boolean,
  ): Promise<TranscriptSegment[]> {
    const MAX_CHUNK_BYTES = 24 * 1024 * 1024; // 24MB — leaves headroom for WAV header + multipart encoding overhead under OpenAI's 25MB limit
    const allSegments: TranscriptSegment[] = [];
    let timeOffset = 0;

    for (let offset = 0; offset < fullAudio.length; offset += MAX_CHUNK_BYTES) {
      const chunkEnd = Math.min(offset + MAX_CHUNK_BYTES, fullAudio.length);
      const chunkAudio = fullAudio.subarray(offset, chunkEnd);

      const wavBuffer = this.createWavBuffer(chunkAudio);
      const audioFile = new File(
        [new Uint8Array(wavBuffer.buffer as ArrayBuffer, wavBuffer.byteOffset, wavBuffer.byteLength)],
        "speech.wav",
        { type: "audio/wav" },
      );

      const response = await withRetry(
        () => this.openaiClient!.audio.transcriptions.create({
          file: audioFile,
          model,
          language: "en",
          ...(useVerboseJson
            ? {
                response_format: "verbose_json",
                timestamp_granularities: ["word", "segment"],
              }
            : {
                response_format: "json",
              }),
        }),
        { label: "openai-transcription-chunk" },
      );

      const chunkSegments = this.parseTranscriptionResponse(response);

      // Offset timestamps for all segments after the first chunk
      for (const seg of chunkSegments) {
        seg.startTime += timeOffset;
        seg.endTime += timeOffset;
        for (const word of seg.words) {
          word.startTime += timeOffset;
          word.endTime += timeOffset;
        }
        allSegments.push(seg);
      }

      // Advance the time offset by this chunk's duration
      const chunkDuration = response.duration ?? 0;
      timeOffset += chunkDuration;
    }

    return allSegments;
  }

  /**
   * Creates a WAV buffer from raw PCM audio data.
   * Audio must be mono LINEAR16 16kHz PCM.
   */
  private createWavBuffer(pcmAudio: Buffer): Buffer {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmAudio.byteLength;
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + dataSize, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(dataSize, 40);
    return Buffer.concat([wavHeader, pcmAudio]);
  }

  /**
   * Parses an OpenAI transcription response into our TranscriptSegment[] format.
   *
   * Three paths:
   * 1. Word-level timestamps available (verbose_json with words) → high precision
   * 2. Segment-level timestamps available (verbose_json with segments but no words) → medium precision
   * 3. Text only (gpt-4o-transcribe json response) → segment-level fallback with estimated timing
   *
   * All returned segments have `isFinal: true` since this is the post-speech canonical transcript.
   */
  private parseTranscriptionResponse(
    response: OpenAITranscriptionResponse,
  ): TranscriptSegment[] {
    const text = response.text?.trim();
    if (!text) {
      return [];
    }

    // Path 1: Word-level timestamps available
    if (response.words && response.words.length > 0) {
      return this.parseWithWordTimestamps(response.words, response.segments);
    }

    // Path 2: Segment-level timestamps available (no word timestamps)
    if (response.segments && response.segments.length > 0) {
      return this.parseWithSegmentTimestamps(response.segments);
    }

    // Path 3: Text only — create a single segment with no word-level timing.
    // Duration comes from the response if available, otherwise we estimate from text length.
    const duration = response.duration ?? 0;
    return [
      {
        text,
        startTime: 0,
        endTime: duration,
        words: [],
        isFinal: true,
      },
    ];
  }

  /**
   * Parses word-level timestamps into segments.
   *
   * If OpenAI segments are available, we use them as segment boundaries and attach
   * the corresponding words to each segment. If no segments are provided, we create
   * a single segment spanning all words.
   */
  private parseWithWordTimestamps(
    words: Array<{ word: string; start: number; end: number }>,
    segments?: Array<{ id: number; start: number; end: number; text: string }>,
  ): TranscriptSegment[] {
    // Convert OpenAI words to our TranscriptWord format
    const allWords: TranscriptWord[] = words.map((w) => ({
      word: w.word,
      startTime: w.start,
      endTime: w.end,
      confidence: 1.0, // OpenAI doesn't provide per-word confidence in this format
    }));

    if (segments && segments.length > 0) {
      // Attach words to their corresponding segments by time overlap
      return segments.map((seg) => {
        const segWords = allWords.filter(
          (w) => w.startTime >= seg.start && w.endTime <= seg.end,
        );
        return {
          text: seg.text.trim(),
          startTime: seg.start,
          endTime: seg.end,
          words: segWords,
          isFinal: true,
        };
      });
    }

    // No segments — create a single segment from all words
    if (allWords.length === 0) {
      return [];
    }

    const fullText = words.map((w) => w.word).join(" ");
    return [
      {
        text: fullText,
        startTime: allWords[0].startTime,
        endTime: allWords[allWords.length - 1].endTime,
        words: allWords,
        isFinal: true,
      },
    ];
  }

  /**
   * Parses segment-level timestamps (no word-level timing).
   *
   * Each segment gets an empty `words` array, signaling to downstream consumers
   * (MetricsExtractor, EvidenceValidator) that they should use segment-level fallback
   * for pause detection and timestamp locality checks.
   */
  private parseWithSegmentTimestamps(
    segments: Array<{ id: number; start: number; end: number; text: string }>,
  ): TranscriptSegment[] {
    return segments
      .filter((seg) => seg.text.trim().length > 0)
      .map((seg) => ({
        text: seg.text.trim(),
        startTime: seg.start,
        endTime: seg.end,
        words: [],
        isFinal: true,
      }));
  }

  /**
   * Converts a Deepgram transcript event into our TranscriptSegment format
   * and emits it via the onSegment callback.
   */
  private handleTranscriptEvent(event: DeepgramTranscriptEvent): void {
    if (!this.onSegmentCallback) {
      return;
    }

    // Deepgram may return empty alternatives or empty transcript text for silence
    const alternative = event.channel?.alternatives?.[0];
    if (!alternative || !alternative.transcript) {
      return;
    }

    const isFinal = event.is_final === true;

    // Convert Deepgram words to our TranscriptWord format
    const words: TranscriptWord[] = (alternative.words ?? []).map((w) => ({
      word: w.punctuated_word ?? w.word,
      startTime: w.start,
      endTime: w.end,
      confidence: w.confidence,
      ...(w.speaker !== undefined ? { speakerId: w.speaker } : {}),
    }));

    // Compute segment time range from Deepgram's event-level timing
    const startTime = event.start;
    const endTime = event.start + event.duration;

    // Determine segment-level speaker from mode of word speakers (#157)
    const speakerIds = words.map((w) => w.speakerId).filter((s): s is number => s !== undefined);
    const segmentSpeaker = speakerIds.length > 0 ? mode(speakerIds) : undefined;

    const segment: TranscriptSegment = {
      text: alternative.transcript,
      startTime,
      endTime,
      words,
      isFinal,
      ...(segmentSpeaker !== undefined ? { speakerId: segmentSpeaker } : {}),
    };

    this.onSegmentCallback(segment);
  }
}

/**
 * Shape of a Deepgram live transcription event.
 * Matches the LiveTranscriptionEvent type from @deepgram/sdk but defined
 * locally to avoid tight coupling with SDK internals.
 */
interface DeepgramTranscriptEvent {
  type: string;
  channel_index: number[];
  duration: number;
  start: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
      words: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
        punctuated_word?: string;
        speaker?: number; // #157 — diarization speaker label
      }>;
    }>;
  };
}

/**
 * Returns the mode (most frequent value) from an array of numbers.
 * Used to determine the dominant speaker in a segment.
 */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let maxCount = 0;
  let maxVal = values[0];
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > maxCount) {
      maxCount = c;
      maxVal = v;
    }
  }
  return maxVal;
}
