# Implementation Plan: Phase 4 — Multimodal (Video / Delivery Coaching)

## Overview

Incremental implementation of the video processing pipeline, visual metrics extraction, evaluation integration, and safety guardrails. Each task builds on previous tasks. Testing is interleaved with implementation to catch errors early. The audio pipeline remains untouched except for additive type extensions and evaluation generator changes.

**Task ordering rationale:** Pipeline correctness is proven before integration. Types → codec → queue/sampler → processor core → metric correctness → statistical stability → performance validation → THEN session integration → safety → evaluation → server → UI. This prevents integrating an unvalidated pipeline. Basic UI frame streaming is moved earlier (task 5) to surface real camera behavior, timestamp drift, and CPU contention before full integration.

## Tasks

- [ ] 1. Type extensions and protocol definitions
  - [ ] 1.1 Extend `src/types.ts` with Phase 4 types
    - Add `VideoConsent`, `VisualMetrics`, `VisualFeedbackItem`, `GazeBreakdown` interfaces
    - Add `videoQualityGrade: "good" | "degraded" | "poor"` to `VisualMetrics`
    - Add `videoQualityWarning` as derived field (`videoQualityGrade !== "good"`) — NOT stored independently, NOT separately computed
    - Add per-metric reliability flags: `gazeReliable`, `gestureReliable`, `stabilityReliable`, `facialEnergyReliable`
    - Add `facialEnergyLowSignal: boolean` to `VisualMetrics`
    - Add `gesturePerSentenceRatio: number | null` (nullable when suppressed)
    - Add `framesDroppedByTimestamp: number` to `VisualObservations`
    - Add `framesDroppedByFinalizationBudget: number` to `VisualObservations`
    - Add `resolutionChangeCount: number` to `VisualObservations`
    - Add `videoProcessingVersion: { tfjsVersion: string; tfjsBackend: string; modelVersions: { blazeface: string; movenet: string }; configHash: string }` to `VisualObservations`
    - Add `visual_feedback?: VisualFeedbackItem[]` to `StructuredEvaluation`
    - Add `visualMetrics: VisualMetrics | null` to `DeliveryMetrics` (default null)
    - Add `videoConsent`, `videoStreamReady`, `visualObservations`, `videoConfig` fields to `Session`
    - Add new `ClientMessage` variants: `set_video_consent`, `video_stream_ready` (with `deviceLabel` optional), `set_video_config`
    - Add new `ServerMessage` variant: `video_status`
    - Add `FrameHeader` interface with `timestamp`, `seq`, `width`, `height`
    - Add `AudioFrameHeader` interface with `timestamp`, `seq`
    - Add `FrameType` type: `'audio' | 'video'`
    - Add `VideoConfig` interface with all config fields including hysteresis params, confidence thresholds, rounding precision, epsilon, per-metric coverage thresholds (gaze 0.6, facial 0.4, gesture 0.3, stability 0.6)
    - _Requirements: 1.1, 1.2, 1.3, 9.1, 10.1, 10.2, 10.3, 10.5, 17.1, 17.2, 18.2, 18.4, 19.3, 19.5, 20.1, 20.2_

  - [ ]* 1.2 Write property test for video consent independence
    - **Property 1: Video consent independence from audio consent**
    - **Validates: Requirements 1.3**

