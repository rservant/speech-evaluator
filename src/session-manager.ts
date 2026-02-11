// AI Toastmasters Evaluator - Session Manager
// Central orchestrator managing session state transitions and coordination.
// Requirements: 1.1 (initial state), 1.2 (start recording), 1.4 (stop recording),
//               1.6 (deliver evaluation), 1.8 (return to initial state), 7.1 (quality)
//
// Privacy: Audio chunks are in-memory only, never written to disk.
// Concatenated audio buffer for finalize() is also in-memory only.
// After finalize(), the concatenated buffer can be garbage collected.

import { v4 as uuidv4 } from "uuid";
import { Session, SessionState } from "./types.js";
import type {
  ConsentRecord,
  TranscriptSegment,
  DeliveryMetrics,
  StructuredEvaluation,
  StructuredEvaluationPublic,
  PipelineStage,
  EvaluationCache,
  EvaluationConfig,
  ProjectContext,
  SessionVADConfig,
  VideoConsent,
  VideoConfig,
  FrameHeader,
  VisualObservations,
} from "./types.js";
import type { VideoProcessor, VideoProcessorDeps } from "./video-processor.js";
import { createDeferred } from "./utils/deferred.js";
import type { TranscriptionEngine } from "./transcription-engine.js";
import type { MetricsExtractor } from "./metrics-extractor.js";
import type { EvaluationGenerator } from "./evaluation-generator.js";
import type { TTSEngine } from "./tts-engine.js";
import type { ToneChecker } from "./tone-checker.js";
import type { FilePersistence } from "./file-persistence.js";
import type { VADMonitor, VADConfig, VADEventCallback } from "./vad-monitor.js";

// ─── Quality thresholds (matching EvaluationGenerator's internal thresholds) ────

const MIN_WORDS_PER_MINUTE = 10;
const MIN_AVERAGE_CONFIDENCE = 0.5;

// ─── Non-speech marker detection ────────────────────────────────────────────────

/**
 * Common non-speech tokens emitted by transcription engines.
 * These are excluded from confidence computation per Req 10.1.
 */
const NON_SPEECH_MARKERS = new Set([
  "[silence]",
  "[noise]",
  "[music]",
  "[inaudible]",
  "[laughter]",
  "[applause]",
  "[crosstalk]",
  "[blank_audio]",
]);

/**
 * Returns true if a word is a silence or non-speech marker.
 * A word is considered a marker if:
 * - Its text is empty or whitespace-only
 * - Its text (lowercased, trimmed) matches a known non-speech token
 */
function isSilenceOrNonSpeechMarker(word: string): boolean {
  const trimmed = word.trim();
  if (trimmed.length === 0) return true;
  return NON_SPEECH_MARKERS.has(trimmed.toLowerCase());
}

// ─── Dependency injection interface ─────────────────────────────────────────────

export interface SessionManagerDeps {
  transcriptionEngine?: TranscriptionEngine;
  metricsExtractor?: MetricsExtractor;
  evaluationGenerator?: EvaluationGenerator;
  ttsEngine?: TTSEngine;
  toneChecker?: ToneChecker;
  filePersistence?: FilePersistence;
  vadMonitorFactory?: (config: VADConfig, callbacks: VADEventCallback) => VADMonitor;
  videoProcessorFactory?: (config: VideoConfig, deps: VideoProcessorDeps) => VideoProcessor;
}

/**
 * Valid state transitions for the session state machine.
 *
 * IDLE → RECORDING:    startRecording()
 * RECORDING → PROCESSING: stopRecording()
 * PROCESSING → DELIVERING: generateEvaluation() → TTS starts
 * DELIVERING → IDLE:    completeDelivery() (TTS complete)
 *
 * panicMute() can transition from ANY state → IDLE
 */
