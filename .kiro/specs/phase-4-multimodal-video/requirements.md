# Requirements Document

## Introduction

Phase 4 — Multimodal (Video / Delivery Coaching) extends the AI Toastmasters Evaluator with visual observation capabilities. By adding camera input and a video processing pipeline that runs parallel to the existing audio pipeline, the system can provide richer, more human-like evaluations that include non-verbal communication feedback. All visual observations are strictly observational and quantitative — the system never infers psychology, emotion, or intent from visual signals. Video frames are processed in real-time and immediately discarded; no video data is stored.

## Glossary

- **Operator**: The person controlling the system during a Toastmasters meeting via the Web_UI
- **Speaker**: The Toastmasters club member delivering a speech being evaluated
- **Session**: A single end-to-end workflow covering one speech, from starting audio capture through delivering the evaluation
- **Web_UI**: The browser-based control interface used by the Operator to manage a Session
- **Session_Manager**: The server-side component that manages session state, transcription, metrics extraction, evaluation generation, and TTS synthesis
- **Evaluation_Generator**: The component that produces the Evaluation from the Transcript, Delivery_Metrics, and Visual_Observations using an LLM
- **Tone_Checker**: The deterministic rule-based component that validates evaluation scripts against prohibited content patterns
- **Video_Processor**: The server-side component that receives video frames, runs face/body detection, and extracts Visual_Observations
- **Frame_Sampler**: The sub-component of Video_Processor responsible for selecting frames at a configured sampling rate rather than processing every incoming frame
- **Visual_Observations**: A structured data object containing quantitative, binary-verifiable measurements derived from video frames (e.g., gaze direction percentages, gesture counts, movement distances). This is the aggregate statistical output — no raw frame data
- **Video_Consent**: An explicit consent record for video capture, separate from the existing audio Consent_Record, containing consent status and timestamp
- **Gaze_Direction**: A classification of the Speaker's head pose orientation relative to the camera as "audience-facing" (yaw within ±15° of camera), "notes-facing" (pitch below -20° from horizontal), or "other" (all remaining orientations including face-not-detected)
- **Gesture_Event**: A detected instance of the Speaker using hand or arm movement where hand keypoint displacement exceeds 15% of body bounding box height between consecutive sampled frames
- **Body_Stability_Score**: A normalized measure (0.0–1.0) of how much the Speaker's body center-of-mass moves over a 5-second rolling window, computed as 1.0 minus the normalized displacement (displacement / frame_diagonal), clamped to [0.0, 1.0]
- **Stage_Crossing**: A detected event where the Speaker's body center-of-mass moves more than 25% of the frame width between consecutive rolling windows
- **Facial_Energy_Score**: A normalized measure (0.0–1.0) of facial landmark movement intensity (mouth openness delta, eyebrow displacement delta, head tilt variation) per session, where 0.0 is the minimum observed movement and 1.0 is the maximum observed movement within that session. No emotion inference
- **Delivery_Metrics**: A structured JSON object containing measurements of speech delivery (WPM, filler words, duration, pauses, energy variation, pause classification) — extended in Phase 4 with an optional `visualMetrics` field
- **Consent_Record**: A metadata object capturing the Speaker's name and consent status for the current Session (audio consent)
- **Binary_Verifiable_Statement**: An evaluation claim that references a specific numeric measurement and a defined threshold, such that a reviewer can confirm or deny the claim by checking the measurement against the threshold (e.g., "I observed that you faced the audience for 65% of the speech, which is below the 80% target")
- **Video_Stream_Handshake**: A protocol exchange where the client sends a `video_stream_ready` message after successfully acquiring camera access via `getUserMedia`, confirming to the server that video frames will follow
- **Video_Quality_Grade**: A graded assessment of video data sufficiency: "good" (≥80% of expected samples analyzed AND face detected ≥60% of analyzed frames AND no camera drop), "degraded" (50-79% of expected samples analyzed OR camera drop recovered OR face detected 30-59% of analyzed frames), or "poor" (<50% of expected samples analyzed OR face detected <30% of analyzed frames). `expectedSampleCount = durationSeconds * effectiveSamplingRate` (configured rate adjusted by adaptive sampling). The legacy `videoQualityWarning` boolean is derived as `videoQualityGrade !== "good"` — it is NOT stored independently, NOT separately computed
- **Frame_Retention_Rate**: The percentage of received frames that were successfully analyzed (not dropped by backpressure, sampling, or errors) within a rolling time window, used to assess metric reliability
- **Metric_Reliability**: A classification of whether computed visual metrics are statistically trustworthy based on frame retention rate and detection confidence within the measurement window

## Frame Counter Definitions

> These counter definitions are normative. All quality computations, ratio calculations, and test assertions SHALL use these definitions consistently.