- [ ] 2. Frame codec, queue, and sampler
  - [ ] 2.1 Implement binary frame codec functions (`src/video-frame-codec.ts`)
    - `encodeVideoFrame(header: FrameHeader, jpegBuffer: Buffer): Buffer` — produces `[0x54 0x4D][0x56][uint24 header len][header JSON][JPEG bytes]`
    - `decodeVideoFrame(data: Buffer): { header: FrameHeader; jpegBuffer: Buffer } | null` — parses the wire format, returns null on malformed input
    - `isVideoFrame(data: Buffer): boolean` — checks TM magic prefix `0x54 0x4D` and type byte `0x56`
    - `encodeAudioFrame(header: AudioFrameHeader, pcmBuffer: Buffer): Buffer` — produces `[0x54 0x4D][0x41][uint24 header len][header JSON][PCM bytes]`
    - `decodeAudioFrame(data: Buffer): { header: AudioFrameHeader; pcmBuffer: Buffer } | null` — parses audio frame, returns null on malformed input
    - `isTMFrame(data: Buffer): boolean` — checks TM magic prefix `0x54 0x4D`
    - `getFrameType(data: Buffer): 'audio' | 'video' | null` — reads type byte at offset 2
    - Enforce wire-format safety limits: TM magic prefix `0x54 0x4D` required, type byte must be `0x41` (audio) or `0x56` (video), header JSON ≤ 4096 bytes, JPEG payload ≤ 2MB for video, resolution ≤ 1920×1080 for video
    - Validate all FrameHeader fields are present and correctly typed: `timestamp` (number ≥ 0), `seq` (non-negative integer), `width` (positive integer), `height` (positive integer)
    - `seq` is required in FrameHeader — frames without valid `seq` are rejected as malformed
    - Only protocol version v1 is supported; malformed or incompatible frames SHALL be discarded silently
    - _Requirements: 10.4, 15.8_

  - [ ]* 2.2 Write property test for binary frame format round-trip
    - **Property 7: Binary video frame format round-trip**
    - **Validates: Requirements 10.4**

  - [ ] 2.3 Implement `src/frame-queue.ts`
    - Bounded queue with configurable max size (default 20)
    - `enqueue()` drops oldest frame when full, increments `framesDroppedByBackpressure` — prioritizes freshness over continuity
    - `dequeue()` returns next frame or null
    - `clear()` and `size` getter
    - O(1) enqueue regardless of queue state (no latency increase under overflow)
    - _Requirements: 2.3, 12.1, 15.1, 15.2, 15.4_

  - [ ] 2.4 Implement `src/frame-sampler.ts`
    - `shouldSample(timestamp)` returns true if enough time has elapsed since last sample
    - Interval computed as `1 / frameRate` seconds
    - `reset()` clears state
    - Support adaptive mode: `setRate(newRate)` for runtime rate changes
    - _Requirements: 2.3, 2.9, 15.5_

  - [ ]* 2.5 Write property test for frame sampler rate
    - **Property 6: Frame sampler selects at configured rate**
    - **Validates: Requirements 2.3**

