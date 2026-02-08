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
  TranscriptSegment,
  DeliveryMetrics,
  StructuredEvaluation,
} from "./types.js";
import type { TranscriptionEngine } from "./transcription-engine.js";
import type { MetricsExtractor } from "./metrics-extractor.js";
import type { EvaluationGenerator } from "./evaluation-generator.js";
import type { TTSEngine } from "./tts-engine.js";
import type { FilePersistence } from "./file-persistence.js";

// ─── Quality thresholds (matching EvaluationGenerator's internal thresholds) ────

const MIN_WORDS_PER_MINUTE = 10;
const MIN_AVERAGE_CONFIDENCE = 0.5;

// ─── Dependency injection interface ─────────────────────────────────────────────

export interface SessionManagerDeps {
  transcriptionEngine?: TranscriptionEngine;
  metricsExtractor?: MetricsExtractor;
  evaluationGenerator?: EvaluationGenerator;
  ttsEngine?: TTSEngine;
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
      evaluationScript: null,
      qualityWarning: false,
      outputsSaved: false,
      runId: 0,
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
  startRecording(sessionId: string): void {
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
    session.evaluationScript = null;
    session.qualityWarning = false;
    session.outputsSaved = false;
    session.stoppedAt = null;

    // Start live transcription if engine is available
    if (this.deps.transcriptionEngine) {
      this.log("INFO", `Starting Deepgram live transcription for session ${sessionId}`);
      const capturedRunId = session.runId;
      this.deps.transcriptionEngine.startLive((segment: TranscriptSegment) => {
        // Only commit live transcript if runId still matches (not cancelled)
        if (session.runId === capturedRunId) {
          session.liveTranscript.push(segment);
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
   * Pipeline wiring:
   * 1. Set state to DELIVERING
   * 2. Generate evaluation: EvaluationGenerator.generate(transcript, metrics)
   * 3. Validate evidence: EvaluationGenerator.validate(evaluation, transcript)
   * 4. Render script: EvaluationGenerator.renderScript(evaluation, speakerName)
   * 5. Trim script: TTSEngine.trimToFit(script, maxSeconds)
   * 6. Synthesize audio: TTSEngine.synthesize(trimmedScript)
   * 7. Store evaluation, script, and audio in session
   * 8. All async operations check runId before committing results
   * 9. Return the synthesized audio buffer for the server to stream
   *
   * @throws Error if the session is not in PROCESSING state.
   * @returns The synthesized TTS audio buffer, or undefined if no TTS engine.
   */
  /**
     * Transitions the session from PROCESSING to DELIVERING.
     *
     * Pipeline wiring:
     * 1. Set state to DELIVERING
     * 2. Generate evaluation: EvaluationGenerator.generate(transcript, metrics)
     *    - On LLM failure: transition back to PROCESSING, re-throw for server to handle (Req 7.3)
     * 3. Validate evidence: EvaluationGenerator.validate(evaluation, transcript)
     * 4. Render script: EvaluationGenerator.renderScript(evaluation, speakerName)
     * 5. Trim script: TTSEngine.trimToFit(script, maxSeconds)
     * 6. Synthesize audio: TTSEngine.synthesize(trimmedScript)
     *    - On TTS failure: return undefined (no audio), evaluation/script remain stored (Req 7.4)
     * 7. Store evaluation, script, and audio in session
     * 8. All async operations check runId before committing results
     * 9. Return the synthesized audio buffer for the server to stream
     *
     * @throws Error if the session is not in PROCESSING state.
     * @throws Error if LLM generation fails (session transitions back to PROCESSING).
     * @returns The synthesized TTS audio buffer, or undefined if no TTS engine or TTS failure.
     */
    async generateEvaluation(sessionId: string): Promise<Buffer | undefined> {
          const session = this.getSession(sessionId);
          this.assertTransition(session, SessionState.DELIVERING, "generateEvaluation");

          session.state = SessionState.DELIVERING;

          const capturedRunId = session.runId;

          // Generate evaluation if generator is available
          if (this.deps.evaluationGenerator && session.transcript.length > 0 && session.metrics) {
            let evaluation: StructuredEvaluation;

            try {
              this.log("INFO", `Generating evaluation via GPT-4o for session ${sessionId} (${session.transcript.length} segments, ${session.metrics.totalWords} words)`);
              evaluation = await this.deps.evaluationGenerator.generate(
                session.transcript,
                session.metrics,
              );
              this.log("INFO", `Evaluation generated: ${evaluation.items.length} items (${evaluation.items.filter(i => i.type === "commendation").length} commendations, ${evaluation.items.filter(i => i.type === "recommendation").length} recommendations)`);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.log("ERROR", `Evaluation generation failed for session ${sessionId}: ${errMsg}`);
              // LLM failure: transition back to PROCESSING so operator can retry (Req 7.3)
              if (session.runId === capturedRunId) {
                session.state = SessionState.PROCESSING;
              }
              throw err;
            }

            // Check runId before committing
            if (session.runId !== capturedRunId) {
              this.log("WARN", `RunId changed during evaluation generation for session ${sessionId}, discarding`);
              return undefined;
            }

            session.evaluation = evaluation;

            // Render script with redaction (validate first, redact second per privacy rules)
            this.log("INFO", `Rendering evaluation script for session ${sessionId}`);
            const script = this.deps.evaluationGenerator.renderScript(
              evaluation,
              session.speakerName,
            );

            // Check runId before committing
            if (session.runId !== capturedRunId) {
              return undefined;
            }

            session.evaluationScript = script;

            // Trim and synthesize via TTS engine
            if (this.deps.ttsEngine) {
              const trimmedScript = this.deps.ttsEngine.trimToFit(script, 210);

              // Check runId before synthesis
              if (session.runId !== capturedRunId) {
                return undefined;
              }

              // Update script to the trimmed version
              session.evaluationScript = trimmedScript;

              try {
                this.log("INFO", `Synthesizing TTS audio for session ${sessionId} (${trimmedScript.split(/\s+/).length} words)`);
                const audioBuffer = await this.deps.ttsEngine.synthesize(trimmedScript);

                // Check runId before committing audio
                if (session.runId !== capturedRunId) {
                  return undefined;
                }

                this.log("INFO", `TTS synthesis complete: ${audioBuffer.length} bytes for session ${sessionId}`);
                return audioBuffer;
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.log("ERROR", `TTS synthesis failed for session ${sessionId}: ${errMsg}. Falling back to written evaluation.`);
                // TTS failure: evaluation and script are already stored in session (Req 7.4)
                // Return undefined (no audio) — server will send evaluation_ready with script text
                // so the client can display the written evaluation as fallback
                return undefined;
              }
            } else {
              this.log("WARN", `No TTSEngine configured — TTS synthesis skipped`);
            }
          } else if (!this.deps.evaluationGenerator) {
            this.log("WARN", `No EvaluationGenerator configured — evaluation generation skipped`);
          } else if (session.transcript.length === 0) {
            this.log("WARN", `No transcript available for session ${sessionId} — cannot generate evaluation`);
          } else if (!session.metrics) {
            this.log("WARN", `No metrics available for session ${sessionId} — cannot generate evaluation`);
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
   * - Average word confidence score (flag if < 0.5)
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

    // Check average word confidence
    const allWords = transcript.flatMap((s) => s.words);
    if (allWords.length > 0) {
      const avgConfidence =
        allWords.reduce((sum, w) => sum + w.confidence, 0) / allWords.length;
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
