# Requirements Document

## Introduction

The `computeVideoQualityGrade` method in `VideoProcessor` always returns `"poor"` when no face detector is configured. This happens because the `VideoProcessor` is instantiated with empty deps (`{}`) in `SessionManager.startRecording()`, meaning no `faceDetector` is ever provided. Without a face detector, every frame increments `faceNotDetectedCount`, driving `faceDetectionRate` to 0, which unconditionally triggers the `"poor"` grade. This cascades into `generateEvaluation`, where visual observations are completely suppressed when `videoQualityGrade === "poor"`, rendering all video analysis useless.

The fix adjusts `computeVideoQualityGrade` to skip the face detection rate check when no face detector is configured, basing the quality grade solely on `analysisRate` in that scenario. It also ensures face-dependent counters are not incremented when no face detector is present, adds explicit capability tracking so downstream consumers know which metrics are available, and updates `EvaluationGenerator` to respect capabilities when building LLM prompts.

## Supported Mode Clarification

Running `VideoProcessor` without a `faceDetector` is a **supported pose-only mode**, not a misconfiguration. `SessionManager.startRecording()` creates the `VideoProcessor` with empty deps (`{}`), which is the current production path. In this mode, only pose-based metrics (gesture, body stability) are valid. Face-based metrics (gaze, facial energy) are unavailable and SHALL be treated as such by all consumers.

## Scope

The fix touches three components:

- **VideoProcessor** (`src/video-processor.ts`): grade computation, face-counter guards, capabilities emission, video-time duration.
- **EvaluationGenerator** (`src/evaluation-generator.ts`): capabilities-based face-metric exclusion in LLM prompts.
- **VisualObservations** (`src/types.ts`): new `capabilities` field on the interface.

`SessionManager` requires no code changes — its existing `videoQualityGrade !== "poor"` suppression logic already handles the passthrough correctly once the grade is computed correctly. However, SessionManager behavior (passing or suppressing visual observations) is normatively specified in Requirement 6 and must be verified.

## Glossary

