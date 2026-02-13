# Implementation Plan: Video Quality Always Poor Bugfix

## Overview

Fix `computeVideoQualityGrade` in `VideoProcessor` to skip face detection rate checks when no `faceDetector` is configured, stop incrementing face-dependent counters in pose-only mode, add capability tracking to `VisualObservations`, refactor `analysisRate` duration to video-time using `lastReceivedTimestamp`, clamp `analysisRate`, and ensure all downstream consumers handle partial metrics safely via `capabilities`.

## Tasks

- [x] 1. Add `capabilities` field to `VisualObservations` interface in `src/types.ts`
  - [x] 1.1 Add `capabilities: { face: boolean; pose: boolean }` to the `VisualObservations` interface
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. Fix `processFrame` in `src/video-processor.ts` to not increment face counters without face detector
  - [x] 2.1 Guard `faceNotDetectedCount++` behind `this.deps.faceDetector` check
    - When `this.deps.faceDetector` is undefined: still push `"other"` to `gazeClassifications` (preserves frame counting), but do NOT increment `faceNotDetectedCount`
    - When `this.deps.faceDetector` is defined: preserve existing behavior unchanged
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 3. Add `lastReceivedTimestamp` field and refactor `analysisRate` duration to video-time
  - [x] 3.1 Add private field `lastReceivedTimestamp: number` (initialized to 0) to `VideoProcessor`
    - Update in `enqueueFrame`: `this.lastReceivedTimestamp = Math.max(this.lastReceivedTimestamp, header.timestamp)` before any sampling or processing decisions
    - This tracks the max `FrameHeader.timestamp` seen across all received frames, regardless of sampling/analysis/error outcomes
    - _Requirements: 8.1_
  - [x] 3.2 In `computeAggregates`, compute `expectedSampleCount` using `this.lastReceivedTimestamp * this.getEffectiveRate()` instead of wall-clock `(Date.now() - this.recordingStartTime) / 1000 * this.getEffectiveRate()`
    - Keep wall-clock `durationSeconds` for gesture frequency and sparse transcript check (those measure real elapsed time)
    - Keep wall-clock for Camera_Drop detection (must detect real-time stalls)
    - _Requirements: 8.1, 8.2, 8.5_

- [x] 4. Fix `computeVideoQualityGrade` in `src/video-processor.ts`
  - [x] 4.1 Add no-detectors guard, faceDetector branch, and clamp `analysisRate`
    - Guard: if `expectedSampleCount <= 0`, return `"poor"`
    - Guard: if neither `faceDetector` nor `poseDetector` is configured, return `"poor"` immediately
    - Clamp `analysisRate` to `[0, 1]` via `Math.min(1, framesAnalyzed / expectedSampleCount)`
    - When `this.deps.faceDetector` is undefined (but pose available): grade using only `analysisRate` and camera drop
    - When `this.deps.faceDetector` is defined: preserve existing dual-metric logic unchanged
    - Camera drop caps grade to at most `"degraded"` (never upgrades, never changes `"poor"`)
    - Thresholds without face detector: `>= 0.8` and no camera drop -> `"good"`, `>= 0.5` -> `"degraded"`, `< 0.5` -> `"poor"`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 7.1, 7.3, 8.3, 8.4_

- [x] 5. Populate `capabilities` in `computeAggregates` in `src/video-processor.ts`
  - [x] 5.1 Add `capabilities: { face: !!this.deps.faceDetector, pose: !!this.deps.poseDetector }` to the returned `VisualObservations` object
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 6. Set `videoQualityWarning` consistently in `computeAggregates`
  - [x] 6.1 Ensure `videoQualityWarning = (videoQualityGrade !== "good")` in the returned `VisualObservations`
    - Verify this is consistent with Phase 4 spec (Req 17.2)
    - _Requirements: Glossary (Video_Quality_Warning)_

- [x] 7. Update `EvaluationGenerator.buildUserPrompt` to respect `capabilities`
  - [x] 7.1 When `visualObservations.capabilities.face === false`, exclude `gazeBreakdown`, `faceNotDetectedCount`, `meanFacialEnergyScore`, `facialEnergyVariation`, `facialEnergyLowSignal` from the filtered observations passed to the LLM prompt
    - Do NOT check `gazeReliable` or `facialEnergyReliable` — `capabilities` is the sole gate
    - Only gesture and stability metrics are included when `capabilities.face === false`
    - _Requirements: 5.4, 6.3_

- [x] 8. Verify SessionManager passthrough behavior
  - [x] 8.1 Write a unit test confirming that when `VideoProcessor` produces `"good"` or `"degraded"` without a face detector, `SessionManager.generateEvaluation` passes non-null `visualObservations` to `EvaluationGenerator`
    - _Requirements: 6.1_
  - [x] 8.2 Write a unit test confirming that when `VideoProcessor` produces `"poor"`, `SessionManager.generateEvaluation` suppresses `visualObservations` (passes null/undefined)
    - _Requirements: 6.2_

- [x] 9. Audit non-EvaluationGenerator consumers for capabilities usage
  - [x] 9.1 Search `src/` for all references to `gazeBreakdown`, `faceNotDetectedCount`, `meanFacialEnergyScore`, `facialEnergyVariation`, `facialEnergyLowSignal`, `gazeReliable`, `facialEnergyReliable` outside of `EvaluationGenerator`
    - For each consumer found (UI, metrics persistence, file persistence), verify it gates face-metric usage on `capabilities.face`
    - If any consumer does not check `capabilities`, add the guard
    - _Requirements: 5.4_