| Counter | Definition | Includes | Excludes |
|---------|-----------|----------|----------|
| `framesReceived` | All frames that passed basic wire-format validation (TM magic prefix present, type byte valid, header JSON parseable) | Timestamp-rejected frames, backpressure-dropped frames, sampler-skipped frames, analyzed frames, errored frames | Frames that failed wire-format parsing (no TM magic prefix, invalid type byte, corrupt header) |
| `framesDroppedByTimestamp` | Frames rejected due to timestamp regression, seq regression, or timestamp jump >2s | — | Not counted in backpressure ratio denominator |
| `framesEnqueued` | Frames that entered the FrameQueue (= `framesReceived - framesDroppedByTimestamp`) | — | Used as backpressure ratio denominator |
| `framesDroppedByBackpressure` | Frames dropped because FrameQueue was full at enqueue time | — | Subset of `framesEnqueued` |
| `framesSkippedBySampler` | Frames dequeued but not selected by FrameSampler (outside sampling interval) | — | — |
| `framesAnalyzed` | Frames that completed the full inference pipeline (decode + detect + accumulate) | — | — |
| `framesErrored` | Frames that entered processing but failed (decode error, inference error, timeout) | — | — |
| `framesDroppedByFinalizationBudget` | Frames remaining in queue when finalization budget expired | — | Separate from `framesDroppedByBackpressure` |

**Key ratio definitions:**
- **Backpressure ratio**: `framesDroppedByBackpressure / framesEnqueued` (where `framesEnqueued = framesReceived - framesDroppedByTimestamp`)
- **Frame retention rate** (per 5s window): `framesAnalyzed / (framesAnalyzed + framesErrored + framesDroppedByBackpressure)` within the window
- **Video quality denominator**: `expectedSampleCount = durationSeconds * effectiveSamplingRate`

## Requirements

> **Numbering convention:** Each requirement is numbered (e.g., Requirement 1, Requirement 2). Acceptance criteria within each requirement are numbered sequentially (e.g., 1.1, 1.2, ..., 2.1, 2.2). Cross-references in the design and tasks documents use the format `Requirement X.Y` to refer to Acceptance Criterion Y of Requirement X.

### Requirement 1: Video Consent and Camera Handshake

**User Story:** As an Operator, I want to obtain explicit video consent from the Speaker separately from audio consent and confirm camera availability before recording, so that the Speaker has granular control and the system does not start in a broken video state.

#### Acceptance Criteria

1. WHEN the Session is in IDLE state, THE Web_UI SHALL display a video consent toggle separate from the existing audio consent controls, defaulting to disabled
2. WHEN the Operator enables video consent, THE Web_UI SHALL send a `set_video_consent` message to the Server containing the consent status and a timestamp
3. THE Session_Manager SHALL store the Video_Consent on the Session as a field independent from the existing Consent_Record
4. WHEN recording starts, THE Video_Consent SHALL become immutable for that Session, consistent with the Consent_Record immutability rule; attempts to call `set_video_consent`, `set_video_config`, or `video_stream_ready` while the Session is not in IDLE state SHALL be rejected with a recoverable error and SHALL NOT modify any session fields
5. WHEN the Operator enables video consent, THE Web_UI SHALL attempt to acquire camera access via `getUserMedia` and, upon success, send a `video_stream_ready` message to the Server; upon failure, THE Web_UI SHALL display an error and revert the video consent toggle to disabled
6. IF the Operator starts recording with video consent enabled but the Server has not received a `video_stream_ready` message, THEN THE Server SHALL start recording in audio-only mode and send a recoverable error message indicating video is unavailable
7. WHEN the Speaker opts out (consent revocation), THE Session_Manager SHALL purge all Visual_Observations as part of the full session data purge
8. THE system SHALL function without video consent, producing an audio-only evaluation identical to Phase 3 behavior — meaning the LLM prompt MUST be byte-identical to Phase 3 prompt (verified via SHA-256 prompt hash equality), the JSON schema MUST be unchanged (no `visual_feedback` key), the output MUST contain no `visual_feedback` section, and the scope acknowledgment text MUST remain "This evaluation is based on audio content only." The only permitted differences are internal diagnostic logs, video pipeline state fields, and operational metadata — no user-facing output may differ
9. WHEN video consent is not granted, THE Video_Processor SHALL NOT be started and no video frames SHALL be captured or processed

### Requirement 2: Video Capture and Frame Sampling

**User Story:** As a developer, I want a video processing pipeline that captures camera frames at a configurable sampling rate, so that the system can extract visual signals efficiently without continuous video analysis.

#### Acceptance Criteria

1. WHEN recording starts with Video_Consent granted and a `video_stream_ready` handshake received, THE Video_Processor SHALL begin receiving video frames from the client
2. THE client SHALL send video frames as binary WebSocket messages using the canonical TM-prefixed framing format: `[0x54 0x4D magic bytes ("TM")][0x56 type byte (video)][3-byte big-endian uint24 header JSON length][UTF-8 header JSON with `timestamp`, `seq`, `width`, `height` fields][JPEG bytes]`. Audio frames SHALL use the same envelope: `[0x54 0x4D magic bytes ("TM")][0x41 type byte (audio)][3-byte big-endian uint24 header JSON length][UTF-8 header JSON][PCM bytes]`. The 2-byte magic prefix distinguishes typed binary frames from legacy raw data on the shared WebSocket connection. Only protocol version v1 is supported; malformed or incompatible frames SHALL be discarded silently
3. THE Frame_Sampler SHALL select frames at a server-configurable rate (default: 2 frames per second) by accepting the first frame in each sampling interval and discarding the rest
4. THE Video_Processor SHALL process selected frames through a face/body detection model to extract raw spatial data (face bounding box, body keypoints, hand keypoints)
5. THE Video_Processor SHALL dereference each frame's pixel buffer immediately after extracting keypoints; no frame pixel data, JPEG bytes, or base64 representations SHALL be retained beyond the current sampling interval. Frames awaiting processing SHALL be held only in the bounded FrameQueue; when the queue is full, the oldest frame SHALL be dropped to prevent unbounded memory growth
6. WHEN recording stops, THE Video_Processor SHALL stop accepting frames and finalize the Visual_Observations aggregate
7. WHEN panic mute is triggered, THE Video_Processor SHALL stop immediately and discard any in-progress frame analysis
8. THE Video_Processor SHALL operate on a separate processing path from the audio pipeline so that video processing latency does not delay audio transcription or evaluation generation
9. THE Frame_Sampler rate SHALL be configurable via a `set_video_config` client message (range: 1–5 FPS, default: 2 FPS), settable only while the Session is in IDLE state