- **VideoProcessor**: The component in `src/video-processor.ts` responsible for processing video frames, running face/pose detection, and computing aggregate visual observations.
- **VideoProcessorDeps**: The dependency injection interface for `VideoProcessor`, containing optional `faceDetector` and `poseDetector` fields.
- **Quality_Grade**: `"good"` | `"degraded"` | `"poor"` — exactly three values, no others.
- **Analysis_Rate**: `Math.min(1, framesAnalyzed / expectedSampleCount)`, clamped to `[0, 1]`. `expectedSampleCount = videoDurationSeconds * effectiveSamplingRate`, where `videoDurationSeconds` is the maximum `FrameHeader.timestamp` received (i.e., seconds since recording start on the client's monotonic clock), and `effectiveSamplingRate` is `config.frameRate` in normal mode or `config.frameRate / 2` in adaptive mode. Video-time is used (not wall-clock) so that camera warmup delays or network latency between `startRecording()` and the first frame do not inflate `expectedSampleCount`.
- **Face_Detection_Rate**: `(framesAnalyzed - faceNotDetectedCount) / framesAnalyzed`. Only computed when `capabilities.face === true`.
- **Camera_Drop**: Detected when `Date.now() - lastFrameWallTime > config.cameraDropTimeoutSeconds * 1000` (wall-clock based, default timeout 5 seconds). Indicates the camera feed has stalled. Camera drop detection intentionally uses wall-clock time (not video-time) because it must detect real-time feed stalls even when no new frames arrive.
- **Video_Quality_Warning**: `videoQualityWarning = (videoQualityGrade !== "good")`. This derivation rule is consistent with the Phase 4 multimodal-video spec (Req 17.2) — both specs agree on this definition.
- **SessionManager**: The orchestrator in `src/session-manager.ts` that manages session lifecycle and creates `VideoProcessor` instances.
- **Visual_Observations**: The aggregate output of video processing, containing gesture and stability metrics (always available when `capabilities.pose === true`), plus gaze and facial energy metrics (available only when `capabilities.face === true`).
- **Capabilities**: `{ face: boolean; pose: boolean }` on `VisualObservations`. This is the sole authoritative signal for metric availability. Consumers MUST NOT infer availability from zero values, structural presence of fields, or per-metric reliability flags (`gazeReliable`, `facialEnergyReliable`). The reliability flags remain on the interface for backward compatibility with Phase 4 consumers, but `capabilities` takes precedence for gating decisions introduced by this bugfix.

## Requirements

### Requirement 1: Quality Grade Computation Without Face Detector

**User Story:** As a system operator, I want the video quality grade to reflect actual video analysis quality even when no face detector is configured, so that visual observations are not incorrectly suppressed.

#### Acceptance Criteria

1. WHILE no face detector is configured in VideoProcessorDeps, THE VideoProcessor SHALL skip the face detection rate check in Quality_Grade computation and base the grade solely on Analysis_Rate and Camera_Drop detection.
2. WHILE no face detector is configured, WHEN Analysis_Rate is at least 0.8 and no Camera_Drop is detected, THE VideoProcessor SHALL assign a Quality_Grade of `"good"`.
3. WHILE no face detector is configured, WHEN Analysis_Rate is between 0.5 (inclusive) and 0.8 (exclusive), THE VideoProcessor SHALL assign a Quality_Grade of `"degraded"`.
4. WHILE no face detector is configured, WHEN Analysis_Rate is below 0.5, THE VideoProcessor SHALL assign a Quality_Grade of `"poor"`.
5. WHILE a face detector is configured, THE VideoProcessor SHALL continue to use both Analysis_Rate and Face_Detection_Rate to compute Quality_Grade, preserving existing behavior.

### Requirement 2: Quality Grade With Face Detector Preserves Existing Behavior

**User Story:** As a system operator, I want the existing quality grading logic to remain unchanged when a face detector is provided, so that no regressions are introduced.

#### Acceptance Criteria

1. WHILE a face detector is configured, WHEN Analysis_Rate is at least 0.8 AND Face_Detection_Rate is at least 0.6 AND no Camera_Drop is detected, THE VideoProcessor SHALL assign a Quality_Grade of `"good"`.
2. WHILE a face detector is configured, WHEN Analysis_Rate is below 0.5 OR Face_Detection_Rate is below 0.3, THE VideoProcessor SHALL assign a Quality_Grade of `"poor"`.
3. WHILE a face detector is configured, WHEN the conditions for `"good"` and `"poor"` are not met, THE VideoProcessor SHALL assign a Quality_Grade of `"degraded"`.

### Requirement 3: Camera Drop Downgrade Rules

**User Story:** As a system operator, I want camera drop detection to normatively cap the quality grade, so that stalled camera feeds are reflected in the grade.

#### Acceptance Criteria

1. WHEN Camera_Drop is detected (wall-clock gap exceeds `config.cameraDropTimeoutSeconds * 1000` ms since last frame), THE VideoProcessor SHALL cap Quality_Grade to at most `"degraded"` — a grade that would otherwise be `"good"` SHALL be downgraded to `"degraded"`.
2. Camera_Drop detection SHALL NOT upgrade a grade — if the grade is already `"degraded"` based on Analysis_Rate (and Face_Detection_Rate when applicable), Camera_Drop SHALL not change it.
3. Camera_Drop detection SHALL NOT change a `"poor"` grade — `"poor"` remains `"poor"` regardless of camera drop status.
4. Camera_Drop detection SHALL use wall-clock time (`Date.now()`) compared to `lastFrameWallTime`, with the timeout defined by `config.cameraDropTimeoutSeconds` (default: 5 seconds).

### Requirement 4: Face-Dependent Counters and Metrics Without Face Detector

**User Story:** As a system operator, I want face-dependent counters to not accumulate misleading values when no face detector is present, so that metrics accurately reflect detector availability.

#### Acceptance Criteria

1. WHILE no face detector is configured, THE VideoProcessor SHALL NOT increment `faceNotDetectedCount` during frame processing. The value SHALL remain 0.
2. WHILE no face detector is configured, THE VideoProcessor SHALL NOT compute `faceDetectionRate` in the quality grade method.
3. WHILE no face detector is configured, gaze classifications SHALL still be pushed (as `"other"`) for frame counting purposes, but `gazeBreakdown` SHALL reflect 100% `"other"`.

### Requirement 5: Capability Tracking on VisualObservations

**User Story:** As a system operator, I want VisualObservations to explicitly declare which detector capabilities were available, so that downstream consumers can distinguish "metric unavailable" from "metric measured as zero."

#### Acceptance Criteria

1. THE `VisualObservations` interface SHALL include a `capabilities` field of type `{ face: boolean; pose: boolean }`.
2. `capabilities.face` SHALL be `true` if and only if `deps.faceDetector` was defined at construction time.
3. `capabilities.pose` SHALL be `true` if and only if `deps.poseDetector` was defined at construction time.
4. `capabilities` is the sole authoritative signal for metric availability. ALL downstream consumers (EvaluationGenerator, UI, metrics persistence, file persistence) SHALL use `capabilities` to gate face-metric inclusion/exclusion. Consumers MUST NOT infer metric availability from zero values, structural presence of fields, or per-metric reliability flags (`gazeReliable`, `facialEnergyReliable`). When `capabilities.face === false`, face-dependent metrics (gaze, facial energy) MUST be treated as "unavailable" even if structurally present.

### Requirement 6: Visual Observations Passthrough and Prompt Filtering

**User Story:** As a system operator, I want visual observations to be included in evaluations when video analysis quality is adequate, even without a face detector, so that gesture and stability data are not wasted.

#### Acceptance Criteria

1. WHEN VideoProcessor produces a Quality_Grade of `"good"` or `"degraded"` without a face detector, THE SessionManager SHALL pass Visual_Observations to the evaluation generator.
2. WHEN VideoProcessor produces a Quality_Grade of `"poor"` without a face detector (due to low Analysis_Rate), THE SessionManager SHALL suppress Visual_Observations from the evaluation generator.
3. WHEN Visual_Observations are passed with `capabilities.face === false`, THE EvaluationGenerator SHALL exclude gaze and facial energy metrics from the LLM prompt, and SHALL NOT produce visual_feedback items referencing face-dependent metrics. Only pose-based metrics (gesture, body stability) SHALL be included.

### Requirement 7: No Detectors Available Guard

**User Story:** As a system operator, I want the system to handle the edge case where neither face nor pose detectors are configured, so that meaningless visual observations are not passed to downstream consumers.

#### Acceptance Criteria

1. WHEN `capabilities.face === false` AND `capabilities.pose === false`, THE VideoProcessor SHALL assign a Quality_Grade of `"poor"` regardless of Analysis_Rate or Camera_Drop status, because no meaningful visual analysis can occur without at least one detector.
2. WHEN `capabilities.face === false` AND `capabilities.pose === false`, THE SessionManager SHALL suppress Visual_Observations from the evaluation generator (same as any `"poor"` grade).
3. This rule takes precedence over the Analysis_Rate-based grading in Requirement 1 — even if `analysisRate >= 0.8`, the grade SHALL be `"poor"` when no detectors are available.

### Requirement 8: Analysis Rate Definition

**User Story:** As a system operator, I want Analysis_Rate to be precisely defined and bounded, so that quality grade computation is deterministic and predictable.

#### Acceptance Criteria

1. `videoDurationSeconds` SHALL be the maximum `FrameHeader.timestamp` value received by the VideoProcessor (tracked as `lastReceivedTimestamp`). This is the highest frame header timestamp seen, regardless of whether the frame was sampled, analyzed, or errored. Wall-clock time (`Date.now() - recordingStartTime`) SHALL NOT be used for this computation.
2. `expectedSampleCount` SHALL be computed as `videoDurationSeconds * effectiveSamplingRate`, where `effectiveSamplingRate = config.frameRate` in normal mode or `config.frameRate / 2` in adaptive mode.
3. `analysisRate` SHALL be computed as `Math.min(1, framesAnalyzed / expectedSampleCount)`, clamped to `[0, 1]`.
4. WHEN `expectedSampleCount <= 0` (e.g., no frames received, or zero duration), THE VideoProcessor SHALL return a Quality_Grade of `"poor"` as a guard.
5. Video-time (frame header timestamps) SHALL be used for `expectedSampleCount` computation. Wall-clock time (`Date.now()`) SHALL be used only for Camera_Drop detection. This separation ensures that camera warmup delays between `startRecording()` and the first frame do not inflate `expectedSampleCount`.