- [ ] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Video processor core
  - [ ] 4.1 Implement `src/video-processor.ts` — core structure
    - `VideoProcessor` class with constructor, `enqueueFrame()`, `startDrainLoop()`, `stop()`, `finalize()`, `getStatus()`
    - Dependency injection for `faceDetector` and `poseDetector` (interfaces, not concrete implementations)
    - Internal accumulation state for gaze, gestures, body stability, facial energy
    - Stale frame rejection BEFORE enqueue: reject timestamp regression (non-monotonic) and jumps >2s
    - Seq monotonicity check: frames with non-increasing seq (seq ≤ last processed seq) SHALL be dropped and counted in `framesDroppedByTimestamp` — prevents "timestamp-correct but reordered" frames from corrupting gesture deltas and EMA smoothing
    - Malformed frame check uses explicit type checks (not falsy): `typeof header.timestamp !== "number" || header.timestamp < 0`, `typeof header.seq !== "number" || !Number.isInteger(header.seq) || header.seq < 0`, `jpegBuffer.length === 0`
    - Track `framesDroppedByTimestamp` counter, `framesDroppedByFinalizationBudget` counter, `resolutionChangeCount` counter
    - Compute and store `videoProcessingVersion` tuple: `{ tfjsVersion, tfjsBackend, modelVersions, configHash }`
    - Adaptive sampling with hysteresis: overload threshold 20%, recovery threshold 10%, 3-second cooldown. Backpressure ratio computed from `framesDroppedByBackpressure / (framesReceived - framesDroppedByTimestamp)` — only frames that entered the queue count
    - Finalization with latency budget (3s hard max): drain remaining queue within budget, count remaining frames as `framesDroppedByFinalizationBudget` (not reused from backpressure counter), then compute aggregates
    - Frame processing: call detectors, extract keypoints, dispose tensor, accumulate
    - Confidence gating: only include frames where detection confidence meets thresholds (face ≥ 0.5, pose ≥ 0.3)
    - Per-metric reliability flags: set to false when insufficient valid frames exist OR per-metric coverage falls below threshold (gaze 0.6, facial 0.4, gesture 0.3, stability 0.6)
    - Frame retention monitoring: track retention rate in rolling 5s windows, suppress gesturePerSentenceRatio when below threshold
    - Error handling: catch per-frame errors, increment `framesErrored`, continue
    - Compute `videoQualityGrade` in finalize using `framesAnalyzed / expectedSampleCount` plus face detection rate: "good" (≥80% AND face ≥60% AND no drop), "degraded" (50-79% OR drop recovered OR face 30-59%), "poor" (<50% OR face <30%). Per-metric reliability flags independently gate each metric regardless of overall grade
    - Derive `videoQualityWarning` from `videoQualityGrade !== "good"` — NOT stored independently
    - All metrics rounded to 4 decimal places for determinism
    - Resolution change handling: increment `resolutionChangeCount`, reset normalization baselines and EMA, continue aggregates
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 12.1, 12.5, 14.1, 14.2, 15.5, 15.6, 16.2, 16.3, 16.4, 16.5, 16.6, 17.1, 17.2, 18.1, 18.2, 18.4, 19.1, 19.2, 19.3, 19.5_

  - [ ] 4.2 Implement gaze classification logic in VideoProcessor
    - `classifyGaze(faceLandmarks, yawThreshold, pitchThreshold, ...)` function
    - Head pose estimation from BlazeFace 6-landmark geometry (yaw from ear ratios, pitch from nose-eye-mouth ratios)
    - 3-frame EMA smoothing on yaw/pitch to reduce landmark jitter
    - Time-based EMA reset: reset when face detection fails for more than 1 second of elapsed time (not fixed frame count)
    - Confidence gating: require face detection confidence ≥ threshold
    - Minimum face bounding box size check (5% of frame area); below threshold → "other"
    - Accumulate into `gazeClassifications` array
    - Handle face-not-detected → "other" + increment `faceNotDetectedCount`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7_

  - [ ]* 4.3 Write property tests for gaze classification
    - **Property 8: Gaze classification produces valid categories**
    - **Property 31: Gaze EMA smoothing reduces classification flicker**
    - **Validates: Requirements 3.1, 3.6**

  - [ ]* 4.4 Write property test for gaze percentage invariant
    - **Property 9: Gaze percentages sum to 100% and account for all frames**
    - **Validates: Requirements 3.2, 3.3, 3.4**

  - [ ] 4.5 Implement gesture detection logic in VideoProcessor
    - `detectGesture(currentHandKeypoints, previousHandKeypoints, bodyBboxHeight, threshold)` function
    - Normalize displacement by body bounding box height
    - Jitter guard: require both current AND previous frame hand keypoints detected (no gesture from isolated detection after hands-not-detected)
    - Track gesture events with timestamps
    - Compute `gesturePerSentenceRatio` in `finalize()` using transcript segment boundaries (post-final transcript only)
    - Set `gesturePerSentenceRatio` to null when frame retention is below threshold
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 16.6_

  - [ ]* 4.6 Write property tests for gesture detection
    - **Property 10: Gesture detection respects displacement threshold**
    - **Property 32: Gesture jitter guard prevents false positives**
    - **Validates: Requirements 4.1, 4.6**

  - [ ]* 4.7 Write property tests for gesture metrics consistency
    - **Property 11: Gesture frequency is consistent with count and duration**
    - **Property 12: Hand detection frame counts are consistent**
    - **Property 13: Gesture per sentence ratio is bounded and consistent**
    - **Validates: Requirements 4.3, 4.4, 4.5**

  - [ ] 4.8 Implement body stability and stage crossing logic in VideoProcessor
    - Track body center-of-mass history (normalized by frame dimensions)
    - Compute Body_Stability_Score over 5-second rolling windows
    - Detect Stage_Crossings (>25% frame width displacement between windows)
    - Compute movement classification from mean score
    - Exclude windows with insufficient valid frames from aggregates
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 19.2_

  - [ ]* 4.9 Write property tests for body stability
    - **Property 14: Body stability score range and movement classification**
    - **Property 15: Stage crossing detection respects threshold**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ]* 4.10 Write property test for distance normalization invariance
    - **Property 16: Distance normalization is resolution-invariant**
    - **Validates: Requirements 5.4**

  - [ ] 4.11 Implement facial energy computation in VideoProcessor
    - Compute per-frame facial landmark deltas (mouth, eyebrow, head tilt)
    - Per-session min-max normalization in `finalize()` — only across face-detected frames
    - Low-signal detection: if variance < epsilon, set mean to 0.0, variation to 0.0, flag `facialEnergyLowSignal`
    - Compute mean and coefficient of variation
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 4.12 Write property tests for facial energy normalization
    - **Property 17: Facial energy min-max normalization**
    - **Property 40: Facial energy low-signal detection**
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 4.13 Write property test for video processing resilience
    - **Property 24: Video processing resilience — errors don't halt processing**
    - **Validates: Requirements 12.1, 12.3**

  - [ ] 4.14 Write property test for stale frame rejection and timestamp validation
    - **Property 26: Stale frame rejection preserves temporal integrity**
    - **Property 33: Monotonic frame sequence**
    - **Validates: Requirements 16.2, 16.4, 16.5**

  - [ ]* 4.15 Write property test for adaptive sampling with hysteresis
    - **Property 27: Adaptive sampling activates under sustained overload with hysteresis**
    - Verify overload threshold (20%), recovery threshold (10%), 3-second cooldown
    - Verify no oscillation under fluctuating load
    - **Validates: Requirements 15.5**

  - [ ]* 4.16 Write property test for finalization latency budget
    - **Property 28: Finalization completes within latency budget**
    - **Validates: Requirements 14.1, 14.2**

  - [ ]* 4.17 Write property test for video quality grading
    - **Property 29: Video quality grading is deterministic**
    - Verify `videoQualityWarning` is derived from `videoQualityGrade !== "good"`
    - Verify face detection rate thresholds (≥60% for good, 30-59% for degraded, <30% for poor)
    - Verify per-metric reliability flags independently gate metrics regardless of overall grade
    - **Validates: Requirements 17.1, 17.2**

  - [ ]* 4.18 Write property test for resolution change handling
    - **Property 39: Resolution change preserves aggregates**
    - **Validates: Requirements 16.3**

  - [ ]* 4.19 Write property test for frame retention metric bias
    - **Property 37: Frame retention metric bias safeguard**
    - **Validates: Requirements 15.6, 19.2**