### Requirement 3: Gaze Direction Tracking

**User Story:** As an Operator, I want the system to track where the Speaker is looking during the speech, so that the evaluation can include quantitative observations about audience engagement.

#### Acceptance Criteria

1. FOR EACH sampled frame where a face is detected, THE Video_Processor SHALL estimate head pose (yaw and pitch angles) and classify the Speaker's Gaze_Direction as: "audience-facing" (yaw within ±15° of camera-facing), "notes-facing" (pitch below -20° from horizontal), or "other" (all remaining orientations)
2. THE Video_Processor SHALL aggregate Gaze_Direction classifications into a percentage breakdown over the full speech duration (e.g., "audience-facing: 65%, notes-facing: 25%, other: 10%"), where percentages sum to 100% of analyzed frames
3. THE Visual_Observations SHALL include the Gaze_Direction percentage breakdown, the total number of frames analyzed, and the number of frames where face detection failed (a subset of "other")
4. IF the Speaker's face is not detected in a sampled frame, THEN THE Video_Processor SHALL classify that frame as "other" and increment a `faceNotDetectedCount` counter
5. THE system SHALL document the limitation that Gaze_Direction tracks head pose, not eye gaze, and that accuracy depends on camera placement relative to the Speaker's typical audience-facing direction
6. THE Video_Processor SHALL apply a 3-frame exponential moving average (EMA) smoothing filter to yaw and pitch estimates before classification, to reduce frame-to-frame noise from landmark jitter. The smoothing window resets when face detection fails for more than 1 second of elapsed time (not a fixed frame count), to avoid stale smoothing state biasing recovery at variable frame rates
7. THE Video_Processor SHALL require a minimum face bounding box size of 5% of frame area for gaze classification; faces below this threshold SHALL be classified as "other" (too small for reliable pose estimation)

### Requirement 4: Gesture Detection

**User Story:** As an Operator, I want the system to count and categorize the Speaker's gestures, so that the evaluation can include observations about non-verbal expressiveness.

#### Acceptance Criteria

1. THE Video_Processor SHALL detect Gesture_Events by computing hand keypoint displacement between consecutive sampled frames, normalized by body bounding box height; a displacement exceeding 15% of body bounding box height constitutes a Gesture_Event
2. THE Video_Processor SHALL count the total number of Gesture_Events detected during the speech
3. THE Video_Processor SHALL compute a gesture frequency metric as gestures per minute of speech duration
4. THE Visual_Observations SHALL include the total gesture count, gesture frequency, the number of frames where hands were detected, and the number of frames where hands were not detected
5. THE Video_Processor SHALL compute a `gesturePerSentenceRatio` by aligning Gesture_Events (via their timestamps) with transcript sentence boundaries (derived from TranscriptSegment timestamps) and reporting the fraction of sentences during which at least one Gesture_Event occurred
6. THE Video_Processor SHALL require a minimum displacement duration: a Gesture_Event is only registered if the displacement threshold is exceeded in the current frame AND the previous frame's hand keypoints were detected (i.e., no gesture from a single isolated detection after hands-not-detected frames)

### Requirement 5: Body Stability and Stage Presence

**User Story:** As an Operator, I want the system to measure the Speaker's body movement patterns, so that the evaluation can include observations about stage presence and physical composure.

#### Acceptance Criteria

1. THE Video_Processor SHALL compute a Body_Stability_Score by tracking the Speaker's body center-of-mass position (normalized by frame dimensions) across sampled frames over 5-second rolling windows, where the score is 1.0 minus the max normalized displacement within the window, clamped to [0.0, 1.0]
2. THE Video_Processor SHALL detect Stage_Crossings when the body center-of-mass moves more than 25% of the frame width between consecutive rolling windows
3. THE Visual_Observations SHALL include the mean Body_Stability_Score, the number of Stage_Crossings, and a movement classification: "stationary" (mean score ≥ 0.85), "moderate_movement" (mean score 0.5–0.84), or "high_movement" (mean score < 0.5)
4. ALL distance-based measurements SHALL be normalized by frame dimensions (width for horizontal, diagonal for total displacement) so that values are comparable across different camera setups and resolutions

### Requirement 6: Facial Expression Energy

**User Story:** As an Operator, I want the system to measure the Speaker's facial expressiveness without inferring emotions, so that the evaluation can comment on visual engagement energy.

#### Acceptance Criteria

