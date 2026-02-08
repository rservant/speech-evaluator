# Implementation Plan: AI Toastmasters Evaluator MVP (Phase 1)

## Overview

Build a Node.js/TypeScript web application that captures a live Toastmasters speech via microphone, transcribes it (Deepgram live + OpenAI post-pass), computes delivery metrics, generates a structured evidence-based evaluation via GPT-4o, and delivers it aloud via OpenAI TTS. The implementation follows the pipeline architecture defined in the design document.

## Tasks

- [x] 1. Project setup and shared types
  - [x] 1.1 Initialize Node.js project with TypeScript, ESM, and install dependencies
    - Initialize `package.json` with `"type": "module"`
    - Install: `typescript`, `express`, `ws`, `uuid`, `dotenv`, `@deepgram/sdk`, `openai`
    - Install dev: `vitest`, `fast-check`, `@types/express`, `@types/ws`
    - Create `tsconfig.json` with strict mode, ESM output
    - Create `.env.example` with `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `PORT`
    - _Requirements: 8.1_
  - [x] 1.2 Define all shared TypeScript interfaces and types
    - Create `src/types.ts` with: `SessionState`, `Session`, `TranscriptSegment`, `TranscriptWord`, `DeliveryMetrics`, `FillerWordEntry`, `StructuredEvaluation`, `EvaluationItem`, `EvaluationConfig`, `TTSConfig`, `ClientMessage`, `ServerMessage`
    - Include `runId`, `audioChunks`, `qualityWarning`, `outputsSaved`, extensibility fields
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 2. Session Manager
  - [x] 2.1 Implement SessionManager with state machine
    - Create `src/session-manager.ts`
    - Implement `createSession()`, `startRecording()`, `stopRecording()`, `generateEvaluation()`, `getSession()`, `panicMute()`
    - Enforce valid state transitions (IDLE→RECORDING→PROCESSING→DELIVERING→IDLE)
    - Implement `runId` increment on start/panic for cancellation correctness
    - Throw descriptive errors on invalid transitions
    - _Requirements: 1.1, 1.2, 1.4, 1.6, 1.8_
  - [x] 2.2 Write unit tests for SessionManager
    - Test all valid state transitions
    - Test invalid transition rejection with descriptive errors
    - Test `panicMute()` from each state
    - Test `runId` increments correctly
    - _Requirements: 1.1, 1.2, 1.4, 1.6, 1.8_

- [x] 3. Metrics Extractor
  - [x] 3.1 Implement MetricsExtractor
    - Create `src/metrics-extractor.ts`
    - Implement `extract(segments: TranscriptSegment[]): DeliveryMetrics`
    - Compute duration from first segment startTime to last segment endTime
    - Compute WPM from total word count and duration
    - Implement two-tier filler word detection: known list + contextual heuristics
    - Implement pause detection with configurable threshold (default 1.5s)
    - Handle segment-level fallback when word-level timestamps unavailable
    - Output structured `DeliveryMetrics` JSON
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x] 3.2 Write property test: Duration Computation Correctness
    - **Property 2: Duration Computation Correctness**
    - **Validates: Requirements 3.1**
  - [x] 3.3 Write property test: WPM Computation Correctness
    - **Property 3: WPM Computation Correctness**
    - **Validates: Requirements 3.2**
  - [x] 3.4 Write property test: Filler Word Metrics Internal Consistency
    - **Property 4: Filler Word Metrics Internal Consistency**
    - **Validates: Requirements 3.3**
  - [x] 3.5 Write property test: Pause Detection Correctness
    - **Property 5: Pause Detection Correctness**
    - **Validates: Requirements 3.4**
  - [x] 3.6 Write unit tests for contextual filler word detection
    - Test "like" as filler vs. "like" as verb/preposition
    - Test "so" sentence-initial filler vs. "so" as conjunction
    - Test edge cases: empty transcript, single-word transcript, all fillers
    - _Requirements: 3.3, 3.6_

- [x] 4. Checkpoint - Ensure all metrics tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Evaluation Generator
  - [x] 5.1 Implement evidence validation logic
    - Create `src/evidence-validator.ts`
    - Implement token normalization (lowercase, strip punctuation, collapse whitespace)
    - Implement contiguous token matching (≥6 consecutive tokens)
    - Implement timestamp locality check (±20s, with segment-level fallback)
    - Implement `validate(evaluation, transcriptSegments)` returning `{ valid, issues }`
    - _Requirements: 4.3, 4.6_
  - [x] 5.2 Write property test: Evidence Quote Validation
    - **Property 7: Evidence Quote Validation**
    - **Validates: Requirements 4.3, 4.6**
  - [x] 5.3 Implement EvaluationGenerator with structured output
    - Create `src/evaluation-generator.ts`
    - Build prompt with transcript text, metrics JSON, style instructions (no CRC), commendation/recommendation counts, evidence quoting rules, quality warning caveats
    - Use OpenAI structured output (JSON mode) to produce `StructuredEvaluation`
    - Implement retry logic: per-item re-prompt on evidence failure (max 1), full regeneration if shape violated (max 2 total)
    - Implement `renderScript(evaluation)` to produce natural spoken text from structured JSON
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 5.4 Write property test: Structured Evaluation Shape Invariant
    - **Property 8: Structured Evaluation Shape Invariant**
    - **Validates: Requirements 4.1, 4.2**
  - [x] 5.5 Implement TTS Engine with pre-TTS time enforcement
    - Create `src/tts-engine.ts`
    - Implement `estimateDuration(text, wpm)` using word count / calibrated WPM
    - Implement `trimToFit(text, maxSeconds, wpm)` that shortens script at sentence boundaries
    - Implement `synthesize(text, config)` calling OpenAI TTS API with voice config
    - Default voice: "cedar", default max: 210s, default WPM: 150
    - _Requirements: 5.1, 5.2_
  - [x] 5.6 Write property test: Evaluation Script Duration Compliance
    - **Property 6: Evaluation Script Duration Compliance**
    - **Validates: Requirements 4.5**

- [x] 6. Checkpoint - Ensure all evaluation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Transcription Engine
  - [x] 7.1 Implement Deepgram live caption integration
    - Create `src/transcription-engine.ts`
    - Implement `startLive(onSegment)` opening Deepgram WebSocket with configured audio format
    - Implement `feedAudio(chunk)` forwarding audio to Deepgram
    - Implement `stopLive()` closing the Deepgram connection
    - Handle interim vs final segments, emit with `isFinal` flag
    - Mark quality warning on connection drop (no reconnect/stitch)
    - _Requirements: 2.1, 2.2, 2.4_
  - [x] 7.2 Implement OpenAI post-speech transcription
    - Implement `finalize(fullAudio)` sending concatenated audio to OpenAI `gpt-4o-transcribe`
    - Parse response into `TranscriptSegment[]` with word-level timestamps
    - Handle segment-level fallback if word timestamps unavailable
    - _Requirements: 2.2, 2.3_
  - [x] 7.3 Write property test: Transcript Structural Invariant
    - **Property 1: Transcript Structural Invariant**
    - **Validates: Requirements 2.2**

- [x] 8. Audio capture and WebSocket server
  - [x] 8.1 Implement WebSocket handler and Express server
    - Create `src/server.ts` with Express + `ws` WebSocket server
    - Implement audio format handshake validation (mono, LINEAR16, 16kHz)
    - Validate chunk byte alignment (multiple of 2) and arrival rate
    - Route `ClientMessage` types to SessionManager methods
    - Emit `ServerMessage` types back to client
    - Implement `replaceFromIndex` semantics for transcript updates
    - Buffer audio chunks in session for post-speech transcription
    - Implement elapsed time ticker during RECORDING state
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.7, 2.5_
  - [x] 8.2 Write property test: Audio Capture Inactive During Delivery
    - **Property 9: Audio Capture Inactive During Delivery**
    - **Validates: Requirements 5.3**

- [x] 9. File Persistence
  - [x] 9.1 Implement FilePersistence with opt-in saving
    - Create `src/file-persistence.ts`
    - Implement `saveSession(session)` creating timestamped directory with session ID
    - Write `transcript.txt` with `[MM:SS]` formatted timestamps
    - Write `metrics.json` as serialized DeliveryMetrics
    - Write `evaluation.txt` with session metadata header + evaluation text
    - Only triggered when Operator clicks "Save Outputs"
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 9.2 Write property test: Session Output File Round-Trip
    - **Property 10: Session Output File Round-Trip**
    - **Validates: Requirements 6.1, 6.2, 6.3**
  - [x] 9.3 Write property test: Output Directory Naming Convention
    - **Property 11: Output Directory Naming Convention**
    - **Validates: Requirements 6.4**

- [x] 10. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Web UI (browser client)
  - [x] 11.1 Implement HTML/CSS control panel
    - Create `public/index.html` with session control buttons (Start Speech, Stop Speech, Deliver Evaluation, Save Outputs, Panic Mute)
    - Style with minimal CSS for meeting readability
    - Show/hide buttons based on session state
    - Display elapsed time during recording
    - Display live transcript area
    - Display evaluation text area (for fallback reading)
    - Display "Speaking..." indicator during TTS delivery
    - _Requirements: 1.1, 1.3, 1.5, 1.7, 1.8_
  - [x] 11.2 Implement browser audio capture with AudioWorklet
    - Create `public/audio-worklet.js` for Float32→Int16 conversion + downsampling to 16kHz
    - Implement WebSocket connection to server
    - Send `audio_format` handshake before streaming
    - Stream 50ms audio chunks during recording
    - Handle mic permission request and detection failure
    - Hard-stop MediaStream tracks on panic mute and during DELIVERING state
    - Implement 2-3 second cooldown after TTS before re-arming mic
    - _Requirements: 2.1, 2.5, 5.3, 7.2_
  - [x] 11.3 Implement WebSocket client message handling
    - Handle `state_change` messages to update UI controls
    - Handle `transcript_update` with `replaceFromIndex` splice logic
    - Handle `evaluation_ready` to display written evaluation
    - Handle `tts_audio` for audio playback via Web Audio API
    - Handle `tts_complete` to reset UI
    - Handle `error` and `audio_format_error` messages with user-visible alerts
    - _Requirements: 1.1, 1.3, 1.5, 1.7, 1.8, 7.2, 7.3, 7.4_

- [x] 12. Integration wiring
  - [x] 12.1 Wire the full pipeline in SessionManager
    - Connect `startRecording()` → TranscriptionEngine.startLive() + audio buffering
    - Connect `stopRecording()` → TranscriptionEngine.stopLive() + finalize(concatenated audio) + MetricsExtractor.extract()
    - Connect `generateEvaluation()` → EvaluationGenerator.generate() + validate() + renderScript() + TTSEngine.trimToFit() + synthesize()
    - Connect `panicMute()` → stop all, check runId before committing
    - Connect `save_outputs` → FilePersistence.saveSession()
    - Implement transcript quality assessment (word count/minute, confidence threshold)
    - _Requirements: 1.2, 1.4, 1.6, 7.1_
  - [x] 12.2 Implement error handling flows
    - TTS failure → display written evaluation as fallback
    - LLM failure → display error, allow retry
    - Transcription drop → quality warning, proceed with post-pass
    - Post-pass failure → fall back to Deepgram segments with quality warning
    - Mic detection failure → disable Start Speech, show error
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 13. Final checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript throughout with Vitest + fast-check for testing
- External APIs (Deepgram, OpenAI) should be abstracted behind interfaces for testability with mocks