- [ ] 5. Basic UI frame streaming and pipeline correctness validation
  - [ ] 5.1 Add basic video frame streaming to `public/index.html` (mock detectors OK)
    - Camera acquisition via `getUserMedia`, video preview
    - Frame capture at 5 FPS client cap, encode with TM-prefixed wire format (`[0x54 0x4D][0x56][header len][header JSON][JPEG bytes]`)
    - Backpressure guard: skip frame if `ws.bufferedAmount > 2MB`
    - Use `performance.now()` relative to recording start for timestamps (shared time base with audio)
    - This validates real camera behavior, surfaces timestamp drift, reveals real-world jitter, finds CPU contention early
    - _Requirements: 2.1, 2.2, 16.1_

  - [ ] 5.2 Ensure all pipeline tests pass
    - Run all property and unit tests for tasks 1-4
    - Fix any failures before proceeding to integration

  - [ ] 5.3 Write determinism test for VideoProcessor
    - Given identical frame sequence + transcript → identical VisualObservations output
    - Verify metric values are bitwise identical across 3 runs (with 4-decimal rounding)
    - Verify no non-deterministic TF.js operations used
    - Determinism requires: single-threaded drain loop (already in design), deterministic ordering of frame processing (queue order), no parallel inference per frame
    - Determinism is scoped to same runtime + backend + model version (per Req 18.4)
    - **Property 34: Deterministic visual observations**
    - _Requirements: 18.1, 18.2, 18.3, 18.4_

  - [ ] 5.4 Write memory safety test for VideoProcessor
    - Verify tensor disposal: no TF.js tensors leaked after `finalize()` or `stop()`
    - Verify frame queue is empty after `stop()`, `finalize()`, `panicMute()`, and `revokeConsent()`
    - Verify no retained JPEG buffers after processing
    - Native memory snapshot test: heap delta after `finalize()` = 0
    - Test tfjs native backend buffer retention and JPEG decode buffer leaks
    - **Property 35: Memory safety — no tensor or buffer leaks**
    - _Requirements: 2.5, 11.1_

  - [ ] 5.5 Write temporal integrity tests
    - Test frame reordering: out-of-order timestamps handled correctly (dropped before enqueue)
    - Test timestamp regression: frames with timestamp ≤ last processed are dropped
    - Test timestamp jumps >2s: frames are dropped and counted
    - Test camera pause/resume: gap in frames doesn't produce false gestures or crossings
    - Test resolution change mid-session: baselines reset, EMA reset, aggregates preserved
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [ ] 5.6 Statistical stability test gate
    - Run randomized motion patterns through VideoProcessor
    - Verify: gesture false positives < 5% (random noise should not trigger gestures)
    - Verify: stage crossing false positives < 5% (small movements should not trigger crossings)
    - Verify: gaze classification variance within ±2% across repeated runs with same input
    - This gate must pass before proceeding to session integration
    - _Requirements: 4.1, 5.2, 3.1, 18.1_