1. THE Video_Processor SHALL compute a Facial_Energy_Score per sampled frame by measuring the magnitude of facial landmark deltas (mouth openness change, eyebrow displacement change, head tilt variation) between consecutive frames where a face is detected
2. THE Facial_Energy_Score SHALL be normalized per session using min-max normalization: 0.0 maps to the minimum observed frame-to-frame delta and 1.0 maps to the maximum observed frame-to-frame delta within that session. Normalization is computed only across frames where a face was detected; frames with no face detection are excluded from the energy calculation. IF the variance of observed deltas is below epsilon (near-zero variation), THEN the mean Facial_Energy_Score SHALL be 0.0, the variation SHALL be 0.0, and the metric SHALL be flagged as "low signal reliability"
3. THE Visual_Observations SHALL include the mean Facial_Energy_Score across the session and a coefficient of variation for facial energy
4. THE Video_Processor SHALL NOT infer or label specific emotions (happy, sad, angry, surprised, confused, disgusted) from facial landmarks; the Facial_Energy_Score measures movement intensity only
5. THE Tone_Checker SHALL flag any evaluation sentence that attributes a specific emotion to facial observations as a `visual_emotion_inference` violation

### Requirement 7: Visual Observation Safety Rules

**User Story:** As a developer, I want strict safety guardrails on all visual observations, so that the system never makes psychological inferences, emotion attributions, intent attributions, or judgmental statements based on video data.

#### Acceptance Criteria

1. THE Tone_Checker SHALL include a new violation category `visual_emotion_inference` that detects sentences attributing emotions, psychological states, or intent to visual observations (e.g., "you looked nervous", "your face showed anxiety", "you seemed uncomfortable", "you were trying to appear confident", "you seemed distracted")
2. THE Tone_Checker SHALL include a new violation category `visual_judgment` that detects sentences making subjective quality judgments about visual delivery without referencing a specific measurement (e.g., "great eye contact", "poor posture", "awkward gestures", "good stage presence")
3. THE Evaluation_Generator LLM prompt SHALL instruct the model to use "I observed..." language for all visual observations and to never infer psychology, emotion, or intent from visual signals
4. THE Evaluation_Generator LLM prompt SHALL instruct the model to frame all visual observations as Binary_Verifiable_Statements: each visual claim MUST reference a specific metric name and its numeric value from Visual_Observations, and MAY include a threshold for context (e.g., "I observed audience-facing gaze at 65%, below the 80% target")
5. THE Tone_Checker SHALL reject any visual observation sentence that does not contain a metric-anchored numeric value when the sentence references visual terms (gaze, gesture, movement, stability, facial energy, stage crossing). A metric-anchored number requires ALL of: (a) a recognized visual metric key from the VisualObservations schema (e.g., `gazeBreakdown.audienceFacing`, `totalGestureCount`), (b) a numeric value tied to that metric, and (c) optionally a threshold reference. The Tone_Checker SHALL validate that the `observation_data` field references an actual metric field present in the VisualObservations structure; references to non-existent metric fields SHALL be treated as `visual_scope` violations. The numeric value SHALL be validated against the actual metric within a tolerance of ±1% before rendering
6. WHEN the Tone_Checker detects a visual safety violation, THE Tone_Checker SHALL strip the violating sentence using the existing `stripViolations` mechanism
7. THE existing `visual_scope` violation category in the Tone_Checker SHALL be updated: WHEN Video_Consent is granted and Visual_Observations are available, visual terms SHALL be permitted only when the sentence also contains a metric-anchored numeric measurement; WHEN Video_Consent is not granted, the existing audio-only scope rules SHALL remain in effect (visual terms are always violations)
8. THE Evaluation_Generator SHALL validate that each `observation_data` field in `visual_feedback` items references a metric name that exists in the Visual_Observations structure and that the numeric value cited is within ±1% of the actual metric value; items failing this validation SHALL be stripped before rendering
9. WHEN all `visual_feedback` items are stripped (by tone checking or observation data validation), THE Evaluation_Generator SHALL remove the visual feedback section entirely from the rendered script, including the transition sentence — no orphaned transition sentences SHALL remain

### Requirement 8: Evaluation Integration — Non-Verbal Feedback Section

**User Story:** As an Operator, I want the evaluation to include a dedicated non-verbal communication section when video data is available, so that the Speaker receives comprehensive delivery coaching.

#### Acceptance Criteria

1. WHEN Visual_Observations are available, THE Evaluation_Generator SHALL include the Visual_Observations data in the LLM prompt alongside the Transcript and Delivery_Metrics
2. WHEN Visual_Observations are available, THE Evaluation_Generator SHALL instruct the LLM to produce a `visual_feedback` array in the StructuredEvaluation containing 1-2 observational items about non-verbal delivery
3. THE `visual_feedback` items SHALL use a `VisualFeedbackItem` structure with fields: `type` ("visual_observation"), `summary` (string), `observation_data` (string following the formal grammar: `metric=<metricName>; value=<number><unit?>; source=visualObservations`), and `explanation` (string, 2-3 sentences)
4. WHEN Visual_Observations are not available (no video consent or camera unavailable), THE Evaluation_Generator SHALL produce an evaluation identical to Phase 3 behavior with no `visual_feedback` field — specifically: no visual terms in the system prompt, no visual observations section in the user prompt, no `visual_feedback` key in the JSON schema, and no visual transition sentence in the rendered script. The prompt SHALL be byte-identical to Phase 3 output given the same transcript, metrics, and config, verified via SHA-256 prompt hash equality. Only internal logs, video pipeline state, and diagnostics may differ
5. THE script rendering pipeline SHALL include visual feedback items in the spoken evaluation, positioned after the standard commendations and recommendations and before the closing
6. THE visual feedback section in the rendered script SHALL be prefaced with a brief transition sentence (e.g., "Looking at your delivery from a visual perspective...")

