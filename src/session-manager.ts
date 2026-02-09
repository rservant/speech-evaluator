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
} from "./types.js";
import type { TranscriptionEngine } from "./transcription-engine.js";
import type { MetricsExtractor } from "./metrics-extractor.js";
import type { EvaluationGenerator } from "./evaluation-generator.js";
import type { TTSEngine } from "./tts-engine.js";
import type { ToneChecker } from "./tone-checker.js";
import type { FilePersistence } from "./file-persistence.js";

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

  private log(level: string, msg: string): void {
    console.log(`[${level}] [SessionManager] ${msg}`);
  }

  constructor(deps: SessionManagerDeps = {}) {
    this.deps = deps;
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
      this.log("INFO", `Generating evaluation via GPT-4o for session ${sessionId} (${session.transcript.length} segments, ${metrics.totalWords} words)`);
      const generateResult = await this.deps.evaluationGenerator.generate(
        session.transcript,
        metrics,
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
      this.log("INFO", `Running tone check for session ${sessionId}`);
      const toneResult = this.deps.toneChecker.check(script, evaluation, metrics);

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
      script = this.deps.toneChecker.appendScopeAcknowledgment(
        script,
        session.qualityWarning,
        hasStructureCommentary,
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
    if (!session.ttsAudioCache) return undefined;
    if (session.state !== SessionState.IDLE) {
      throw new Error(
        `Invalid state transition: cannot call replayTTS() in "${session.state}" state. ` +
        `Expected state: "idle". Current state: "${session.state}".`
      );
    }
    session.state = SessionState.DELIVERING;
    return session.ttsAudioCache;
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