- [ ] 6. Checkpoint — Ensure all tests pass including statistical stability
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Session manager integration
  - [ ] 7.1 Extend SessionManager with video lifecycle methods
    - Add `setVideoConsent()`, `setVideoStreamReady()`, `setVideoConfig()` — all IDLE-only
    - Add `feedVideoFrame()` with fire-and-forget guard (enqueue, no await)
    - Add `videoProcessorFactory` to `SessionManagerDeps`
    - Add `videoProcessors: Map<string, VideoProcessor>` private field
    - _Requirements: 1.3, 1.4, 1.9, 2.9, 10.6, 10.7_

  - [ ] 7.2 Modify SessionManager recording lifecycle for video
    - `createSession()`: initialize video fields with defaults
    - `startRecording()`: create VideoProcessor if consent + stream ready, else audio-only with warning
    - `stopRecording()`: finalize VideoProcessor (respects latency budget), attach visualMetrics to DeliveryMetrics, derive `videoQualityWarning` from grade (`!== "good"`)
    - `panicMute()`: stop and remove VideoProcessor, clear frame queue
    - `revokeConsent()`: stop and remove VideoProcessor, clear frame queue, purge visual data, reset videoConsent and videoStreamReady
    - `generateEvaluation()`: pass visualObservations to EvaluationGenerator; suppress visual feedback when `videoQualityGrade === "poor"`; skip unreliable metrics
    - Extend existing `purgeSessionData()` (auto-purge timer path) to clear visualObservations, reset videoConsent to null, reset videoStreamReady to false
    - _Requirements: 1.6, 1.7, 2.6, 2.7, 9.2, 11.4, 11.5, 17.3_

  - [ ]* 7.3 Write property test for IDLE-only mutability
    - **Property 2: IDLE-only mutability for video settings**
    - **Validates: Requirements 1.4, 2.9**

  - [ ]* 7.4 Write property test for opt-out purge
    - **Property 3: Opt-out purges visual observations**
    - **Validates: Requirements 1.7**

  - [ ]* 7.5 Write property test for video frame guard
    - **Property 5: Video frame guard — no processing without consent and RECORDING state**
    - **Validates: Requirements 1.9, 10.6, 10.7**

  - [ ]* 7.6 Write property test for no visual metrics without video
    - **Property 23: No visual metrics without video**
    - **Validates: Requirements 9.3**

- [ ] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Tone checker safety guardrails
  - [ ] 9.1 Add visual safety violation categories to ToneChecker
    - Add `visual_emotion_inference` patterns (emotion, intent, psychological state from visual data)
    - Add `visual_judgment` patterns (subjective quality judgments about visual delivery)
    - Add `hasMetricAnchoredNumber()` helper: require a recognized visual metric key from the VisualObservations schema AND a numeric value (not just any digit or metric-sounding word)
    - Add `validateMetricKeyExists()` helper: validate that `observation_data` references an actual metric field present in the VisualObservations structure; references to non-existent metric fields are treated as `visual_scope` violations
    - Pre-render validation: cited value validated against actual metric within ±1% tolerance — this is safety-critical and MUST NOT be skipped
    - Update `visual_scope` check to be context-dependent: when `hasVideo` is true, permit visual terms only with metric-anchored numbers; when false, existing behavior
    - Update `check()` signature to accept `options?: { hasVideo?: boolean }`
    - Update `appendScopeAcknowledgment()` to accept `options?: { hasVideo?: boolean }`
    - Add `ToneViolation.category` union members: `"visual_emotion_inference" | "visual_judgment"`
    - _Requirements: 6.5, 7.1, 7.2, 7.5, 7.6, 7.7, 13.1, 13.2, 13.3_

  - [ ]* 9.2 Write property test for visual emotion inference detection
    - **Property 18: Tone checker flags visual emotion inference and intent attribution**
    - **Validates: Requirements 6.5, 7.1**

  - [ ]* 9.3 Write property test for visual judgment detection
    - **Property 19: Tone checker flags visual judgment without metric-anchored measurement**
    - **Validates: Requirements 7.2**

  - [ ]* 9.4 Write property test for context-dependent visual scope
    - **Property 20: Context-dependent visual scope enforcement with metric-anchored numbers**
    - **Validates: Requirements 7.5, 7.7**

  - [ ]* 9.5 Write property test for scope acknowledgment
    - **Property 25: Scope acknowledgment matches video availability**
    - **Validates: Requirements 13.1, 13.2, 13.3**