### Requirement 9: Visual Metrics in Delivery Metrics

**User Story:** As a developer, I want visual measurements included in the DeliveryMetrics structure, so that all delivery data is available in a single consistent format for evaluation generation and persistence.

#### Acceptance Criteria

1. THE DeliveryMetrics interface SHALL be extended with an optional `visualMetrics` field of type `VisualMetrics | null` containing: `gazeBreakdown` (object with `audienceFacing`, `notesFacing`, `other` percentage fields), `faceNotDetectedCount` (number), `totalGestureCount` (number), `gestureFrequency` (number, gestures per minute), `gesturePerSentenceRatio` (number | null, 0.0–1.0 when present, null when suppressed due to low frame retention), `meanBodyStabilityScore` (number, 0.0–1.0), `stageCrossingCount` (number), `movementClassification` (string: "stationary" | "moderate_movement" | "high_movement"), `meanFacialEnergyScore` (number, 0.0–1.0), `facialEnergyVariation` (number, coefficient of variation), `facialEnergyLowSignal` (boolean), `framesAnalyzed` (number), `videoQualityGrade` ("good" | "degraded" | "poor"), `videoQualityWarning` (boolean, derived as `videoQualityGrade !== "good"` — NOT stored independently, NOT separately computed), `gazeReliable` (boolean), `gestureReliable` (boolean), `stabilityReliable` (boolean), `facialEnergyReliable` (boolean), `framesDroppedByFinalizationBudget` (number), `resolutionChangeCount` (number), and `videoProcessingVersion` (object with `tfjsVersion`, `tfjsBackend`, `modelVersions: { blazeface, movenet }`, `configHash`)
2. WHEN Visual_Observations are available, THE Session_Manager SHALL populate the `visualMetrics` field on the session's DeliveryMetrics after the Video_Processor finalizes
3. WHEN Visual_Observations are not available, THE `visualMetrics` field SHALL be null, and all existing metrics computation SHALL remain unchanged
4. WHEN the Operator saves outputs, THE saved metrics JSON SHALL include the `visualMetrics` field if present; this is the only video-derived data that reaches disk

### Requirement 10: WebSocket Protocol Extension for Video

**User Story:** As a developer, I want WebSocket message types for video frame transport, video consent, and video configuration, so that the client can stream video data and manage video permissions.

#### Acceptance Criteria

1. THE system SHALL define a new `set_video_consent` ClientMessage type with fields: `consentGranted` (boolean) and `timestamp` (string, ISO 8601)
2. THE system SHALL define a new `video_stream_ready` ClientMessage type with fields: `width` (number), `height` (number), and `deviceLabel` (string, optional) — sent by the client after successful `getUserMedia` acquisition. `deviceLabel` is optional because it can leak personal hardware information
3. THE system SHALL define a new `set_video_config` ClientMessage type with fields: `frameRate` (number, range 1–5, default 2) — settable only in IDLE state
4. THE client SHALL send video frames as binary WebSocket messages using the canonical TM-prefixed framing format defined in Requirement 2, Acceptance Criterion 2: `[0x54 0x4D magic ("TM")][0x56 type byte (video)][3-byte big-endian uint24 = header JSON byte length][UTF-8 JSON header with `timestamp` (number), `seq` (number), `width` (number), `height` (number)][JPEG bytes]`. Audio frames SHALL use the same envelope with type byte `0x41` (audio). The server SHALL use the type byte for demultiplexing — no heuristics
5. THE system SHALL define a new `video_status` ServerMessage type with fields: `framesProcessed` (number, total since recording start), `framesDropped` (number, total frames received but not selected by Frame_Sampler), and `processingLatencyMs` (number, rolling average of decode+inference time per processed frame over the last 10 frames)
6. WHEN the Server receives a binary video frame message while the Session is not in RECORDING state, THE Server SHALL silently discard the frame
7. WHEN the Server receives a binary video frame message while Video_Consent is not granted, THE Server SHALL silently discard the frame
8. THE Server SHALL send periodic `video_status` messages (at most 1 per second) to the client during recording to report video processing health

### Requirement 11: Video Data Lifecycle and Privacy

**User Story:** As a developer, I want video data to follow the same privacy-first lifecycle as audio data, so that no video frames or derived imagery are ever persisted.

#### Acceptance Criteria