- [x] 10. Unit tests for `computeVideoQualityGrade` without face detector
  - [x] 10.1 Test: `analysisRate >= 0.8` and no camera drop → `"good"`
    - _Requirements: 1.2_
  - [x] 10.2 Test: `0.5 <= analysisRate < 0.8` → `"degraded"`
    - _Requirements: 1.3_
  - [x] 10.3 Test: `analysisRate < 0.5` → `"poor"`
    - _Requirements: 1.4_
  - [x] 10.4 Test: camera drop caps `"good"` to `"degraded"`
    - _Requirements: 3.1_
  - [x] 10.5 Test: camera drop does not change `"poor"` grade
    - _Requirements: 3.3_
  - [x] 10.6 Test: `expectedSampleCount <= 0` returns `"poor"`
    - _Requirements: 8.4_
  - [x] 10.7 Test: `analysisRate > 1.0` is clamped to 1.0 before threshold checks
    - _Requirements: 8.3_
  - [x] 10.8 Test: camera warmup delay (wall-clock gap before first frame) does not inflate expectedSampleCount or force `"poor"` grade
    - _Requirements: 8.5_

- [x] 11. Unit tests for `computeVideoQualityGrade` with face detector (regression)
  - [x] 11.1 Test: `analysisRate >= 0.8` AND `faceDetectionRate >= 0.6` AND no camera drop → `"good"`
    - _Requirements: 2.1_
  - [x] 11.2 Test: `analysisRate < 0.5` OR `faceDetectionRate < 0.3` → `"poor"`
    - _Requirements: 2.2_
  - [x] 11.3 Test: otherwise → `"degraded"`
    - _Requirements: 2.3_

- [x] 12. Unit tests for face counter guards and capabilities
  - [x] 12.1 Test: `faceNotDetectedCount` remains 0 after processing frames without face detector
    - _Requirements: 4.1_
  - [x] 12.2 Test: `capabilities.face` and `capabilities.pose` reflect deps configuration
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 12.3 Test: `EvaluationGenerator.buildUserPrompt` excludes gaze/facial energy when `capabilities.face === false`
    - _Requirements: 5.4, 6.3_
  - [x] 12.4 Test: `lastReceivedTimestamp` tracks max frame header timestamp across all received frames
    - _Requirements: 8.1_

- [x] 13. Property test: No-face-detector grade depends solely on analysisRate and cameraDrop (Property 1)
  - [x] 13.1 🧪 PBT: Generate random `(framesAnalyzed, expectedSampleCount, faceNotDetectedCount, cameraDropDetected)` tuples. Instantiate `VideoProcessor` without `faceDetector` but with `poseDetector`. Assert grade matches analysisRate + cameraDrop thresholds regardless of `faceNotDetectedCount`.
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3**

- [x] 14. Property test: Face-detector grade preserves original dual-metric behavior (Property 2)
  - [x] 14.1 🧪 PBT: Generate random `(framesAnalyzed, expectedSampleCount, faceDetectedFrames, cameraDropDetected)` tuples. Instantiate `VideoProcessor` with a mock `faceDetector`. Assert grade matches original dual-metric thresholds.
    - **Validates: Requirements 1.5, 2.1, 2.2, 2.3**

- [x] 15. Property test: faceNotDetectedCount remains 0 without face detector (Property 3)
  - [x] 15.1 🧪 PBT: Generate random frame sequences processed by `VideoProcessor` without `faceDetector`. Assert `faceNotDetectedCount === 0` in resulting `VisualObservations`.
    - **Validates: Requirements 4.1**

- [x] 16. Property test: No detectors forces poor grade (Property 6)
  - [x] 16.1 🧪 PBT: Generate random `(framesAnalyzed, expectedSampleCount, cameraDropDetected)` tuples with no detectors configured. Assert grade is always `"poor"`.
    - **Validates: Requirements 7.1, 7.3**

- [x] 17. Property test: Capabilities reflect detector configuration (Property 5)
  - [x] 17.1 🧪 PBT: Generate random `VideoProcessorDeps` configurations (all four combos of face/pose presence). Assert `capabilities.face` and `capabilities.pose` match detector presence.
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 18. Property test: Non-poor grade without face detector passes visual observations (Property 4)
  - [x] 18.1 🧪 PBT: Generate random sessions where `VideoProcessor` has no face detector and produces non-poor grades. Assert `generateEvaluation` receives non-null `visualObservations`.
    - **Validates: Requirements 6.1**

## Notes

- Tasks 1–9 are implementation tasks; tasks 10–12 are unit test tasks; tasks 13–18 are property-based test tasks.
- Tasks should be executed roughly in order: interface changes (1) → counter guards (2) → video-time refactor (3) → grade logic (4) → capabilities emission (5) → warning (6) → prompt filtering (7) → passthrough verification (8) → consumer audit (9) → unit tests (10–12) → property tests (13–18).
- `lastReceivedTimestamp` replaces any prior `lastProcessedTimestamp` references. It tracks the max `FrameHeader.timestamp` seen across ALL received frames, regardless of sampling/analysis/error outcomes.
- Wall-clock (`Date.now()`) is used ONLY for Camera_Drop detection — never for `expectedSampleCount`.
- `capabilities` is the sole authoritative signal for metric availability. Per-metric reliability flags (`gazeReliable`, `facialEnergyReliable`) remain for backward compatibility but are NOT used for gating decisions in this bugfix.
- Requirement IDs: Reqs 1–8 sequential, no gaps. Req 7 = no-detectors guard, Req 8 = analysis rate definition.