- [ ] 10. Evaluation generator integration
  - [ ] 10.1 Extend EvaluationGenerator for visual feedback
    - Modify `generate()` to accept optional `visualObservations` parameter
    - Modify `buildUserPrompt()` to include Visual Observations section when available and grade !== "poor"
    - Exclude unreliable metrics from prompt (check per-metric reliability flags)
    - Modify `buildSystemPrompt()` to include `visual_feedback` in JSON schema when available
    - Modify `parseEvaluation()` to parse optional `visual_feedback` array
    - Modify `renderScript()` with over-stripping fallback: if all visual_feedback items stripped, remove visual section entirely (no orphaned transition sentence)
    - Add video quality grade handling: suppress visual feedback for "poor", add uncertainty for "degraded"
    - Add `validateObservationData()` — verify each visual_feedback item's observation_data references real metric names and values within ±1% of actual
    - Ensure prompt is byte-identical to Phase 3 when visualObservations is null (no prompt drift)
      - Byte-identical means character-for-character identical system prompt, user prompt, and JSON schema — verified by SHA-256 hash comparison. No whitespace normalization allowed.
      - Only internal logs, video pipeline state fields, and operational diagnostics may differ between Phase 3 and Phase 4 audio-only output
    - _Requirements: 7.8, 7.9, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 12.4, 17.3, 17.4, 19.4_

  - [ ]* 10.2 Write property test for no visual feedback without observations
    - **Property 4: No visual feedback without video observations**
    - **Validates: Requirements 1.8, 8.4**

  - [ ]* 10.3 Write property test for visual feedback item structure
    - **Property 21: Visual feedback item structural validity**
    - **Validates: Requirements 8.3**

  - [ ]* 10.4 Write property test for script rendering order
    - **Property 22: Script rendering order — visual feedback between items and closing**
    - **Validates: Requirements 8.5**

  - [ ] 10.5 Write property test for observation data validation
    - **Property 30: Observation data validation catches fabricated metrics**
    - Safety-critical: prevents LLM from fabricating numbers in visual feedback
    - **Validates: Requirements 7.8**

  - [ ]* 10.6 Write property test for metric reliability gating
    - **Property 36: Metric reliability gating**
    - **Validates: Requirements 19.3, 19.4**

  - [ ]* 10.7 Write property test for over-stripping fallback
    - **Property 38: Over-stripping fallback removes visual section entirely**
    - **Validates: Requirements 7.9**

  - [ ] 10.8 Implement `validateObservationData()` function and tests
    - Implement the `validateObservationData(item: VisualFeedbackItem, observations: VisualObservations): boolean` function
    - Parse `observation_data` against the formal grammar
    - Validate metric names against the enumerated allowlist derived from VisualObservations type
    - Validate cited numeric values within ±1% of actual metric values
    - ±1% uses relative error: `|cited - actual| / |actual| <= 0.01`; for actual=0, cited must be exactly 0. Compare against stored rounded value (4 decimal places)
    - Write unit tests: valid observation_data passes, invalid metric names fail, wrong numbers fail, malformed grammar fails
    - Write property test: random observation_data strings fail unless well-formed and referencing real metrics with correct values
    - _Requirements: 7.8, 8.3_