1. THE Video_Processor SHALL process each frame in-memory and dereference the pixel buffer and JPEG bytes immediately after extracting keypoints; no frame pixel data SHALL be retained beyond the current sampling interval
2. THE system SHALL NOT write any video frame data, thumbnails, screenshots, base64-encoded images, or any visual representation to disk or logs under any circumstances. THE system SHALL NOT persist or log per-frame keypoints, frame headers, frame timestamps, frame sequence numbers, sequence streams, or camera device labels. Debug and error logs SHALL contain only aggregate counters (framesProcessed, framesErrored, latencyMs) and SHALL NOT include pixel data, keypoint coordinates, JPEG byte lengths, or any data that could reconstruct frame content or motion trajectories. No per-frame or reconstructable motion data SHALL be logged or persisted under any circumstances. Only aggregated VisualObservations MAY survive session lifetime
3. THE Visual_Observations (aggregate statistics only) SHALL follow the same retention lifecycle as other session data: in-memory until purge timer or opt-out
4. WHEN speaker opt-out occurs, THE Session_Manager SHALL purge Visual_Observations as part of the full session data purge
5. WHEN the auto-purge timer fires, THE Session_Manager SHALL clear Visual_Observations alongside other session data, reset `videoConsent` to null, and reset `videoStreamReady` to false
6. THE saved outputs (when "Save Outputs" is clicked) SHALL include only the `visualMetrics` field within metrics.json; no raw frame data, keypoint sequences, or per-frame data SHALL be persisted
7. THE system SHALL NOT persist or log `deviceLabel` values from `video_stream_ready` messages

### Requirement 12: Video Processing Resilience

**User Story:** As a developer, I want the video pipeline to handle errors gracefully without affecting the audio evaluation pipeline, so that a camera failure does not degrade the core evaluation experience.

#### Acceptance Criteria

1. IF the Video_Processor encounters an error during frame processing (decode failure, model inference error), THEN THE Video_Processor SHALL log the error, increment `framesDropped`, skip the frame, and continue processing subsequent frames
2. IF the Video_Processor fails to initialize (model loading failure, resource unavailable), THEN THE Session_Manager SHALL proceed with audio-only evaluation and send a recoverable error message to the client indicating video processing is unavailable
3. IF the camera feed drops during recording (no frames received for more than 5 seconds after the last frame), THEN THE Video_Processor SHALL finalize Visual_Observations from frames processed so far and set the `videoQualityGrade` to "degraded" or "poor" based on frame retention
4. WHEN `videoQualityGrade` is "degraded", THE Evaluation_Generator SHALL include an uncertainty qualifier in the visual feedback section acknowledging incomplete video data (e.g., "Based on partial video coverage...")
5. THE Video_Processor error handling SHALL NOT trigger panic mute, interrupt the audio recording pipeline, or cause any state transition in the Session_Manager

### Requirement 13: Scope Acknowledgment Update

**User Story:** As a developer, I want the scope acknowledgment to reflect whether video data was used, so that the evaluation accurately describes its observational basis.

#### Acceptance Criteria

1. WHEN Visual_Observations are available and included in the evaluation, THE Tone_Checker SHALL update the scope acknowledgment to "This evaluation is based on audio and video content."
2. WHEN Visual_Observations are not available, THE Tone_Checker SHALL use the existing scope acknowledgment "This evaluation is based on audio content only."
3. THE scope acknowledgment SHALL be appended to the evaluation script as the final sentence before TTS synthesis, consistent with the existing Phase 2 behavior

### Requirement 14: Visual Metric Computation Latency Budget

**User Story:** As a developer, I want a defined latency budget for visual metric finalization, so that video processing does not delay evaluation delivery beyond acceptable meeting flow timing.

#### Acceptance Criteria

1. THE Video_Processor SHALL finalize Visual_Observations within 1.5 seconds (target) and no more than 3 seconds (hard max) after `stopRecording()` is called, measured from the moment the drain loop is signaled to stop until `finalize()` returns
2. IF the drain loop has unprocessed frames when `stopRecording()` is called, THE Video_Processor SHALL drain remaining queued frames up to the latency budget, then finalize with whatever data has been accumulated — incomplete processing is acceptable, delayed evaluation delivery is not
3. THE Video_Processor SHALL track `finalizationLatencyMs` and include it in the `video_status` final report

### Requirement 15: Backpressure and Overload Behavior

**User Story:** As a developer, I want deterministic behavior under sustained video processing overload, so that the system degrades predictably without unbounded resource growth.

#### Acceptance Criteria