const VALID_TRANSITIONS: ReadonlyMap<SessionState, SessionState> = new Map([
  [SessionState.IDLE, SessionState.RECORDING],
  [SessionState.RECORDING, SessionState.PROCESSING],
  [SessionState.PROCESSING, SessionState.DELIVERING],
  [SessionState.DELIVERING, SessionState.IDLE],
]);

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private readonly deps: SessionManagerDeps;
  private vadMonitors: Map<string, VADMonitor> = new Map();
  private vadCallbacksMap: Map<string, VADEventCallback> = new Map();
  private videoProcessors: Map<string, VideoProcessor> = new Map();

  private log(level: string, msg: string): void {
    console.log(`[${level}] [SessionManager] ${msg}`);
  }

  constructor(deps: SessionManagerDeps = {}) {
      this.deps = deps;
      this.log("INIT", `VAD: ${deps.vadMonitorFactory ? "enabled (factory provided)" : "disabled (no factory)"}`);
    }

  /**
   * Creates a new session in the IDLE state.
   * The session is ready for the operator to start recording.
   */
  /**
     * Creates a new session in the IDLE state.
     * The session is ready for the operator to start recording.
     */
    createSession(): Session {
      const session: Session = {
        id: uuidv4(),
        state: SessionState.IDLE,
        startedAt: null,
        stoppedAt: null,
        transcript: [],
        liveTranscript: [],
        audioChunks: [],
        metrics: null,
        evaluation: null,
        evaluationPublic: null,
        evaluationScript: null,
        ttsAudioCache: null,
        qualityWarning: false,
        outputsSaved: false,
        runId: 0,
        consent: null,
        timeLimitSeconds: 120,
        evaluationPassRate: null,
        eagerStatus: "idle",
        eagerRunId: null,
        eagerPromise: null,
        evaluationCache: null,
        projectContext: null,
        vadConfig: { silenceThresholdSeconds: 5, enabled: true },
        // Phase 4: Video fields initialized with defaults
        videoConsent: null,
        videoStreamReady: false,
        visualObservations: null,
        videoConfig: { frameRate: 5 },
      };

      this.sessions.set(session.id, session);
      return session;
    }

  /**
   * Retrieves a session by ID.
   * @throws Error if the session does not exist.
   */
  getSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * Sets the consent record for a session.
   * Creates a ConsentRecord with the speaker's name, consent status, and current timestamp.
   *
   * Consent can only be set or modified while the session is in IDLE state.
   * Once recording starts, the ConsentRecord becomes immutable (Req 2.4).
   *
   * @param sessionId - The session to set consent on
   * @param speakerName - The speaker's name
   * @param consentConfirmed - Whether the speaker has confirmed consent
   * @throws Error if the session is not in IDLE state
   * @throws Error if the session does not exist
   */
  setConsent(sessionId: string, speakerName: string, consentConfirmed: boolean): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot modify consent: session is in "${session.state}" state. ` +
        `Consent can only be set or changed while the session is in "idle" state.`
      );
    }

    const consentRecord: ConsentRecord = {
      speakerName,
      consentConfirmed,
      consentTimestamp: new Date(),
    };

    session.consent = consentRecord;

    // Backward compatibility: mirror speakerName from consent (Req 8.4)
    session.speakerName = speakerName;

    this.log("INFO", `Consent set for session ${sessionId}: speaker="${speakerName}", confirmed=${consentConfirmed}`);
  }

  /**
   * Store project context on the session. Only valid in IDLE state.
   *
   * Project context carries speech title, Toastmasters project type, and
   * project-specific objectives. Once recording starts, the context becomes
   * immutable for that session (consistent with ConsentRecord immutability).
   *
   * @param sessionId - The session to set project context on
   * @param context - The project context to store
   * @throws Error if the session does not exist
   * @throws Error if the session is not in IDLE state
   */
  setProjectContext(sessionId: string, context: ProjectContext): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot set project context: session is in "${session.state}" state. ` +
        `Project context can only be set while the session is in "idle" state.`
      );
    }

    session.projectContext = context;

    this.log("INFO", `Project context set for session ${sessionId}: type="${context.projectType}", title="${context.speechTitle}"`);
  }

  /**
   * Store VAD configuration on the session. Only valid in IDLE state.
   *
   * VAD config controls silence detection behavior during recording.
   * The configuration is read when recording starts and passed to the VADMonitor.
   *
   * @param sessionId - The session to set VAD config on
   * @param config - The VAD configuration to store
   * @throws Error if the session does not exist
   * @throws Error if the session is not in IDLE state
   */
  setVADConfig(sessionId: string, config: SessionVADConfig): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot set VAD config: session is in "${session.state}" state. ` +
        `VAD configuration can only be set while the session is in "idle" state.`
      );
    }

    session.vadConfig = config;

    this.log("INFO", `VAD config set for session ${sessionId}: threshold=${config.silenceThresholdSeconds}s, enabled=${config.enabled}`);
  }

  /**
   * Register per-session VAD callbacks. Called by the server layer BEFORE startRecording().
   * When startRecording() creates the VADMonitor, it looks up callbacks from this map.
   * If no callbacks are registered, VAD events are silently discarded.
   *
   * @param sessionId - The session to register callbacks for
   * @param callbacks - The VAD event callbacks (onSpeechEnd, onStatus)
   */
  registerVADCallbacks(sessionId: string, callbacks: VADEventCallback): void {
    this.vadCallbacksMap.set(sessionId, callbacks);
  }

  // ─── Phase 4: Video Lifecycle Methods ─────────────────────────────────────────

  /**
   * Sets video consent for a session. IDLE-only.
   * Video consent is independent from audio consent (Req 1.3).
   * Becomes immutable once recording starts (Req 1.4).
   */
  setVideoConsent(sessionId: string, consent: VideoConsent): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot set video consent: session is in "${session.state}" state. ` +
        `Video consent can only be set while the session is in "idle" state.`
      );
    }

    session.videoConsent = consent;

    this.log("INFO", `Video consent set for session ${sessionId}: granted=${consent.consentGranted}`);
  }

  /**
   * Marks the video stream as ready after successful getUserMedia handshake.
   * IDLE-only (Req 1.4). deviceLabel is NOT stored (privacy Req 11.7).
   */
  setVideoStreamReady(sessionId: string, _deviceLabel?: string): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot set video stream ready: session is in "${session.state}" state. ` +
        `Video stream ready can only be set while the session is in "idle" state.`
      );
    }

    session.videoStreamReady = true;

    this.log("INFO", `Video stream ready for session ${sessionId}`);
  }

  /**
   * Sets video configuration (frame rate). IDLE-only (Req 2.9).
   * frameRate must be in [1, 5] range.
   */
  setVideoConfig(sessionId: string, config: { frameRate: number }): void {
    const session = this.getSession(sessionId);

    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Cannot set video config: session is in "${session.state}" state. ` +
        `Video config can only be set while the session is in "idle" state.`
      );
    }

    if (config.frameRate < 1 || config.frameRate > 5) {
      throw new Error(
        `Invalid frameRate: ${config.frameRate}. Must be between 1 and 5.`
      );
    }

    session.videoConfig = { frameRate: config.frameRate };

    this.log("INFO", `Video config set for session ${sessionId}: frameRate=${config.frameRate}`);
  }

  /**
   * Feeds a video frame to the VideoProcessor. Fire-and-forget — enqueues
   * the frame without awaiting inference (Req 10.6, 10.7).
   *
   * Guards: only processes if session is RECORDING, videoConsent is granted,
   * and videoStreamReady is true. Silently ignores otherwise (Req 1.9).
   */
  feedVideoFrame(sessionId: string, header: FrameHeader, jpegBuffer: Buffer): void {
    const session = this.getSession(sessionId);

    // Guard: only process in RECORDING state with consent and stream ready
    if (session.state !== SessionState.RECORDING) return;
    if (!session.videoConsent?.consentGranted) return;
    if (!session.videoStreamReady) return;

    const processor = this.videoProcessors.get(sessionId);
    if (!processor) return;

    // Fire-and-forget: enqueue frame, do NOT await
    processor.enqueueFrame(header, jpegBuffer);
  }

  /**
   * Get the VideoProcessor for a session, if one exists.
   * Used by the server to query video processing status for periodic video_status messages.
   */
  getVideoProcessor(sessionId: string): VideoProcessor | undefined {
    return this.videoProcessors.get(sessionId);
  }


  /**
   * Revokes consent and purges ALL session data immediately and irrecoverably.
   * This implements the speaker opt-out flow per the privacy retention policy.
   *
   * Purge behavior (per privacy-and-retention steering rule):
   * - Audio chunks: cleared
   * - Transcript (final): cleared
   * - Live transcript: cleared
   * - Metrics: nulled
   * - Evaluation: nulled
   * - Evaluation script: nulled
   * - TTS audio cache: nulled
   * - Consent: nulled
   * - Quality warning: reset to false
   * - Evaluation pass rate: nulled
   *
   * The Session object itself remains with a valid id and state (set to IDLE).
   * This allows the UI to continue functioning while holding no speech data.
   *
   * Can be called from ANY state — opt-out is always honored.
   *
   * @param sessionId - The session to revoke consent on
   * @throws Error if the session does not exist
   */
  revokeConsent(sessionId: string): void {
    const session = this.getSession(sessionId);

    this.log("INFO", `Consent revoked for session ${sessionId} — purging all session data (state was "${session.state}")`);

    // Increment runId to cancel any in-flight async operations
    if (session.state !== SessionState.IDLE) {
      session.runId++;
    }

    // Stop and remove VAD monitor (Req 11.2)
    const vadMonitor = this.vadMonitors.get(sessionId);
    if (vadMonitor) {
      vadMonitor.stop();
      this.vadMonitors.delete(sessionId);
    }
    this.vadCallbacksMap.delete(sessionId);

    // Phase 4: Stop and remove VideoProcessor, purge all video data (Req 1.7, 11.4)
    const videoProcessor = this.videoProcessors.get(sessionId);
    if (videoProcessor) {
      videoProcessor.stop();
      this.videoProcessors.delete(sessionId);
    }

    // Clear eager pipeline state — runId already incremented above,
    // so use clearEagerState() (pure reset), not cancelEagerGeneration().
    // Per privacy-and-retention rule: opt-out purges all session data immediately and irrecoverably.
    this.clearEagerState(sessionId);

    // Stop live transcription if active (similar to panicMute)
    if (session.state === SessionState.RECORDING && this.deps.transcriptionEngine) {
      try {
        this.deps.transcriptionEngine.stopLive();
      } catch {
        // Ignore errors — we're purging regardless
      }
    }

    // Purge all session data per privacy retention policy
    session.transcript = [];
    session.liveTranscript = [];
    session.audioChunks = [];
    session.metrics = null;
    session.evaluation = null;
    session.evaluationPublic = null;
    session.evaluationScript = null;
    session.ttsAudioCache = null;
    session.consent = null;
    session.qualityWarning = false;
    session.evaluationPassRate = null;
    session.projectContext = null;

    // Phase 4: Purge all video data (Req 1.7, 11.4)
    session.videoConsent = null;
    session.videoStreamReady = false;
    session.visualObservations = null;

    // Backward compatibility: clear deprecated speakerName
    session.speakerName = undefined;

    // Transition to IDLE — session object remains for UI state
    session.state = SessionState.IDLE;
  }


  /**
   * Transitions the session from IDLE to RECORDING.
   * Increments runId for cancellation correctness — any in-flight async
   * operations from a previous run will see a stale runId and abort.
   *
   * Pipeline wiring:
   * 1. Increment runId (cancellation correctness)
   * 2. Set state to RECORDING
   * 3. Clear previous session data for fresh recording
   * 4. Start TranscriptionEngine.startLive() with callback for live transcript segments
   *
   * @throws Error if the session is not in IDLE state.
   */
  startRecording(sessionId: string, onLiveSegment?: (segment: TranscriptSegment) => void): void {
      const session = this.getSession(sessionId);
      this.assertTransition(session, SessionState.RECORDING, "startRecording");

      session.runId++;
      session.state = SessionState.RECORDING;
      session.startedAt = new Date();

      // Clear previous session data for a fresh recording
      session.transcript = [];
      session.liveTranscript = [];
      session.audioChunks = [];
      session.metrics = null;
      session.evaluation = null;
      session.evaluationPublic = null;
      session.evaluationScript = null;
      session.qualityWarning = false;
      session.outputsSaved = false;
      session.ttsAudioCache = null;
      session.stoppedAt = null;

      // Clear eager pipeline state — runId already incremented above,
      // so use clearEagerState() (pure reset), not cancelEagerGeneration()
      this.clearEagerState(sessionId);

      // Start live transcription if engine is available
      if (this.deps.transcriptionEngine) {
        this.log("INFO", `Starting Deepgram live transcription for session ${sessionId}`);
        const capturedRunId = session.runId;
        this.deps.transcriptionEngine.startLive((segment: TranscriptSegment) => {
          // Only commit live transcript if runId still matches (not cancelled)
          if (session.runId === capturedRunId) {
            session.liveTranscript.push(segment);
            // Notify the server layer so it can push to the client
            if (onLiveSegment) {
              onLiveSegment(segment);
            }
          }
        });
        this.log("INFO", `Deepgram live connection opened for session ${sessionId}`);
      } else {
        this.log("WARN", `No TranscriptionEngine configured — live transcription disabled`);
      }

      // Create VADMonitor when VAD is enabled and factory is available
      if (session.vadConfig.enabled && this.deps.vadMonitorFactory) {
        const vadFullConfig: VADConfig = {
          silenceThresholdSeconds: session.vadConfig.silenceThresholdSeconds,
          enabled: session.vadConfig.enabled,
          silenceFactor: 0.15,
          minSpeechSeconds: 3,
          suppressionSeconds: 10,
          statusIntervalMs: 250,
          speechEnergyWindowChunks: 6000,
          noiseFloorBootstrapChunks: 40,
          thresholdMultiplier: 0.15,
        };

        // Look up registered callbacks; if none, use no-op callbacks (silently discard events)
        const registeredCallbacks = this.vadCallbacksMap.get(sessionId);
        const vadCallbacks: VADEventCallback = registeredCallbacks ?? {
          onSpeechEnd: () => {},
          onStatus: () => {},
        };

        const vadMonitor = this.deps.vadMonitorFactory(vadFullConfig, vadCallbacks);
        this.vadMonitors.set(sessionId, vadMonitor);
        this.log("INFO", `VAD monitor created for session ${sessionId} (threshold=${vadFullConfig.silenceThresholdSeconds}s)`);
      }

      // Phase 4: Create VideoProcessor if consent granted and stream ready (Req 1.6)
      if (session.videoConsent?.consentGranted && session.videoStreamReady) {
        if (this.deps.videoProcessorFactory) {
          try {
            const videoConfig: VideoConfig = {
              frameRate: session.videoConfig?.frameRate ?? 5,
              gestureDisplacementThreshold: 0.15,
              stageCrossingThreshold: 0.25,
              stabilityWindowSeconds: 5,
              gazeYawThreshold: 15,
              gazePitchThreshold: -20,
              cameraDropTimeoutSeconds: 5,
              queueMaxSize: 20,
              maxFrameInferenceMs: 500,
              staleFrameThresholdSeconds: 2.0,
              finalizationBudgetMs: 3000,
              minFaceAreaFraction: 0.05,
              faceDetectionConfidenceThreshold: 0.5,
              poseDetectionConfidenceThreshold: 0.3,
              minValidFramesPerWindow: 3,
              metricRoundingPrecision: 4,
              facialEnergyEpsilon: 0.001,
              backpressureOverloadThreshold: 0.20,
              backpressureRecoveryThreshold: 0.10,
              backpressureCooldownMs: 3000,
              frameRetentionWarningThreshold: 0.50,
              motionDeadZoneFraction: 0.0,
              gazeCoverageThreshold: 0.6,
              facialEnergyCoverageThreshold: 0.4,
              gestureCoverageThreshold: 0.3,
              stabilityCoverageThreshold: 0.6,
            };
            const processor = this.deps.videoProcessorFactory(videoConfig, {});
            this.videoProcessors.set(sessionId, processor);
            processor.startDrainLoop();
            this.log("INFO", `Video processing started for session ${sessionId}`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.log("WARN", `Failed to create VideoProcessor for session ${sessionId}: ${errMsg} — proceeding audio-only`);
          }
        } else {
          this.log("WARN", `Video consent granted but no videoProcessorFactory configured for session ${sessionId} — proceeding audio-only`);
        }
      } else if (session.videoConsent?.consentGranted) {
        // Consent granted but stream not ready (Req 1.6): proceed audio-only with warning
        this.log("WARN", `Video consent granted but video stream not ready for session ${sessionId} — proceeding audio-only`);
      }
    }

  /**
   * Forwards an audio chunk to the live transcription engine (Deepgram).
   * Also buffers the chunk in the session for post-speech transcription.
   *
   * This should be called for every binary audio frame received during RECORDING.
   * Privacy: audio chunks are in-memory only, never written to disk.
   *
   * @throws Error if the session does not exist.
   */
  feedAudio(sessionId: string, chunk: Buffer): void {
    const session = this.getSession(sessionId);

    // Buffer for post-speech transcription
    session.audioChunks.push(Buffer.from(chunk));

    // Forward to Deepgram live transcription if available
    if (this.deps.transcriptionEngine) {
      try {
        this.deps.transcriptionEngine.feedAudio(chunk);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log("WARN", `feedAudio failed for session ${sessionId}: ${errMsg}`);
      }
    }

    // Forward to VAD monitor (HARD GUARD: only when RECORDING and monitor exists)
    // This prevents late chunks (network jitter) from reaching a stopped/removed monitor
    // and prevents resurrection of a monitor after stop.
    if (session.state === SessionState.RECORDING) {
      const vadMonitor = this.vadMonitors.get(sessionId);
      if (vadMonitor) {
        vadMonitor.feedChunk(chunk);
      }
    }
  }


  /**
   * Transitions the session from RECORDING to PROCESSING.
   *
   * Pipeline wiring:
   * 1. Set state to PROCESSING
   * 2. Stop live transcription: TranscriptionEngine.stopLive()
   * 3. Concatenate audio chunks into a single buffer (in-memory only)
   * 4. Run post-speech transcription: TranscriptionEngine.finalize(fullAudio)
   * 5. Store final transcript in session
   * 6. Run metrics extraction: MetricsExtractor.extract(transcript)
   * 7. Store metrics in session
   * 8. Assess transcript quality (word count/minute, confidence)
   * 9. All async operations check runId before committing results
   *
   * @throws Error if the session is not in RECORDING state.
   */
  /**
     * Transitions the session from RECORDING to PROCESSING.
     *
     * Pipeline wiring:
     * 1. Set state to PROCESSING
     * 2. Stop live transcription: TranscriptionEngine.stopLive()
     * 3. Propagate transcription quality warning from engine to session
     * 4. Concatenate audio chunks into a single buffer (in-memory only)
     * 5. Run post-speech transcription: TranscriptionEngine.finalize(fullAudio)
     *    - On failure: fall back to Deepgram live segments with quality warning (Req 7.1)
     * 6. Store final transcript in session
     * 7. Run metrics extraction: MetricsExtractor.extract(transcript)
     * 8. Store metrics in session
     * 9. Assess transcript quality (word count/minute, confidence)
     * 10. All async operations check runId before committing results
     *
     * @throws Error if the session is not in RECORDING state.
     */
    async stopRecording(sessionId: string): Promise<void> {
      const session = this.getSession(sessionId);
      this.assertTransition(session, SessionState.PROCESSING, "stopRecording");

      session.state = SessionState.PROCESSING;
      session.stoppedAt = new Date();

      const capturedRunId = session.runId;

      // Stop and remove VAD monitor (Req 11.3)
      const vadMonitor = this.vadMonitors.get(sessionId);
      if (vadMonitor) {
        vadMonitor.stop();
        this.vadMonitors.delete(sessionId);
      }
      this.vadCallbacksMap.delete(sessionId);

      // Stop live transcription
      if (this.deps.transcriptionEngine) {
        this.log("INFO", `Stopping Deepgram live transcription for session ${sessionId}`);
        this.deps.transcriptionEngine.stopLive();

        // Propagate transcription quality warning (e.g., Deepgram connection drop)
        if (this.deps.transcriptionEngine.qualityWarning) {
          this.log("WARN", `Deepgram quality warning flagged for session ${sessionId}`);
          session.qualityWarning = true;
        }
      }

      // Concatenate audio chunks into a single buffer for post-speech transcription
      // Privacy: this buffer is in-memory only, never written to disk
      if (this.deps.transcriptionEngine && session.audioChunks.length > 0) {
        const fullAudio = Buffer.concat(session.audioChunks);
        this.log("INFO", `Post-speech transcription: sending ${fullAudio.length} bytes (${session.audioChunks.length} chunks) to OpenAI for session ${sessionId}`);

        try {
          // Run post-speech transcription (OpenAI gpt-4o-transcribe)
          const finalTranscript = await this.deps.transcriptionEngine.finalize(fullAudio);

          // Check runId before committing — panic mute or new recording may have happened
          if (session.runId !== capturedRunId) {
            this.log("WARN", `RunId changed during post-speech transcription for session ${sessionId}, discarding result`);
            return;
          }

          this.log("INFO", `Post-speech transcription complete: ${finalTranscript.length} segments for session ${sessionId}`);
          session.transcript = finalTranscript;
        } catch (err) {
          // Post-pass failure: fall back to Deepgram live segments with quality warning (Req 7.1)
          const errMsg = err instanceof Error ? err.message : String(err);
          this.log("ERROR", `Post-speech transcription failed for session ${sessionId}: ${errMsg}`);

          if (session.runId !== capturedRunId) {
            return;
          }

          // Use only finalized live transcript segments as fallback
          const fallbackSegments = session.liveTranscript.filter((s) => s.isFinal);
          this.log("WARN", `Falling back to ${fallbackSegments.length} Deepgram live segments for session ${sessionId}`);
          session.transcript = fallbackSegments;
          session.qualityWarning = true;
        }
      } else if (!this.deps.transcriptionEngine) {
        this.log("WARN", `No TranscriptionEngine configured — no transcription performed`);
      } else {
        this.log("WARN", `No audio chunks captured for session ${sessionId}`);
      }

      // Check runId again before metrics extraction
      if (session.runId !== capturedRunId) {
        return;
      }

      // Extract metrics from the final transcript
      if (this.deps.metricsExtractor && session.transcript.length > 0) {
        this.log("INFO", `Extracting delivery metrics from ${session.transcript.length} segments for session ${sessionId}`);
        const metrics = this.deps.metricsExtractor.extract(session.transcript);

        // Check runId before committing metrics
        if (session.runId !== capturedRunId) {
          return;
        }

        this.log("INFO", `Metrics: ${metrics.totalWords} words, ${Math.round(metrics.wordsPerMinute)} WPM, ${metrics.durationFormatted} duration, ${metrics.fillerWordCount} fillers, ${metrics.pauseCount} pauses`);
        session.metrics = metrics;
      } else if (!this.deps.metricsExtractor) {
        this.log("WARN", `No MetricsExtractor configured — metrics extraction skipped`);
      }

      // Phase 4: Finalize VideoProcessor and attach visualMetrics to DeliveryMetrics
      if (session.runId === capturedRunId) {
        const processor = this.videoProcessors.get(sessionId);
        if (processor) {
          try {
            const observations: VisualObservations = await processor.finalize(session.transcript);

            if (session.runId !== capturedRunId) {
              return;
            }

            session.visualObservations = observations;

            // Attach visualMetrics to DeliveryMetrics (Req 9.2)
            if (session.metrics) {
              session.metrics.visualMetrics = {
                gazeBreakdown: observations.gazeBreakdown,
                faceNotDetectedCount: observations.faceNotDetectedCount,
                totalGestureCount: observations.totalGestureCount,
                gestureFrequency: observations.gestureFrequency,
                gesturePerSentenceRatio: observations.gesturePerSentenceRatio,
                meanBodyStabilityScore: observations.meanBodyStabilityScore,
                stageCrossingCount: observations.stageCrossingCount,
                movementClassification: observations.movementClassification,
                meanFacialEnergyScore: observations.meanFacialEnergyScore,
                facialEnergyVariation: observations.facialEnergyVariation,
                facialEnergyLowSignal: observations.facialEnergyLowSignal,
                framesAnalyzed: observations.framesAnalyzed,
                videoQualityGrade: observations.videoQualityGrade,
                videoQualityWarning: observations.videoQualityGrade !== "good",
                gazeReliable: observations.gazeReliable,
                gestureReliable: observations.gestureReliable,
                stabilityReliable: observations.stabilityReliable,
                facialEnergyReliable: observations.facialEnergyReliable,
                framesDroppedByFinalizationBudget: observations.framesDroppedByFinalizationBudget,
                resolutionChangeCount: observations.resolutionChangeCount,
                videoProcessingVersion: observations.videoProcessingVersion,
                // Optional high-value improvements (Req 21)
                confidenceScores: observations.confidenceScores,
                detectionCoverage: observations.detectionCoverage,
                cameraPlacementWarning: observations.cameraPlacementWarning,
              };
            }

            this.log("INFO", `Video finalized for session ${sessionId}: ${observations.framesAnalyzed} frames analyzed, quality=${observations.videoQualityGrade}`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.log("WARN", `Video finalization failed for session ${sessionId}: ${errMsg}`);
            // Set visualMetrics to null on failure — audio evaluation proceeds
            if (session.metrics) {
              session.metrics.visualMetrics = null;
            }
          } finally {
            this.videoProcessors.delete(sessionId);
          }
        } else {
          // No VideoProcessor — set visualMetrics to null (Req 9.3)
          if (session.metrics) {
            session.metrics.visualMetrics = null;
          }
        }
      }

      // Assess transcript quality
      if (session.runId === capturedRunId) {
        // assessTranscriptQuality may upgrade qualityWarning to true but never downgrade it
        if (this.assessTranscriptQuality(session.transcript, session.metrics)) {
          session.qualityWarning = true;
        }
      }
    }


  /**
   * Transitions the session from PROCESSING to DELIVERING.
   *
   * Phase 2 Pipeline (Req 11):
   * 1. LLM Generation — EvaluationGenerator.generate() (includes evidence validation + retry + shape check)
   * 2. Compute energy profile from audio chunks
   * 3. Script Rendering (with [[Q:*]] / [[M:*]] markers) — EvaluationGenerator.renderScript()
   * 4. Tone Check + Fix — ToneChecker.check() → stripViolations() → stripMarkers()
   * 5. Timing Trim — TTSEngine.trimToFit()
   * 6. Scope Ack Check — ToneChecker.appendScopeAcknowledgment()
   * 7. Name Redaction — EvaluationGenerator.redact() → produces scriptRedacted + evaluationPublic
   * 8. TTS Synthesis — TTSEngine.synthesize()
   *
   * Stage contracts:
   * - Stages 1-6 operate on UNREDACTED text. Redaction happens exactly once at stage 7.
   * - After stage 4, the script MUST NOT contain any [[Q:*]] or [[M:*]] markers.
   * - Stage 7 produces both a redacted script (for TTS) and a StructuredEvaluationPublic (for UI).
   * - The evaluation_ready message sends the public (redacted) version, never the internal version.
   * - RunId checking at every async boundary for cancellation correctness.
   *
   * @throws Error if the session is not in PROCESSING state.
   * @throws Error if LLM generation fails (session transitions back to PROCESSING).
   * @returns The synthesized TTS audio buffer, or undefined if pipeline cannot complete.
   */
  async generateEvaluation(sessionId: string): Promise<Buffer | undefined> {
    const session = this.getSession(sessionId);
    this.assertTransition(session, SessionState.DELIVERING, "generateEvaluation");

    session.state = SessionState.DELIVERING;

    const capturedRunId = session.runId;

    // Guard: need generator, transcript, and metrics to proceed
    if (!this.deps.evaluationGenerator || session.transcript.length === 0 || !session.metrics) {
      if (!this.deps.evaluationGenerator) {
        this.log("WARN", `No EvaluationGenerator configured — evaluation generation skipped`);
      } else if (session.transcript.length === 0) {
        this.log("WARN", `No transcript available for session ${sessionId} — cannot generate evaluation`);
      } else if (!session.metrics) {
        this.log("WARN", `No metrics available for session ${sessionId} — cannot generate evaluation`);
      }
      return undefined;
    }

    const metrics = session.metrics;

    // ── Stage 1: LLM Generation (includes evidence validation + retry + shape check / fallback) ──
    let evaluation: StructuredEvaluation;

    try {
      // Build EvaluationConfig from session.projectContext (Req 4.5, 5.1, 5.5)
      const config: EvaluationConfig | undefined = session.projectContext
        ? {
            objectives: session.projectContext.objectives,
            speechTitle: session.projectContext.speechTitle ?? undefined,
            projectType: session.projectContext.projectType ?? undefined,
          }
        : undefined;

      this.log("INFO", `Generating evaluation via GPT-4o for session ${sessionId} (${session.transcript.length} segments, ${metrics.totalWords} words)`);

      // Phase 4: Determine visual observations to pass to EvaluationGenerator (Req 17.3)
      // Suppress visual feedback entirely when videoQualityGrade === "poor"
      // Skip unreliable metrics by passing null when quality is poor
      let visualObsForEval: VisualObservations | null = null;
      if (session.visualObservations) {
        if (session.visualObservations.videoQualityGrade !== "poor") {
          visualObsForEval = session.visualObservations;
        } else {
          this.log("INFO", `Visual observations suppressed for session ${sessionId}: videoQualityGrade is "poor"`);
        }
      }

      const generateResult = await this.deps.evaluationGenerator.generate(
        session.transcript,
        metrics,
        config,
        visualObsForEval,
      );
      evaluation = generateResult.evaluation;
      session.evaluationPassRate = generateResult.passRate;
      this.log("INFO", `Evaluation generated: ${evaluation.items.length} items (${evaluation.items.filter(i => i.type === "commendation").length} commendations, ${evaluation.items.filter(i => i.type === "recommendation").length} recommendations), pass rate: ${(generateResult.passRate * 100).toFixed(0)}%`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log("ERROR", `Evaluation generation failed for session ${sessionId}: ${errMsg}`);
      // LLM failure: transition back to PROCESSING so operator can retry (Req 7.3)
      if (session.runId === capturedRunId) {
        session.state = SessionState.PROCESSING;
      }
      throw err;
    }

    // RunId check after LLM generation
    if (session.runId !== capturedRunId) {
      this.log("WARN", `RunId changed during evaluation generation for session ${sessionId}, discarding`);
      return undefined;
    }

    session.evaluation = evaluation;

    // ── Stage 2: Compute energy profile from audio chunks ──
    if (this.deps.metricsExtractor && session.audioChunks.length > 0) {
      this.log("INFO", `Computing energy profile from ${session.audioChunks.length} audio chunks for session ${sessionId}`);
      const energyProfile = this.deps.metricsExtractor.computeEnergyProfile(session.audioChunks);
      metrics.energyProfile = energyProfile;
      metrics.energyVariationCoefficient = energyProfile.coefficientOfVariation;
    }

    // ── Stage 3: Script Rendering (with [[Q:*]] / [[M:*]] markers, UNREDACTED) ──
    // Note: renderScript emits markers but does NOT apply redaction in Phase 2 pipeline.
    // We pass undefined for speakerName to prevent the old redaction path inside renderScript.
    // Redaction happens at stage 7 via the dedicated redact() method.
    this.log("INFO", `Rendering evaluation script with markers for session ${sessionId}`);
    let script = this.deps.evaluationGenerator.renderScript(
      evaluation,
      undefined, // No speakerName — prevents old redaction path; redaction at stage 7
      metrics,
    );

    // RunId check after rendering
    if (session.runId !== capturedRunId) {
      return undefined;
    }

    // ── Stage 4: Tone Check + Fix ──
    // Input: marked script with [[Q:*]] / [[M:*]] markers
    // Output: clean script with no markers, no violations
    if (this.deps.toneChecker) {
      const hasVideo = session.visualObservations != null;
      this.log("INFO", `Running tone check for session ${sessionId}`);
      const toneResult = this.deps.toneChecker.check(script, evaluation, metrics, { hasVideo });

      if (!toneResult.passed) {
        this.log("WARN", `Tone check found ${toneResult.violations.length} violation(s) for session ${sessionId}`);

        // Strip violations from the marked script (markers still present)
        script = this.deps.toneChecker.stripViolations(script, toneResult.violations);
      }

      // Strip markers exactly once at the end of stage 4 (marker invariant)
      script = this.deps.toneChecker.stripMarkers(script);
    } else {
      // No ToneChecker — still need to strip markers if renderScript emitted them
      // Use a simple regex fallback to strip markers
      script = script.replace(/\s*\[\[(Q|M):[^\]]+\]\]/g, "").replace(/\s{2,}/g, " ").trim();
    }

    // RunId check after tone check
    if (session.runId !== capturedRunId) {
      return undefined;
    }

    // ── Stage 5: Timing Trim ──
    if (this.deps.ttsEngine) {
      this.log("INFO", `Trimming script to fit ${session.timeLimitSeconds}s time limit for session ${sessionId}`);
      script = this.deps.ttsEngine.trimToFit(
        script,
        session.timeLimitSeconds,
      );
    }

    // ── Stage 6: Scope Acknowledgment Check ──
    // Append only when qualityWarning is true OR hasStructureCommentary is true. Idempotent.
    if (this.deps.toneChecker) {
      const hasStructureCommentary = !!(
        evaluation.structure_commentary?.opening_comment ||
        evaluation.structure_commentary?.body_comment ||
        evaluation.structure_commentary?.closing_comment
      );
      const hasVideo = session.visualObservations != null;
      script = this.deps.toneChecker.appendScopeAcknowledgment(
        script,
        session.qualityWarning,
        hasStructureCommentary,
        { hasVideo },
      );
    }

    // RunId check before redaction
    if (session.runId !== capturedRunId) {
      return undefined;
    }

    // Store the unredacted script on the session (for internal use)
    session.evaluationScript = script;

    // ── Stage 7: Name Redaction ──
    // Only apply redaction if consent exists (backward compat with Phase 1)
    // Produces both scriptRedacted (for TTS) and evaluationPublic (for UI/save)
    let scriptForTTS = script;
    let evaluationPublic: StructuredEvaluationPublic | undefined;

    if (session.consent && this.deps.evaluationGenerator) {
      this.log("INFO", `Applying name redaction for session ${sessionId}`);
      const redactionResult = this.deps.evaluationGenerator.redact({
        script,
        evaluation,
        consent: session.consent,
      });
      scriptForTTS = redactionResult.scriptRedacted;
      evaluationPublic = redactionResult.evaluationPublic;

      // Store the redacted script as the session's evaluation script (user-facing)
      session.evaluationScript = scriptForTTS;
      // Store the public (redacted) evaluation for UI/save
      session.evaluationPublic = evaluationPublic;
    }

    // RunId check before TTS synthesis
    if (session.runId !== capturedRunId) {
      return undefined;
    }

    // ── Stage 8: TTS Synthesis ──
    if (this.deps.ttsEngine) {
      try {
        this.log("INFO", `Synthesizing TTS audio for session ${sessionId} (${scriptForTTS.split(/\s+/).length} words)`);
        const audioBuffer = await this.deps.ttsEngine.synthesize(scriptForTTS);

        // RunId check before committing audio
        if (session.runId !== capturedRunId) {
          return undefined;
        }

        this.log("INFO", `TTS synthesis complete: ${audioBuffer.length} bytes for session ${sessionId}`);
        session.ttsAudioCache = audioBuffer;

        // ── Stage 9 (async, non-blocking): Log consistency telemetry ──
        // Fire-and-forget — does NOT block evaluation delivery (Design Decision #7)
        if (this.deps.evaluationGenerator && evaluation) {
          try {
            const telemetryPromise = this.deps.evaluationGenerator.logConsistencyTelemetry(evaluation);
            if (telemetryPromise && typeof telemetryPromise.catch === "function") {
              telemetryPromise.catch((err: unknown) => {
                this.log("WARN", `Consistency telemetry failed: ${err}`);
              });
            }
          } catch (err) {
            this.log("WARN", `Consistency telemetry failed: ${err}`);
          }
        }

        return audioBuffer;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log("ERROR", `TTS synthesis failed for session ${sessionId}: ${errMsg}. Falling back to written evaluation.`);
        // TTS failure: evaluation and script are already stored in session (Req 7.4)
        return undefined;
      }
    } else {
      this.log("WARN", `No TTSEngine configured — TTS synthesis skipped`);
    }

    return undefined;
  }


  /**
   * Transitions the session from DELIVERING to IDLE after TTS completes.
   *
   * @throws Error if the session is not in DELIVERING state.
   */
  completeDelivery(sessionId: string): void {
    const session = this.getSession(sessionId);
    this.assertTransition(session, SessionState.IDLE, "completeDelivery");

    session.state = SessionState.IDLE;
  }

  // ─── Eager Pipeline: Cache Validity ───────────────────────────────────────────

  /**
   * Returns true only when the evaluation cache is valid and ready for delivery.
   *
   * ALL conditions must hold:
   * - evaluationCache is non-null
   * - eagerStatus is "ready"
   * - cache.runId matches session.runId
   * - cache.timeLimitSeconds matches session.timeLimitSeconds
   * - cache.voiceConfig matches the resolved voiceConfig (session.voiceConfig ?? "nova")
   * - cache.ttsAudio is non-empty
   * - cache.evaluation is non-null
   * - cache.evaluationScript is non-null
   * - cache.evaluationPublic is non-null (required for delivery — evaluation_ready message payload)
   *
   * Per Implementation Hazard 3: compare against the resolved voiceConfig, not raw undefined.
   *
   * Requirements: 6.1, 4.5
   */
  isEagerCacheValid(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    const cache = session.evaluationCache;
    return (
      cache !== null &&
      session.eagerStatus === "ready" &&
      cache.runId === session.runId &&
      cache.timeLimitSeconds === session.timeLimitSeconds &&
      cache.voiceConfig === (session.voiceConfig ?? "nova") &&
      cache.ttsAudio.length > 0 &&
      cache.evaluation !== null &&
      cache.evaluationScript !== null &&
      cache.evaluationPublic !== null
    );
  }

  // ─── Eager Pipeline: State Management ─────────────────────────────────────────

  /**
   * Pure field reset — clears all eager pipeline fields without incrementing runId.
   * Does NOT cancel in-flight work on its own.
   *
   * Safe for cleanup-only paths (e.g., purgeSessionData, or after runId is already
   * incremented by the caller such as startRecording, panicMute, revokeConsent).
   *
   * Requirements: 6.2, 6.3, 6.4, 6.5, 6.7
   */
  clearEagerState(sessionId: string): void {
    const session = this.getSession(sessionId);
    session.eagerStatus = "idle";
    session.eagerRunId = null;
    session.eagerPromise = null;
    session.evaluationCache = null;
  }

  /**
   * Cancellation primitive — increments runId to cancel in-flight eager pipeline
   * via epoch bump, then clears all eager fields.
   *
   * Cancels by invalidating results via epoch bump; does NOT abort in-flight
   * LLM/TTS calls. The in-flight pipeline will detect the runId mismatch at
   * its next checkpoint and discard results.
   *
   * Use this when you need to cancel in-flight work (e.g., invalidateEagerCache).
   * Use clearEagerState() when runId is already incremented by the caller.
   *
   * Requirements: 6.2, 6.3, 6.4, 6.5, 6.7
   */
  cancelEagerGeneration(sessionId: string): void {
    const session = this.getSession(sessionId);
    session.runId++;
    this.clearEagerState(sessionId);
  }

  // ─── Eager Pipeline: Cache Invalidation ─────────────────────────────────────

  /**
   * Invalidates the eager cache and cancels any in-flight eager pipeline.
   *
   * Called when generation parameters change (e.g., time limit, voiceConfig).
   * Delegates to cancelEagerGeneration() which increments runId (to cancel
   * in-flight eager via epoch bump) and clears all eager fields atomically.
   *
   * This expands the meaning of runId from "recording epoch" to "generation epoch" —
   * it now also increments on parameter changes that invalidate cached output.
   *
   * Requirements: 6.2
   */
  invalidateEagerCache(sessionId: string): void {
    this.cancelEagerGeneration(sessionId);
  }


  // ─── Eager Pipeline: Core Execution ────────────────────────────────────────────

  /**
   * Runs the eager evaluation pipeline in the background.
   *
   * NOT async — returns a deferred promise so that (eagerPromise, eagerRunId, eagerStatus)
   * are set atomically (synchronously) before any async work begins.
   *
   * Pipeline stages (same as generateEvaluation):
   *   LLM generation → energy profile → script rendering → tone check →
   *   timing trim → scope acknowledgment → name redaction → TTS synthesis
   *
   * Key invariants:
   * - Never transitions session.state or calls assertTransition()
   * - Never sends messages or triggers delivery
   * - Evidence validation runs against raw (unredacted) transcript; redaction applied after
   * - Promise always resolves, never rejects (never-reject contract)
   * - safeProgress wraps all onProgress calls in try/catch
   * - Dual-guard finally for cleanup ownership
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.2, 8.1, 8.2
   */
  runEagerPipeline(
    sessionId: string,
    onProgress?: (stage: PipelineStage) => void,
  ): Promise<void> {
    const session = this.getSession(sessionId);

    // State precondition guard — MUST be first, before any field reads or mutations
    if (session.state !== SessionState.PROCESSING) {
      return Promise.resolve();
    }

    // Single-flight guard using eagerRunId
    if (
      session.eagerRunId === session.runId &&
      (session.eagerStatus === "generating" || session.eagerStatus === "synthesizing")
    ) {
      return session.eagerPromise!;
    }

    // Capture params — only after guards pass
    const capturedRunId = session.runId;
    const capturedTimeLimit = session.timeLimitSeconds;
    const capturedVoice = session.voiceConfig ?? "nova";

    // Safe progress helper — never throws
    const safeProgress = (stage: PipelineStage) => {
      try {
        onProgress?.(stage);
      } catch {
        /* swallow — callback throws must not reject the promise */
      }
    };

    // Deferred: create promise BEFORE setting status (all synchronous, no throw possible)
    const { promise, resolve } = createDeferred<void>();
    session.eagerPromise = promise;
    session.eagerRunId = capturedRunId;
    session.eagerStatus = "generating";

    // Async work — always resolves, never rejects
    (async () => {
      try {
        safeProgress("generating_evaluation");

        // Guard: need generator, transcript, and metrics to proceed
        if (!this.deps.evaluationGenerator || session.transcript.length === 0 || !session.metrics) {
          if (!this.deps.evaluationGenerator) {
            this.log("WARN", `[eager] No EvaluationGenerator configured — eager pipeline skipped`);
          } else if (session.transcript.length === 0) {
            this.log("WARN", `[eager] No transcript available for session ${sessionId}`);
          } else {
            this.log("WARN", `[eager] No metrics available for session ${sessionId}`);
          }
          // Treat missing deps as failure
          if (capturedRunId === session.runId) {
            session.eagerStatus = "failed";
            session.evaluationCache = null;
            safeProgress("failed");
          }
          return;
        }

        const metrics = session.metrics;

        // ── Stage 1: LLM Generation ──
        // Build EvaluationConfig from session.projectContext (Req 4.5, 5.1, 5.5)
        const config: EvaluationConfig | undefined = session.projectContext
          ? {
              objectives: session.projectContext.objectives,
              speechTitle: session.projectContext.speechTitle ?? undefined,
              projectType: session.projectContext.projectType ?? undefined,
            }
          : undefined;

        this.log("INFO", `[eager] Generating evaluation for session ${sessionId}`);
        const generateResult = await this.deps.evaluationGenerator.generate(
          session.transcript,
          metrics,
          config,
        );

        // RunId check after LLM generation
        if (session.runId !== capturedRunId) {
          this.log("WARN", `[eager] RunId changed during LLM generation for session ${sessionId}, discarding`);
          return;
        }

        const evaluation = generateResult.evaluation;
        session.evaluationPassRate = generateResult.passRate;

        // ── Stage 2: Compute energy profile from audio chunks ──
        if (this.deps.metricsExtractor && session.audioChunks.length > 0) {
          const energyProfile = this.deps.metricsExtractor.computeEnergyProfile(session.audioChunks);
          metrics.energyProfile = energyProfile;
          metrics.energyVariationCoefficient = energyProfile.coefficientOfVariation;
        }

        // ── Stage 3: Script Rendering (with markers, UNREDACTED) ──
        let script = this.deps.evaluationGenerator.renderScript(
          evaluation,
          undefined, // No speakerName — prevents old redaction path; redaction at stage 7
          metrics,
        );

        // RunId check after rendering
        if (session.runId !== capturedRunId) {
          return;
        }

        // ── Stage 4: Tone Check + Fix ──
        if (this.deps.toneChecker) {
          const hasVideo = session.visualObservations != null;
          const toneResult = this.deps.toneChecker.check(script, evaluation, metrics, { hasVideo });
          if (!toneResult.passed) {
            script = this.deps.toneChecker.stripViolations(script, toneResult.violations);
          }
          // Strip markers exactly once at the end of stage 4
          script = this.deps.toneChecker.stripMarkers(script);
        } else {
          // No ToneChecker — strip markers with regex fallback
          script = script.replace(/\s*\[\[(Q|M):[^\]]+\]\]/g, "").replace(/\s{2,}/g, " ").trim();
        }

        // RunId check after tone check
        if (session.runId !== capturedRunId) {
          return;
        }

        // ── Stage 5: Timing Trim ──
        if (this.deps.ttsEngine) {
          script = this.deps.ttsEngine.trimToFit(script, capturedTimeLimit);
        }

        // ── Stage 6: Scope Acknowledgment Check ──
        if (this.deps.toneChecker) {
          const hasStructureCommentary = !!(
            evaluation.structure_commentary?.opening_comment ||
            evaluation.structure_commentary?.body_comment ||
            evaluation.structure_commentary?.closing_comment
          );
          const hasVideo = session.visualObservations != null;
          script = this.deps.toneChecker.appendScopeAcknowledgment(
            script,
            session.qualityWarning,
            hasStructureCommentary,
            { hasVideo },
          );
        }

        // RunId check before redaction
        if (session.runId !== capturedRunId) {
          return;
        }

        // ── Stage 7: Name Redaction ──
        // Evidence validation runs against raw (unredacted) transcript; redaction applied after
        let scriptForTTS = script;
        let evaluationPublic: StructuredEvaluationPublic | null = null;

        if (session.consent && this.deps.evaluationGenerator) {
          const redactionResult = this.deps.evaluationGenerator.redact({
            script,
            evaluation,
            consent: session.consent,
          });
          scriptForTTS = redactionResult.scriptRedacted;
          evaluationPublic = redactionResult.evaluationPublic;
        }

        // RunId check before TTS synthesis
        if (session.runId !== capturedRunId) {
          return;
        }

        // ── Stage 8: TTS Synthesis ──
        session.eagerStatus = "synthesizing";
        safeProgress("synthesizing_audio");

        if (this.deps.ttsEngine) {
          this.log("INFO", `[eager] Synthesizing TTS audio for session ${sessionId}`);
          const audioBuffer = await this.deps.ttsEngine.synthesize(scriptForTTS);

          // RunId check before committing
          if (session.runId !== capturedRunId) {
            this.log("WARN", `[eager] RunId changed during TTS synthesis for session ${sessionId}, discarding`);
            return;
          }

          // Build EvaluationCache atomically
          const cache: EvaluationCache = {
            runId: capturedRunId,
            timeLimitSeconds: capturedTimeLimit,
            voiceConfig: capturedVoice,
            evaluation,
            evaluationScript: scriptForTTS,
            ttsAudio: audioBuffer,
            evaluationPublic,
          };

          // Confirm artifact.runId === session.runId before publishing
          if (cache.runId === session.runId) {
            session.evaluationCache = cache;
            session.eagerStatus = "ready";
            this.log("INFO", `[eager] Pipeline complete for session ${sessionId}: cache published (runId=${capturedRunId})`);
            safeProgress("ready");
          }
        } else {
          this.log("WARN", `[eager] No TTSEngine configured — eager pipeline cannot complete`);
          if (capturedRunId === session.runId) {
            session.eagerStatus = "failed";
            session.evaluationCache = null;
            safeProgress("failed");
          }
        }
      } catch (err) {
        // Encode failure — never rethrow
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log("ERROR", `[eager] Pipeline failed for session ${sessionId}: ${errMsg}`);
        if (capturedRunId === session.runId) {
          session.eagerStatus = "failed";
          session.evaluationCache = null;
          safeProgress("failed");
        }
      } finally {
        // Dual-guard cleanup: only touch fields if this run still owns the session.
        // Check BOTH eagerRunId and eagerPromise identity — resilient to future refactors
        // where one field could be reset early while the other still identifies ownership.
        const isOwner = session.eagerRunId === capturedRunId || session.eagerPromise === promise;
        if (isOwner) {
          if (capturedRunId !== session.runId && session.eagerStatus !== "ready") {
            // Mismatch + not ready: restore coherence — prevent zombie generating/synthesizing.
            // If eagerStatus is "ready", the cache was successfully published before runId changed;
            // don't force idle here — clearEagerState/cancelEagerGeneration will handle it.
            session.eagerStatus = "idle";
          }
          session.eagerPromise = null;
          session.eagerRunId = null;
        }
        resolve(); // Always resolve the deferred — never reject
      }
    })();

    return promise;
  }







  /**
   * Returns the cached TTS audio buffer for replay.
   * Transitions the session from IDLE to DELIVERING state.
   * Returns undefined if no cached audio is available.
   *
   * Note: IDLE → DELIVERING is not in the standard VALID_TRANSITIONS map
   * (which only has IDLE → RECORDING). Replay is a special case that reuses
   * the DELIVERING state for echo prevention and UI consistency, so we
   * check the state manually instead of using assertTransition().
   *
   * @throws Error if the session is not in IDLE state.
   */
  replayTTS(sessionId: string): Buffer | undefined {
    const session = this.getSession(sessionId);
    // Check both ttsAudioCache (set by generateEvaluation/fallback path)
    // and evaluationCache.ttsAudio (set by eager pipeline cache-hit delivery path)
    const audio = session.ttsAudioCache ?? session.evaluationCache?.ttsAudio ?? undefined;
    if (!audio) return undefined;
    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Invalid state transition: cannot call replayTTS() in "${session.state}" state. ` +
        `Expected state: "idle". Current state: "${session.state}".`
      );
    }
    session.state = SessionState.DELIVERING;
    return audio;
  }


  /**
   * Panic mute: immediately transitions to IDLE from ANY state.
   *
   * Behavior:
   * - Increments runId so any pending async operations (transcription, TTS)
   *   will see a stale runId and discard their results.
   * - Buffered audio chunks are PRESERVED (not discarded) so the operator
   *   can still attempt evaluation from what was captured.
   * - Stops live transcription if active.
   */
  panicMute(sessionId: string): void {
    const session = this.getSession(sessionId);

    // panicMute is a no-op if already IDLE — no runId increment needed
    if (session.state === SessionState.IDLE) {
      return;
    }

    session.runId++;
    session.state = SessionState.IDLE;

    // Stop and remove VAD monitor (Req 11.1)
    const vadMonitor = this.vadMonitors.get(sessionId);
    if (vadMonitor) {
      vadMonitor.stop();
      this.vadMonitors.delete(sessionId);
    }
    this.vadCallbacksMap.delete(sessionId);

    // Clear eager pipeline state — runId already incremented above,
    // so use clearEagerState() (pure reset), not cancelEagerGeneration()
    this.clearEagerState(sessionId);

    // Phase 4: Stop and remove VideoProcessor (clears frame queue)
    const videoProcessor = this.videoProcessors.get(sessionId);
    if (videoProcessor) {
      videoProcessor.stop();
      this.videoProcessors.delete(sessionId);
    }

    // Stop live transcription if active
    if (this.deps.transcriptionEngine) {
      try {
        this.deps.transcriptionEngine.stopLive();
      } catch {
        // Ignore errors from stopping live transcription during panic mute
        // The transcription engine may not be in a live state
      }
    }
  }

  /**
   * Save session outputs to disk via FilePersistence.
   * This is the only path to persistence — opt-in only.
   *
   * @returns Array of saved file paths, or empty array if no persistence engine.
   */
  async saveOutputs(sessionId: string): Promise<string[]> {
    const session = this.getSession(sessionId);

    if (this.deps.filePersistence) {
      return this.deps.filePersistence.saveSession(session);
    }

    return [];
  }

  // ─── Transcript Quality Assessment ──────────────────────────────────────────

  /**
   * Assess transcript quality based on word count/minute and confidence.
   * Returns true if quality issues are detected.
   *
   * Checks:
   * - Total word count relative to recording duration (flag if < 10 words per minute)
   * - Average word confidence score (flag if < 0.5), computed over speech words only
   *   (excluding silence and non-speech markers)
   *
   * A word is considered a silence/non-speech marker if its text is empty,
   * whitespace-only, or matches common non-speech tokens (e.g., "[silence]",
   * "[noise]", "[music]", "[inaudible]").
   *
   * Requirements: 10.1
   */
  private assessTranscriptQuality(
    transcript: TranscriptSegment[],
    metrics: DeliveryMetrics | null,
  ): boolean {
    // Check words per minute
    if (metrics && metrics.durationSeconds > 0) {
      const wpm = metrics.totalWords / (metrics.durationSeconds / 60);
      if (wpm < MIN_WORDS_PER_MINUTE) {
        return true;
      }
    }

    // Check average word confidence — exclude silence/non-speech markers
    const allWords = transcript.flatMap((s) => s.words);
    const speechWords = allWords.filter((w) => !isSilenceOrNonSpeechMarker(w.word));
    if (speechWords.length > 0) {
      const avgConfidence =
        speechWords.reduce((sum, w) => sum + w.confidence, 0) / speechWords.length;
      if (avgConfidence < MIN_AVERAGE_CONFIDENCE) {
        return true;
      }
    }

    return false;
  }

  // ─── State Transition Helpers ───────────────────────────────────────────────

  /**
   * Validates that a state transition is allowed.
   * @throws Error with a descriptive message if the transition is invalid.
   */
  private assertTransition(
    session: Session,
    targetState: SessionState,
    methodName: string,
  ): void {
    const allowedTarget = VALID_TRANSITIONS.get(session.state);

    if (allowedTarget !== targetState) {
      throw new Error(
        `Invalid state transition: cannot call ${methodName}() in "${session.state}" state. ` +
          `Expected state: "${this.getExpectedStateForTarget(targetState)}". ` +
          `Current state: "${session.state}".`,
      );
    }
  }

  /**
   * Returns the expected source state for a given target state.
   * Used for descriptive error messages.
   */
  private getExpectedStateForTarget(targetState: SessionState): string {
    for (const [source, target] of VALID_TRANSITIONS) {
      if (target === targetState) {
        return source;
      }
    }
    return "unknown";
  }
}