- [ ] 11. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Server wiring and WebSocket protocol
  - [ ] 12.1 Add video message handlers to `src/server.ts`
    - Handle `set_video_consent`: validate IDLE state, parse ISO timestamp, store on session
    - Handle `video_stream_ready`: validate IDLE state, mark session ready
    - Handle `set_video_config`: validate IDLE state, validate frameRate in [1, 5]
    - Route binary messages: check TM magic prefix `0x54 0x4D` then type byte `0x56` for video frames, `0x41` for audio frames — server uses type byte for demux, no heuristics. Frames without TM prefix are silently discarded
    - Video frames: parse with `decodeVideoFrame()`, call `feedVideoFrame()` (fire-and-forget, no await) — stale rejection happens in VideoProcessor before enqueue
    - Audio frames: parse with `decodeAudioFrame()`, call `feedAudio()` — always processed synchronously
    - Add periodic `video_status` sender (≤1/sec during RECORDING)
    - Include in `video_status` messages: `framesReceived`, `framesSkippedBySampler`, `framesDroppedByBackpressure`, `framesDroppedByTimestamp`, `framesErrored`, `effectiveSamplingRate` (after adaptive sampling) — sufficient for debugging overload mode and validating Requirement 15/16 behavior during real sessions
    - On `stop_recording`, send one final `video_status` containing final counters + `finalizationLatencyMs` + `videoQualityGrade`
    - Pass `hasVideo` flag to ToneChecker `check()` and `appendScopeAcknowledgment()` calls
    - _Requirements: 1.2, 1.5, 1.6, 2.1, 2.9, 10.4, 10.6, 10.7, 10.8, 14.3_

  - [ ]* 12.2 Write unit tests for server video message handling
    - Test binary frame routing (TM magic prefix + type byte demux, no heuristics)
    - Test video consent in non-IDLE state rejection
    - Test video config validation
    - Test video status throttling
    - Test audio priority: verify audio chunk handling is never blocked by video frame processing
    - _Requirements: 10.4, 10.6, 10.7, 10.8_

- [ ] 13. File persistence extension
  - [ ] 13.1 Extend `src/file-persistence.ts` to include visualMetrics
    - Include `visualMetrics` in saved metrics.json when present
    - Include `videoQualityGrade` in output
    - Include per-metric reliability flags in output
    - No separate file — part of existing metrics output
    - Verify no keypoint data, per-frame data, pixel data, frame headers, frame timestamps, frame sequence numbers, or reconstructable motion data leaks into output
    - Only aggregated VisualObservations may survive session lifetime
    - _Requirements: 9.4, 11.2, 11.6_

  - [ ] 13.2 Add privacy non-persistence assertions
    - Write a unit test or grep-based assertion that no log line or persisted file contains `deviceLabel`
    - Write assertions that no per-frame keypoints, frame headers, frame timestamps, frame sequence numbers, or sequence streams are persisted or logged
    - Verify `deviceLabel` is not included in metrics.json, session data, or any log output
    - Verify no per-frame or reconstructable motion data is logged or persisted under any circumstances
    - _Requirements: 11.2, 11.7_

- [ ] 14. Complete frontend video UI
  - [ ] 14.1 Add video consent UI to `public/index.html`
    - Video consent toggle (separate from audio consent, defaults to disabled)
    - Camera acquisition via `getUserMedia` on toggle enable (if not already done in task 5.1)
    - Send `video_stream_ready` on camera success, revert toggle on failure
    - Small video preview thumbnail in IDLE state
    - Video config slider (1-5 FPS) in IDLE state
    - _Requirements: 1.1, 1.2, 1.5, 2.9_

  - [ ] 14.2 Complete video frame streaming in `public/index.html`
    - Ensure frame streaming from task 5.1 is fully wired with consent checks
    - Stop capturing on state change away from RECORDING
    - _Requirements: 2.1, 2.2, 10.4_

  - [ ] 14.3 Implement client-side seq generation and monotonic time base
    - Initialize `{ startPerfNow: performance.now(), seq: 0 }` at recording start
    - For each frame: `timestamp = (performance.now() - startPerfNow) / 1000`, `seq++`
    - Ensure seq resets per session and never decreases within a session
    - Include `seq` in the frame header JSON alongside `timestamp`, `width`, `height`
    - _Requirements: 16.1, 16.2_

  - [ ] 14.4 Add video status display to `public/index.html`
    - Show frames processed / dropped indicator during recording
    - Show video quality grade after evaluation
    - Warning icon if `processingLatencyMs > 500`
    - Handle `video_status` server messages
    - _Requirements: 10.8, 17.1_