1. THE FrameQueue SHALL have a configurable maximum size (default: 20 frames) representing an upper bound on video frame memory; at default JPEG quality 0.7 and 640x480 resolution, this is approximately 2-4 MB
2. WHEN the FrameQueue is full, THE oldest frame SHALL be dropped and `framesDroppedByBackpressure` SHALL be incremented — the queue prioritizes temporal freshness over completeness
3. THE Visual_Observations SHALL distinguish frame loss causes: `framesSkippedBySampler` (normal sampling), `framesDroppedByBackpressure` (overload), and `framesErrored` (decode/inference failure)
4. Queue overflow SHALL NOT increase processing latency for subsequent frames — the enqueue operation is O(1) regardless of queue state
5. WHEN `framesDroppedByBackpressure` exceeds 20% of `framesReceived`, THE Video_Processor SHALL reduce the effective sampling rate by half (adaptive sampling) to allow the drain loop to catch up. Adaptive sampling SHALL use hysteresis: overload threshold is 20%, recovery threshold is 10%, with a 3-second cooldown window before restoring the configured rate — this prevents sampling rate oscillation under fluctuating load
6. WHEN frame retention rate drops below a configurable threshold (default: 50%) in any rolling 5-second window, THE Video_Processor SHALL mark metric reliability as degraded, suppress `gesturePerSentenceRatio` (set to null), and reduce confidence in movement classification
7. THE `framesReceived` counter SHALL count all validly-parsed frames that passed basic wire-format validation (TM magic prefix present, type byte valid, header parseable), regardless of whether they were enqueued. Frames dropped by timestamp/seq integrity checks SHALL increment `framesDroppedByTimestamp` and SHALL be excluded from the backpressure overload ratio denominator. The effective denominator for backpressure ratio is `framesReceived - framesDroppedByTimestamp`
8. THE Server SHALL enforce wire-format safety limits on incoming binary frames: the 2-byte magic prefix `0x54 0x4D` MUST be present, the type byte MUST be `0x41` (audio) or `0x56` (video), maximum header JSON byte length of 4096 bytes, maximum payload size of 2MB for video (JPEG) frames, and maximum frame dimensions of 1920×1080 for video. Frames missing the magic prefix, having an unrecognized type byte, or exceeding any limit SHALL be silently discarded and counted as `framesErrored`

### Requirement 16: Temporal Integrity

**User Story:** As a developer, I want audio and video timestamps to be aligned on a single time base, so that gesture-per-sentence alignment and other cross-modal metrics are accurate.

#### Acceptance Criteria

1. THE client SHALL use a single monotonic time base (relative to recording start) for both audio chunk timestamps and video frame timestamps, derived from `performance.now()` at recording start
2. THE client SHALL generate a strictly increasing `seq` (sequence number) per frame, starting at 0 at recording start and incrementing by 1 for each frame. The `seq` resets per session and SHALL never decrease within a session
3. THE Video_Processor SHALL reject (silently discard) frames whose timestamps are more than 2 seconds older than the most recently processed frame's timestamp — stale frames from queue delays SHALL NOT corrupt temporal metrics
4. THE Video_Processor SHALL tolerate resolution changes mid-session (e.g., camera auto-adjustment): all position metrics are normalized by per-frame dimensions, so a resolution change does not invalidate accumulated data. WHEN resolution changes, THE Video_Processor SHALL reset normalization baselines and EMA state, but SHALL NOT restart the session or discard accumulated aggregates
5. Frame timestamps MUST be monotonically increasing; frames with timestamp regression (timestamp ≤ last processed timestamp) SHALL be dropped and counted as dropped frames
6. THE Video_Processor SHALL reject frames with non-increasing `seq` (seq ≤ last processed seq): such frames SHALL be dropped and counted in `framesDroppedByTimestamp`. This prevents "timestamp-correct but reordered" frames from corrupting gesture deltas and EMA smoothing
7. IF a timestamp jump greater than 2 seconds occurs between consecutive frames, THE Video_Processor SHALL drop the frame and count it as dropped — large jumps corrupt gesture alignment, EMA smoothing, and cross-frame motion calculations
8. THE `gesturePerSentenceRatio` SHALL be computed only after the final transcript is available (post-speech), OR transcript timestamps MUST be speech-time aligned — partial/interim transcript timestamps SHALL NOT be used for gesture alignment
9. WHEN frames are dropped due to timestamp/seq integrity (framesDroppedByTimestamp), THE Video_Processor SHALL exclude them from backpressure ratios and retention calculations

### Requirement 17: Video Quality Grading

**User Story:** As a developer, I want graded video quality assessment rather than a binary warning, so that the evaluation can calibrate the strength of visual claims appropriately.

#### Acceptance Criteria

1. THE Visual_Observations SHALL define two denominators for quality assessment: `expectedSampleCount = durationSeconds * effectiveSamplingRate` (configured rate adjusted by adaptive sampling — measures pipeline health) and `eligibleSampleCount` = samples that passed timestamp/seq integrity checks (measures input quality). THE Video_Processor SHALL compute `videoQualityGrade` using `framesAnalyzed / expectedSampleCount` plus camera-drop detection with the following deterministic thresholds:

| Grade | Criteria | Behaviour |
|-------|----------|-----------|
| good | ≥80% of expectedSampleCount analyzed AND face detected in ≥60% of analyzed frames AND no camera drop | Full visual feedback using all reliable metrics |
| degraded | 50-79% of expectedSampleCount analyzed OR camera drop recovered OR face detected in 30-59% of analyzed frames | Visual feedback allowed with uncertainty qualifier; per-metric reliability flags gate individual metrics |
| poor | <50% of expectedSampleCount analyzed OR face detected in <30% of analyzed frames | Visual feedback suppressed entirely |

Additionally, per-metric reliability flags (`gazeReliable`, `gestureReliable`, `stabilityReliable`, `facialEnergyReliable`) SHALL independently gate each metric. The Evaluation_Generator MUST suppress unreliable metrics even when `videoQualityGrade` is "good" or "degraded"
2. THE `videoQualityWarning` boolean SHALL remain for backward compatibility, derived as `videoQualityGrade !== "good"` — it is NOT stored independently, NOT separately computed
3. WHEN `videoQualityGrade` is "poor", THE Evaluation_Generator SHALL suppress visual feedback entirely, remove the visual section including the transition sentence, and note "Video data was insufficient for visual observations" in the evaluation
4. WHEN `videoQualityGrade` is "degraded", THE Evaluation_Generator SHALL include visual feedback with an uncertainty qualifier (e.g., "Based on partial video coverage...")

### Requirement 18: Determinism Guarantee

**User Story:** As a developer, I want deterministic visual metric computation, so that identical inputs always produce identical outputs for testing and debugging.

#### Acceptance Criteria

1. GIVEN an identical ordered frame stream, transcript, and the same runtime environment (same TF.js version, same TF.js backend, same model versions, same config), THE Video_Processor SHALL produce identical VisualObservations — the computation MUST be deterministic within the same runtime + backend + model version
2. ALL floating-point metrics SHALL use explicit rounding rules (round to 4 decimal places) to ensure numeric precision does not introduce non-determinism across runs on the same platform
3. THE Video_Processor SHALL NOT use any non-deterministic TensorFlow.js operations; where TF.js operations have non-deterministic variants, the deterministic variant SHALL be selected
4. THE Video_Processor SHALL log a `videoProcessingVersion` tuple in-memory: `{ tfjsVersion: string, tfjsBackend: string, modelVersions: { blazeface: string, movenet: string }, configHash: string }`. This tuple is allowed to persist in the metrics JSON output since it contains no raw video data

### Requirement 19: Metric Reliability and Confidence Gating

**User Story:** As a developer, I want metrics to be gated by detection confidence and frame coverage, so that unreliable measurements do not produce misleading evaluation claims.

> **Metric reliability gating is mandatory when any visual feedback is produced. This requirement is safety-critical.**

#### Acceptance Criteria

1. THE Video_Processor SHALL compute metrics only from frames where detection confidence meets or exceeds a configurable threshold (default: face detection confidence ≥ 0.5, pose detection confidence ≥ 0.3)
2. WHEN a rolling 5-second window has fewer than the minimum required valid frames (default: 3 frames), THE Video_Processor SHALL exclude that window from aggregate metric computation
3. THE Visual_Observations SHALL include per-metric reliability indicators: `gazeReliable` (boolean), `gestureReliable` (boolean), `stabilityReliable` (boolean), `facialEnergyReliable` (boolean) — each set to false when insufficient valid frames exist for that metric
4. WHEN a metric is marked as unreliable, THE Evaluation_Generator SHALL NOT reference that metric in visual feedback items
5. THE Video_Processor SHALL compute per-metric coverage as `coverage = validFramesForMetric / framesAnalyzed` and apply default minimum coverage thresholds: gaze 0.6, facial energy 0.4, gesture 0.3, stability 0.6. WHEN a metric's coverage falls below its threshold, THE Video_Processor SHALL set that metric's reliability flag to false. These thresholds account for naturally sparse metrics (e.g., gestures with occluded hands, facial energy with small face bounding boxes)

### Requirement 20: Numeric Precision and Units Convention

**User Story:** As a developer, I want explicit rules for how numeric metrics are stored, rendered, and validated, so that rounding does not introduce flaky tests or misleading evaluation claims.

#### Acceptance Criteria

1. ALL stored numeric metrics SHALL be rounded to 4 decimal places before persistence or aggregate computation
2. Percentages in VisualObservations SHALL use the [0, 100] range (e.g., 65.0000 means 65%)
3. `gestureFrequency` SHALL be rounded AFTER division (gestures / minutes), not before
4. Script rendering SHALL format percentages as human-readable integers or 1-decimal (e.g., "65%" not "65.0000%") — this is a display concern, not a storage concern
5. `observation_data` validation SHALL compare against the stored rounded value (4 decimal places), ensuring validation stability regardless of rendering format
6. THE ±1% tolerance in observation_data validation SHALL use relative error: `|citedValue - actualValue| / |actualValue| <= 0.01`. For actual values of 0, the cited value must also be exactly 0. Validation SHALL compare the cited value against the stored rounded value (4 decimal places), not the pre-rounding value

### Requirement 21: Optional High-Value Improvements

**User Story:** As a developer, I want optional enhancements that improve metric quality and evaluation precision, so that the system can be incrementally improved.

#### Acceptance Criteria

1. WHERE the confidence score per metric feature is enabled, THE Visual_Observations SHALL include a `confidenceScores` object with per-metric confidence values (0.0–1.0) derived from detection model confidence and frame coverage
2. WHERE the detection coverage percentage feature is enabled, THE Visual_Observations SHALL include a `detectionCoverage` object with per-metric coverage percentages (fraction of frames where the relevant detector succeeded)
3. WHERE per-metric suppression is enabled, THE Evaluation_Generator SHALL suppress individual unreliable metrics rather than suppressing the entire visual feedback section
4. WHERE noise-floor auto-calibration is enabled, THE Video_Processor SHALL compute a noise floor for Facial_Energy_Score during the first 3 seconds of recording and subtract it from subsequent measurements
5. WHERE motion dead-zone is enabled, THE Video_Processor SHALL ignore body center-of-mass displacements below a configurable threshold (default: 2% of frame diagonal) to filter out small posture sway
6. WHERE camera placement heuristic is enabled, THE Video_Processor SHALL estimate camera angle relative to the Speaker based on face landmark asymmetry and warn if the angle exceeds 30° from frontal