- [ ] 15. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Optional high-value improvements
  - [ ]* 16.1 Add confidence score per metric
    - Add `confidenceScores` object to VisualObservations with per-metric confidence values
    - Derive from detection model confidence and frame coverage
    - _Requirements: 21.1_

  - [ ]* 16.2 Add detection coverage percentage
    - Add `detectionCoverage` object to VisualObservations with per-metric coverage percentages
    - _Requirements: 21.2_

  - [ ]* 16.3 Add per-metric suppression in evaluation
    - Modify EvaluationGenerator to suppress individual unreliable metrics rather than entire visual section
    - _Requirements: 21.3_

  - [ ]* 16.4 Add noise-floor auto-calibration for facial energy
    - Compute noise floor during first 3 seconds of recording
    - Subtract from subsequent measurements
    - _Requirements: 21.4_

  - [ ]* 16.5 Add motion dead-zone for body stability
    - Ignore body center-of-mass displacements below configurable threshold (default 2% of frame diagonal)
    - Filter out small posture sway
    - _Requirements: 21.5_

  - [ ]* 16.6 Add camera placement heuristic warning
    - Estimate camera angle from face landmark asymmetry
    - Warn if angle exceeds 30° from frontal
    - _Requirements: 21.6_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP — except safety-critical tests (10.5) which are non-optional
- Each task references specific requirements for traceability (format: Requirement X.Y = Acceptance Criterion Y of Requirement X)
- Checkpoints ensure incremental validation
- Basic UI frame streaming (task 5.1) is moved early to validate real camera behavior before full integration
- Statistical stability gate (task 5.6) must pass before session integration — prevents integrating a statistically unreliable pipeline
- Pipeline correctness is validated (task 5) BEFORE session integration (task 7) — this prevents integrating an unvalidated pipeline
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The audio pipeline is never modified in a breaking way — all changes are additive
- TensorFlow.js model loading and warmup are handled in the VideoProcessor constructor; mock detectors are used in tests
- Debug/error logs contain only aggregate counters — no pixel data, keypoint coordinates, or frame content
- `videoQualityWarning` is always derived from `videoQualityGrade` — never stored independently, never separately computed
- Video quality grading uses "good" / "degraded" / "poor" with deterministic thresholds including face detection rate
- Per-metric reliability flags independently gate each metric regardless of overall video quality grade
- All floating-point metrics rounded to 4 decimal places for determinism (scoped to same runtime + backend + model version)
- Stale frame rejection happens BEFORE enqueue, not after — prevents stale frames from consuming queue capacity
- Seq monotonicity is checked alongside timestamp monotonicity — prevents reordered frames from corrupting deltas
- EMA reset is time-based (>1 second without face), not frame-count-based
- Adaptive sampling uses hysteresis (20% overload / 10% recovery / 3s cooldown) to prevent oscillation; backpressure ratio excludes timestamp-dropped frames
- `framesDroppedByFinalizationBudget` is a separate counter from `framesDroppedByBackpressure` for observability
- `deviceLabel` in `video_stream_ready` is optional and SHALL NOT be persisted or logged
- No per-frame keypoints, frame headers, frame timestamps, frame sequence numbers, sequence streams, or reconstructable motion data SHALL be persisted or logged
- Only aggregated VisualObservations may survive session lifetime
- `videoProcessingVersion` tuple is logged in-memory and allowed in metrics JSON for reproducibility
- Per-metric coverage thresholds (gaze 0.6, facial 0.4, gesture 0.3, stability 0.6) account for naturally sparse metrics
- Task 4.14 (stale frame rejection PBT) is promoted to non-optional — it protects temporal integrity which is safety-critical for cross-modal alignment
- Task 10.8 (observation data validation) is non-optional — it is the primary defense against fabricated numbers in visual feedback
- Task 13.2 (privacy non-persistence assertions) is non-optional — it enforces the privacy requirement that hardware identifiers and per-frame data are never stored
- All binary WebSocket messages use the canonical TM-prefixed envelope (`[0x54 0x4D][type][header len][header JSON][payload]`) — no alternative formats, no raw PCM, no heuristic demux
- Only protocol version v1 is supported; malformed or incompatible frames are discarded silently
