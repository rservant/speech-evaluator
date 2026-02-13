/**
 * VideoProcessor — central video analysis component.
 * Drains the FrameQueue, delegates sampling, runs inference,
 * accumulates aggregates, and produces the final VisualObservations.
 *
 * Validates: Requirements 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 12.1, 12.5,
 *   14.1, 14.2, 15.5, 15.6, 16.2, 16.3, 16.4, 16.5, 16.6,
 *   17.1, 17.2, 18.1, 18.2, 18.4, 19.1, 19.2, 19.3, 19.5
 */

import type {
  FrameHeader,
  VideoConfig,
  VisualObservations,
  GazeBreakdown,
  TranscriptSegment,
} from "./types.js";
import { FrameQueue } from "./frame-queue.js";
import { FrameSampler } from "./frame-sampler.js";
import { createHash } from "crypto";

// ─── Detector Interfaces ────────────────────────────────────────────────────────

export interface FaceDetection {
  landmarks: number[][]; // 6 landmarks: [x, y] pairs
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface PoseDetection {
  keypoints: Array<{
    x: number;
    y: number;
    confidence: number;
    name: string;
  }>;
  confidence: number;
}

export interface FaceDetector {
  detect(
    imageData: Buffer,
    width: number,
    height: number,
  ): Promise<FaceDetection | null>;
}

export interface PoseDetector {
  detect(
    imageData: Buffer,
    width: number,
    height: number,
  ): Promise<PoseDetection | null>;
}

export interface VideoProcessorDeps {
  faceDetector?: FaceDetector;
  poseDetector?: PoseDetector;
}

// ─── Default Config ─────────────────────────────────────────────────────────────

export const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  frameRate: 2,
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
  backpressureOverloadThreshold: 0.2,
  backpressureRecoveryThreshold: 0.1,
  backpressureCooldownMs: 3000,
  frameRetentionWarningThreshold: 0.5,
  motionDeadZoneFraction: 0.0,
  gazeCoverageThreshold: 0.6,
  facialEnergyCoverageThreshold: 0.4,
  gestureCoverageThreshold: 0.3,
  stabilityCoverageThreshold: 0.6,
};

// ─── Utility ────────────────────────────────────────────────────────────────────

/** Round a metric value to the specified number of decimal places. */
export function roundMetric(value: number, precision: number = 4): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

/** Compute a SHA-256 hash of the config for reproducibility tracking. */
function computeConfigHash(config: VideoConfig): string {
  const json = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

// ─── Head Pose Estimation Helpers ────────────────────────────────────────────────

/**
 * Estimate yaw (horizontal head rotation) from BlazeFace 6 landmarks.
 * Landmarks: [0] right eye, [1] left eye, [2] nose, [3] mouth, [4] right ear, [5] left ear.
 * Yaw = atan2(rightDist - leftDist, interEarDist) * (180/π)
 * where rightDist = nose-to-right-ear, leftDist = nose-to-left-ear.
 */
export function estimateYaw(faceLandmarks: number[][]): number {
  const nose = faceLandmarks[2];
  const rightEar = faceLandmarks[4];
  const leftEar = faceLandmarks[5];

  const rightDist = Math.sqrt(
    (nose[0] - rightEar[0]) ** 2 + (nose[1] - rightEar[1]) ** 2,
  );
  const leftDist = Math.sqrt(
    (nose[0] - leftEar[0]) ** 2 + (nose[1] - leftEar[1]) ** 2,
  );
  const interEarDist = Math.sqrt(
    (rightEar[0] - leftEar[0]) ** 2 + (rightEar[1] - leftEar[1]) ** 2,
  );

  if (interEarDist === 0) return 0;

  return Math.atan2(rightDist - leftDist, interEarDist) * (180 / Math.PI);
}

/**
 * Estimate pitch (vertical head tilt) from BlazeFace 6 landmarks.
 * Landmarks: [0] right eye, [1] left eye, [2] nose, [3] mouth, [4] right ear, [5] left ear.
 * Pitch = atan2(noseMouthDist - eyeNoseDist, eyeMouthDist) * (180/π)
 * where noseMouthDist = nose-to-mouth vertical, eyeNoseDist = eye-midpoint-to-nose vertical.
 */
export function estimatePitch(faceLandmarks: number[][]): number {
  const rightEye = faceLandmarks[0];
  const leftEye = faceLandmarks[1];
  const nose = faceLandmarks[2];
  const mouth = faceLandmarks[3];

  const eyeMidY = (rightEye[1] + leftEye[1]) / 2;
  const eyeNoseDist = nose[1] - eyeMidY;
  const noseMouthDist = mouth[1] - nose[1];
  const eyeMouthDist = mouth[1] - eyeMidY;

  if (eyeMouthDist === 0) return 0;

  return (
    Math.atan2(noseMouthDist - eyeNoseDist, eyeMouthDist) * (180 / Math.PI)
  );
}

/**
 * Compute the maximum Euclidean displacement across corresponding hand keypoints
 * between the current and previous frame. Pairs keypoints by index (min of both lengths).
 */
export function computeMaxHandDisplacement(
  currentKeypoints: number[][],
  previousKeypoints: number[][],
): number {
  const pairCount = Math.min(currentKeypoints.length, previousKeypoints.length);
  let maxDisp = 0;
  for (let i = 0; i < pairCount; i++) {
    const dx = currentKeypoints[i][0] - previousKeypoints[i][0];
    const dy = currentKeypoints[i][1] - previousKeypoints[i][1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDisp) maxDisp = dist;
  }
  return maxDisp;
}

// ─── VideoProcessor Class ───────────────────────────────────────────────────────

export class VideoProcessor {
  private config: VideoConfig;
  private frameSampler: FrameSampler;
  private adaptiveSampler: FrameSampler;
  private frameQueue: FrameQueue;
  private deps: VideoProcessorDeps;
  private stopped: boolean;
  private drainLoopRunning: boolean;

  // Accumulation state
  private gazeClassifications: Array<
    "audience-facing" | "notes-facing" | "other"
  >;
  private faceNotDetectedCount: number;
  private gestureEvents: Array<{ timestamp: number }>;
  private previousHandKeypoints: number[][] | null;
  private previousBodyBboxHeight: number | null;
  private bodyCenterHistory: Array<{
    timestamp: number;
    x: number;
    y: number;
  }>;
  private facialEnergyDeltas: number[];
  private previousFaceLandmarks: number[][] | null;
  private framesAnalyzed: number;
  private framesReceived: number;
  private framesSkippedBySampler: number;
  private framesErrored: number;
  private lastFrameWallTime: number;
  private processingLatencies: number[];
  private lastSeq: number;
  private lastProcessedTimestamp: number;
  private lastReceivedTimestamp: number;
  private framesDroppedByTimestamp: number;
  private framesDroppedByFinalizationBudget: number;
  private resolutionChangeCount: number;
  private handsDetectedFrames: number;
  private handsNotDetectedFrames: number;
  private finalizationLatencyMs: number;

  // Resolution tracking
  private lastWidth: number;
  private lastHeight: number;
  private resolutionChangeTimestamps: number[];

  // Adaptive sampling state (hysteresis)
  private isAdaptiveMode: boolean;
  private adaptiveModeStartTime: number;

  // EMA state for gaze smoothing
  private smoothedYaw: number;
  private smoothedPitch: number;
  private emaAlpha: number;
  private lastFaceDetectedTimestamp: number;

  // Frame retention tracking (rolling 5s windows)
  private retentionWindows: Map<
    number,
    { analyzed: number; errored: number; dropped: number }
  >;
  private lowRetentionDetected: boolean;

  // Recording start time for duration computation
  private recordingStartTime: number;

  // Per-frame confidence accumulation (Req 21.1)
  private faceConfidences: number[];
  private poseConfidences: number[];

  // Noise-floor auto-calibration for facial energy (Req 21.4)
  private facialEnergyNoiseFloor: number;
  private noiseFloorCalibrated: boolean;
  private noiseFloorDeltas: number[];

  // Camera placement heuristic (Req 21.6)
  private faceLandmarkAsymmetries: number[];

  constructor(config: VideoConfig, deps: VideoProcessorDeps) {
    this.config = config;
    this.deps = deps;
    this.frameSampler = new FrameSampler(config.frameRate);
    this.adaptiveSampler = new FrameSampler(config.frameRate / 2);
    this.frameQueue = new FrameQueue(config.queueMaxSize);
    this.stopped = false;
    this.drainLoopRunning = false;

    // Accumulation state
    this.gazeClassifications = [];
    this.faceNotDetectedCount = 0;
    this.gestureEvents = [];
    this.previousHandKeypoints = null;
    this.previousBodyBboxHeight = null;
    this.bodyCenterHistory = [];
    this.facialEnergyDeltas = [];
    this.previousFaceLandmarks = null;
    this.framesAnalyzed = 0;
    this.framesReceived = 0;
    this.framesSkippedBySampler = 0;
    this.framesErrored = 0;
    this.lastFrameWallTime = 0;
    this.processingLatencies = [];
    this.lastSeq = -1;
    this.lastProcessedTimestamp = -1;
    this.lastReceivedTimestamp = 0;
    this.framesDroppedByTimestamp = 0;
    this.framesDroppedByFinalizationBudget = 0;
    this.resolutionChangeCount = 0;
    this.handsDetectedFrames = 0;
    this.handsNotDetectedFrames = 0;
    this.finalizationLatencyMs = 0;

    // Resolution tracking
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.resolutionChangeTimestamps = [];

    // Adaptive sampling
    this.isAdaptiveMode = false;
    this.adaptiveModeStartTime = 0;

    // EMA state
    this.smoothedYaw = 0;
    this.smoothedPitch = 0;
    this.emaAlpha = 0.5; // 3-frame effective window at 2 FPS
    this.lastFaceDetectedTimestamp = 0;

    // Frame retention
    this.retentionWindows = new Map();
    this.lowRetentionDetected = false;

    // Recording start
    this.recordingStartTime = Date.now();

    // Per-frame confidence accumulation (Req 21.1)
    this.faceConfidences = [];
    this.poseConfidences = [];

    // Noise-floor auto-calibration for facial energy (Req 21.4)
    this.facialEnergyNoiseFloor = 0;
    this.noiseFloorCalibrated = false;
    this.noiseFloorDeltas = [];

    // Camera placement heuristic (Req 21.6)
    this.faceLandmarkAsymmetries = [];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a frame for processing. Returns immediately (fire-and-forget).
   * Rejects malformed, seq-regressed, timestamp-regressed, and timestamp-jumped
   * frames BEFORE enqueue.
   */
  enqueueFrame(header: FrameHeader, jpegBuffer: Buffer): void {
    this.framesReceived++;
    this.lastFrameWallTime = Date.now();

    // Reject malformed frames — explicit type checks to avoid falsy-zero bugs
    if (
      !header ||
      typeof header.timestamp !== "number" ||
      header.timestamp < 0 ||
      typeof header.seq !== "number" ||
      !Number.isInteger(header.seq) ||
      header.seq < 0 ||
      jpegBuffer.length === 0
    ) {
      this.framesErrored++;
      return;
    }

    // Reject seq regression (non-increasing seq — prevents reordered frames)
    if (this.lastSeq >= 0 && header.seq <= this.lastSeq) {
      this.framesDroppedByTimestamp++;
      return;
    }

    // Reject timestamp regression (non-monotonic)
    if (
      this.lastProcessedTimestamp >= 0 &&
      header.timestamp <= this.lastProcessedTimestamp
    ) {
      this.framesDroppedByTimestamp++;
      return;
    }

    // Reject large timestamp jumps (>2s gap)
    if (
      this.lastProcessedTimestamp >= 0 &&
      header.timestamp - this.lastProcessedTimestamp >
        this.config.staleFrameThresholdSeconds
    ) {
      this.framesDroppedByTimestamp++;
      return;
    }

    // Update tracking for next frame validation
    this.lastSeq = header.seq;
    this.lastProcessedTimestamp = header.timestamp;

    // Track max received timestamp for video-time duration (Req 8.1)
    this.lastReceivedTimestamp = Math.max(this.lastReceivedTimestamp, header.timestamp);

    // Resolution change detection
    if (this.lastWidth > 0 && this.lastHeight > 0) {
      if (header.width !== this.lastWidth || header.height !== this.lastHeight) {
        this.resolutionChangeCount++;
        this.resolutionChangeTimestamps.push(header.timestamp);
        this.resetBaselines();
      }
    }
    this.lastWidth = header.width;
    this.lastHeight = header.height;

    this.frameQueue.enqueue(header, jpegBuffer);
  }

  /** Start the async drain loop. Called once when recording starts. */
  async startDrainLoop(): Promise<void> {
    this.drainLoopRunning = true;
    this.recordingStartTime = Date.now();

    while (this.drainLoopRunning && !this.stopped) {
      const frame = this.frameQueue.dequeue();
      if (!frame) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }

      const effectiveSampler = this.getEffectiveSampler();

      try {
        await this.processFrame(
          frame.header,
          frame.jpegBuffer,
          effectiveSampler,
        );
      } catch {
        this.framesErrored++;
      }
    }
  }

  /**
   * Finalize and return aggregate VisualObservations.
   * Drains remaining queue within 3s budget, then computes aggregates.
   */
  async finalize(
    transcriptSegments?: TranscriptSegment[],
  ): Promise<VisualObservations> {
    const startTime = Date.now();
    const deadline = startTime + this.config.finalizationBudgetMs;
    this.drainLoopRunning = false;

    // Drain remaining queued frames within budget
    while (Date.now() < deadline) {
      const frame = this.frameQueue.dequeue();
      if (!frame) break;
      try {
        await this.processFrame(frame.header, frame.jpegBuffer, this.frameSampler);
      } catch {
        this.framesErrored++;
      }
    }

    // Count remaining frames as dropped by finalization budget
    let remaining = 0;
    while (this.frameQueue.dequeue()) remaining++;
    this.framesDroppedByFinalizationBudget = remaining;
    this.finalizationLatencyMs = Date.now() - startTime;

    return this.computeAggregates(transcriptSegments);
  }

  /** Stop processing. Clears queue, stops drain loop. */
  stop(): void {
    this.stopped = true;
    this.drainLoopRunning = false;
    this.frameQueue.clear();
  }

  /** Get current processing stats for video_status messages. */
  getStatus(): {
    framesProcessed: number;
    framesDropped: number;
    processingLatencyMs: number;
  } {
    const avgLatency =
      this.processingLatencies.length > 0
        ? this.processingLatencies.reduce((a, b) => a + b, 0) /
          this.processingLatencies.length
        : 0;

    return {
      framesProcessed: this.framesAnalyzed,
      framesDropped:
        this.framesSkippedBySampler +
        this.frameQueue.framesDroppedByBackpressure,
      processingLatencyMs: roundMetric(avgLatency, 1),
    };
  }

  /** Get extended processing stats for video_status messages with full counter breakdown. */
  getExtendedStatus(): {
    framesProcessed: number;
    framesDropped: number;
    processingLatencyMs: number;
    framesReceived: number;
    framesSkippedBySampler: number;
    framesDroppedByBackpressure: number;
    framesDroppedByTimestamp: number;
    framesErrored: number;
    effectiveSamplingRate: number;
  } {
    const base = this.getStatus();
    return {
      ...base,
      framesReceived: this.framesReceived,
      framesSkippedBySampler: this.framesSkippedBySampler,
      framesDroppedByBackpressure: this.frameQueue.framesDroppedByBackpressure,
      framesDroppedByTimestamp: this.framesDroppedByTimestamp,
      framesErrored: this.framesErrored,
      effectiveSamplingRate: this.getEffectiveRate(),
    };
  }


  // ─── Internal: Frame Processing ─────────────────────────────────────────────

  /**
   * Process a single frame through the inference pipeline.
   * 1. Check sampler → skip if not selected
   * 2. Call face/pose detectors
   * 3. Classify gaze, detect gestures, compute stability, compute facial energy
   * 4. Accumulate results
   * 5. Record latency
   */
  private async processFrame(
    header: FrameHeader,
    jpegBuffer: Buffer,
    sampler: FrameSampler,
  ): Promise<void> {
    // Step 1: Sampling decision
    if (!sampler.shouldSample(header.timestamp)) {
      this.framesSkippedBySampler++;
      return;
    }

    const startTime = performance.now();

    try {
      // Step 2: Run detectors
      let faceResult: FaceDetection | null = null;
      let poseResult: PoseDetection | null = null;

      if (this.deps.faceDetector) {
        faceResult = await this.deps.faceDetector.detect(
          jpegBuffer,
          header.width,
          header.height,
        );
      }

      if (this.deps.poseDetector) {
        poseResult = await this.deps.poseDetector.detect(
          jpegBuffer,
          header.width,
          header.height,
        );
      }

      // Step 3: Confidence gating
      const faceValid =
        faceResult !== null &&
        faceResult.confidence >= this.config.faceDetectionConfidenceThreshold;
      const poseValid =
        poseResult !== null &&
        poseResult.confidence >= this.config.poseDetectionConfidenceThreshold;

      // Accumulate per-frame confidence for confidence scores (Req 21.1)
      if (faceResult !== null) {
        this.faceConfidences.push(faceResult.confidence);
      }
      if (poseResult !== null) {
        this.poseConfidences.push(poseResult.confidence);
      }

      // Camera placement heuristic: track face landmark asymmetry (Req 21.6)
      if (faceValid && faceResult!.landmarks.length >= 6) {
        const asymmetry = this.computeFaceLandmarkAsymmetry(faceResult!.landmarks, header);
        if (asymmetry !== null) {
          this.faceLandmarkAsymmetries.push(asymmetry);
        }
      }

      // Step 4: Classify gaze direction from face landmarks
      const gazeClass = this.classifyGaze(
        faceValid ? faceResult!.landmarks : null,
        faceValid ? faceResult!.confidence : 0,
        faceValid ? faceResult!.boundingBox : null,
        header,
      );
      this.gazeClassifications.push(gazeClass);

      if (!faceValid && this.deps.faceDetector) {
        this.faceNotDetectedCount++;
      }

      // Step 5: Detect gesture (stub — returns false for now)
      const handKeypoints = poseValid
        ? this.extractHandKeypoints(poseResult!)
        : null;
      const bodyBboxHeight = poseValid
        ? this.extractBodyBboxHeight(poseResult!)
        : 0;

      if (handKeypoints) {
        this.handsDetectedFrames++;
      } else {
        this.handsNotDetectedFrames++;
      }

      const gestureDetected = this.detectGesture(
        handKeypoints,
        this.previousHandKeypoints,
        bodyBboxHeight,
        this.config.gestureDisplacementThreshold,
      );

      if (gestureDetected) {
        this.gestureEvents.push({ timestamp: header.timestamp });
      }

      this.previousHandKeypoints = handKeypoints;
      this.previousBodyBboxHeight = bodyBboxHeight;

      // Step 6: Body stability (stub — empty for now)
      if (poseValid) {
        const center = this.computeBodyCenter(poseResult!, header);
        if (center) {
          this.bodyCenterHistory.push(center);
        }
      }

      // Step 7: Facial energy (stub — returns 0 for now)
      if (faceValid) {
        const energyDelta = this.computeFacialEnergyDelta(
          faceResult!.landmarks,
          this.previousFaceLandmarks,
        );

        // Noise-floor auto-calibration (Req 21.4)
        const calibratedDelta = this.applyNoiseFloorCalibration(energyDelta, header.timestamp);

        this.facialEnergyDeltas.push(calibratedDelta);
        this.previousFaceLandmarks = faceResult!.landmarks;
      }

      // Step 8: Update frame retention tracking
      this.updateRetentionWindow(header.timestamp, true);

      this.framesAnalyzed++;
    } catch {
      this.framesErrored++;
      this.updateRetentionWindow(header.timestamp, false);
      return;
    }

    // Record processing latency (last 10)
    const latency = performance.now() - startTime;
    this.processingLatencies.push(latency);
    if (this.processingLatencies.length > 10) {
      this.processingLatencies.shift();
    }
  }

  // ─── Stub Methods (to be implemented in tasks 4.2, 4.5, 4.8, 4.11) ─────────

  /**
   * Classify gaze direction from face landmarks using head pose estimation.
   * Uses EMA smoothing on yaw/pitch to reduce landmark jitter.
   * Time-based EMA reset when face detection fails for >1 second.
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7
   */
  private classifyGaze(
    faceLandmarks: number[][] | null,
    faceConfidence: number,
    boundingBox: { x: number; y: number; width: number; height: number } | null,
    header: FrameHeader,
  ): "audience-facing" | "notes-facing" | "other" {
    // Compute face area fraction for minimum size check
    const frameArea = header.width * header.height;
    const faceArea =
      boundingBox && frameArea > 0
        ? (boundingBox.width * boundingBox.height) / frameArea
        : 0;

    // Gate: no landmarks, face too small, or confidence too low → "other"
    if (
      !faceLandmarks ||
      faceArea < this.config.minFaceAreaFraction ||
      faceConfidence < this.config.faceDetectionConfidenceThreshold
    ) {
      // Time-based EMA reset: reset if no face for > 1 second
      if (
        this.lastFaceDetectedTimestamp > 0 &&
        header.timestamp - this.lastFaceDetectedTimestamp > 1.0
      ) {
        this.smoothedYaw = 0;
        this.smoothedPitch = 0;
      }
      return "other";
    }

    // Update last face detected timestamp
    this.lastFaceDetectedTimestamp = header.timestamp;

    // Estimate raw yaw and pitch from BlazeFace 6-landmark geometry
    const rawYaw = estimateYaw(faceLandmarks);
    const rawPitch = estimatePitch(faceLandmarks);

    // Apply 3-frame EMA smoothing
    this.smoothedYaw =
      this.emaAlpha * rawYaw + (1 - this.emaAlpha) * this.smoothedYaw;
    this.smoothedPitch =
      this.emaAlpha * rawPitch + (1 - this.emaAlpha) * this.smoothedPitch;

    // Classify based on smoothed angles
    if (
      Math.abs(this.smoothedYaw) <= this.config.gazeYawThreshold &&
      this.smoothedPitch >= this.config.gazePitchThreshold
    ) {
      return "audience-facing";
    }

    if (this.smoothedPitch < this.config.gazePitchThreshold) {
      return "notes-facing";
    }

    return "other";
  }

  /**
   * Detect gesture from hand keypoint displacement.
   * STUB: returns false — full implementation in task 4.5.
   */
  /**
     * Detect gesture from hand keypoint displacement.
     * Normalizes displacement by body bounding box height.
     * Jitter guard: requires both current AND previous frame hand keypoints.
     * Validates: Requirements 4.1, 4.2, 4.6
     */
    private detectGesture(
      currentHandKeypoints: number[][] | null,
      previousHandKeypoints: number[][] | null,
      bodyBboxHeight: number,
      threshold: number,
    ): boolean {
      // Jitter guard: require both current and previous hand keypoints
      // No gesture from isolated detection after hands-not-detected frames
      if (!currentHandKeypoints || !previousHandKeypoints) return false;
      if (bodyBboxHeight <= 0) return false;

      const maxDisplacement = computeMaxHandDisplacement(
        currentHandKeypoints,
        previousHandKeypoints,
      );
      const normalizedDisplacement = maxDisplacement / bodyBboxHeight;
      return normalizedDisplacement > threshold;
    }

  /**
   * Compute body center-of-mass from pose keypoints.
   * STUB: returns null — full implementation in task 4.8.
   */
  /**
     * Compute body center-of-mass from pose keypoints.
     * Uses average of hip keypoints (left_hip, right_hip) from MoveNet,
     * normalized by frame dimensions.
     * Validates: Requirements 5.1, 5.4
     */
    private computeBodyCenter(
      poseResult: PoseDetection,
      header: FrameHeader,
    ): { timestamp: number; x: number; y: number } | null {
      const leftHip = poseResult.keypoints.find(
        (kp) =>
          kp.name === "left_hip" &&
          kp.confidence >= this.config.poseDetectionConfidenceThreshold,
      );
      const rightHip = poseResult.keypoints.find(
        (kp) =>
          kp.name === "right_hip" &&
          kp.confidence >= this.config.poseDetectionConfidenceThreshold,
      );

      if (!leftHip || !rightHip) return null;
      if (header.width <= 0 || header.height <= 0) return null;

      // Normalize by frame dimensions (Req 5.4)
      const x = ((leftHip.x + rightHip.x) / 2) / header.width;
      const y = ((leftHip.y + rightHip.y) / 2) / header.height;

      // Motion dead-zone filter (Req 21.5): ignore displacements below threshold
      if (this.config.motionDeadZoneFraction > 0 && this.bodyCenterHistory.length > 0) {
        const prev = this.bodyCenterHistory[this.bodyCenterHistory.length - 1];
        const dx = x - prev.x;
        const dy = y - prev.y;
        const displacement = Math.sqrt(dx * dx + dy * dy);
        // Threshold is fraction of normalized diagonal (sqrt(2) for unit square)
        const deadZone = this.config.motionDeadZoneFraction * Math.sqrt(2);
        if (displacement < deadZone) {
          // Below dead-zone: snap to previous position to filter posture sway
          return { timestamp: header.timestamp, x: prev.x, y: prev.y };
        }
      }

      return { timestamp: header.timestamp, x, y };
    }

  /**
   * Compute facial energy delta between current and previous landmarks.
   * STUB: returns 0 — full implementation in task 4.11.
   */
  /**
     * Compute facial energy delta between current and previous landmarks.
     * Measures the magnitude of facial landmark movement between consecutive frames:
     * - Mouth openness change (mouth landmark y-position delta)
     * - Eyebrow displacement change (eye landmark y-position delta, averaged)
     * - Head tilt variation (nose-to-eye-midpoint angle delta)
     * BlazeFace 6 landmarks: [0] right eye, [1] left eye, [2] nose, [3] mouth, [4] right ear, [5] left ear
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     */
    private computeFacialEnergyDelta(
      currentLandmarks: number[][],
      previousLandmarks: number[][] | null,
    ): number {
      if (!previousLandmarks) return 0;
      if (currentLandmarks.length < 4 || previousLandmarks.length < 4) return 0;

      // Mouth openness change: delta of mouth y-position (landmark [3])
      const mouthDelta = Math.abs(currentLandmarks[3][1] - previousLandmarks[3][1]);

      // Eyebrow/eye displacement change: average delta of right eye [0] and left eye [1] y-positions
      const rightEyeDelta = Math.abs(currentLandmarks[0][1] - previousLandmarks[0][1]);
      const leftEyeDelta = Math.abs(currentLandmarks[1][1] - previousLandmarks[1][1]);
      const eyebrowDelta = (rightEyeDelta + leftEyeDelta) / 2;

      // Head tilt variation: angle between nose and eye midpoint
      const currEyeMidX = (currentLandmarks[0][0] + currentLandmarks[1][0]) / 2;
      const currEyeMidY = (currentLandmarks[0][1] + currentLandmarks[1][1]) / 2;
      const currAngle = Math.atan2(
        currentLandmarks[2][1] - currEyeMidY,
        currentLandmarks[2][0] - currEyeMidX,
      );

      const prevEyeMidX = (previousLandmarks[0][0] + previousLandmarks[1][0]) / 2;
      const prevEyeMidY = (previousLandmarks[0][1] + previousLandmarks[1][1]) / 2;
      const prevAngle = Math.atan2(
        previousLandmarks[2][1] - prevEyeMidY,
        previousLandmarks[2][0] - prevEyeMidX,
      );

      const headTiltDelta = Math.abs(currAngle - prevAngle);

      // Sum of all deltas
      return mouthDelta + eyebrowDelta + headTiltDelta;
    }

  /** Extract hand keypoints from pose detection result. */
  private extractHandKeypoints(poseResult: PoseDetection): number[][] | null {
    const handNames = [
      "left_wrist",
      "right_wrist",
      "left_elbow",
      "right_elbow",
    ];
    const handKps = poseResult.keypoints.filter(
      (kp) =>
        handNames.includes(kp.name) &&
        kp.confidence >= this.config.poseDetectionConfidenceThreshold,
    );
    return handKps.length > 0 ? handKps.map((kp) => [kp.x, kp.y]) : null;
  }

  /** Extract body bounding box height from pose keypoints. */
  private extractBodyBboxHeight(poseResult: PoseDetection): number {
    const ys = poseResult.keypoints
      .filter(
        (kp) =>
          kp.confidence >= this.config.poseDetectionConfidenceThreshold,
      )
      .map((kp) => kp.y);
    if (ys.length < 2) return 0;
    return Math.max(...ys) - Math.min(...ys);
  }

  // ─── Adaptive Sampling (Hysteresis) ─────────────────────────────────────────

  /** Get the effective sampler based on backpressure state. */
  private getEffectiveSampler(): FrameSampler {
    const eligibleFrames =
      this.framesReceived - this.framesDroppedByTimestamp;
    const backpressureRatio =
      eligibleFrames > 0
        ? this.frameQueue.framesDroppedByBackpressure / eligibleFrames
        : 0;

    if (this.isAdaptiveMode) {
      // In adaptive mode: recover only when below recovery threshold AND cooldown elapsed
      if (
        backpressureRatio < this.config.backpressureRecoveryThreshold &&
        Date.now() - this.adaptiveModeStartTime >
          this.config.backpressureCooldownMs
      ) {
        this.isAdaptiveMode = false;
        return this.frameSampler;
      }
      return this.adaptiveSampler;
    } else {
      // Normal mode: enter adaptive when above overload threshold
      if (backpressureRatio > this.config.backpressureOverloadThreshold) {
        this.isAdaptiveMode = true;
        this.adaptiveModeStartTime = Date.now();
        return this.adaptiveSampler;
      }
      return this.frameSampler;
    }
  }

  // ─── Resolution Change Handling ─────────────────────────────────────────────

  /** Reset normalization baselines and EMA state on resolution change. */
  private resetBaselines(): void {
    // Reset EMA smoothing state
    this.smoothedYaw = 0;
    this.smoothedPitch = 0;
    // Reset previous keypoints (prevents false gesture/energy from cross-resolution)
    this.previousHandKeypoints = null;
    this.previousFaceLandmarks = null;
    this.previousBodyBboxHeight = null;
    // Note: accumulated aggregates (gazeClassifications, gestureEvents, etc.) are preserved
  }

  // ─── Frame Retention Tracking ───────────────────────────────────────────────

  /** Update frame retention tracking for rolling 5s windows. */
  private updateRetentionWindow(
    timestamp: number,
    success: boolean,
  ): void {
    const windowKey = Math.floor(
      timestamp / this.config.stabilityWindowSeconds,
    );

    if (!this.retentionWindows.has(windowKey)) {
      this.retentionWindows.set(windowKey, {
        analyzed: 0,
        errored: 0,
        dropped: 0,
      });
    }

    const window = this.retentionWindows.get(windowKey)!;
    if (success) {
      window.analyzed++;
    } else {
      window.errored++;
    }

    // Check if any window has low retention
    this.checkRetentionThresholds();
  }

  /** Check if frame retention has dropped below threshold in any window. */
  private checkRetentionThresholds(): void {
    for (const [, window] of this.retentionWindows) {
      const total = window.analyzed + window.errored + window.dropped;
      if (total > 0) {
        const retention = window.analyzed / total;
        if (retention < this.config.frameRetentionWarningThreshold) {
          this.lowRetentionDetected = true;
          return;
        }
      }
    }
  }

  // ─── Aggregate Computation ──────────────────────────────────────────────────

  /** Compute final aggregate VisualObservations. */
  private computeAggregates(
    transcriptSegments?: TranscriptSegment[],
  ): VisualObservations {
    const p = this.config.metricRoundingPrecision;

    // Gaze breakdown
    const gazeBreakdown = this.computeGazeBreakdown();

    // Gesture metrics
    const totalGestureCount = this.gestureEvents.length;
    const durationSeconds =
      (Date.now() - this.recordingStartTime) / 1000;
    const durationMinutes = durationSeconds / 60;
    const gestureFrequency =
      durationMinutes > 0
        ? roundMetric(totalGestureCount / durationMinutes, p)
        : 0;

    // Gesture per sentence ratio
    const gesturePerSentenceRatio = this.computeGesturePerSentenceRatio(
      transcriptSegments,
    );

    // Body stability (stub aggregates)
    const { meanStability, stageCrossings, movementClass } =
      this.computeBodyStabilityAggregates();

    // Facial energy (stub aggregates)
    const { meanEnergy, energyVariation, lowSignal } =
      this.computeFacialEnergyAggregates();

    // Video quality grade — use video-time (max frame header timestamp) for expectedSampleCount
    // so camera warmup delay between startRecording() and first frame does not inflate it (Req 8.1, 8.2, 8.5)
    const videoDurationSeconds = this.lastReceivedTimestamp;
    const expectedSampleCount = videoDurationSeconds * this.getEffectiveRate();
    const videoQualityGrade = this.computeVideoQualityGrade(
      expectedSampleCount,
    );

    // Per-metric reliability
    const gazeReliable = this.computeMetricReliability(
      this.gazeClassifications.length - this.faceNotDetectedCount,
      this.config.gazeCoverageThreshold,
    );
    const gestureReliable =
      this.computeMetricReliability(
        this.handsDetectedFrames,
        this.config.gestureCoverageThreshold,
      ) && !this.lowRetentionDetected;
    const stabilityReliable = this.computeMetricReliability(
      this.bodyCenterHistory.length,
      this.config.stabilityCoverageThreshold,
    );
    const facialEnergyReliable = this.computeMetricReliability(
      this.facialEnergyDeltas.length,
      this.config.facialEnergyCoverageThreshold,
    );

    return {
      gazeBreakdown,
      faceNotDetectedCount: this.faceNotDetectedCount,
      totalGestureCount,
      gestureFrequency,
      gesturePerSentenceRatio,
      handsDetectedFrames: this.handsDetectedFrames,
      handsNotDetectedFrames: this.handsNotDetectedFrames,
      meanBodyStabilityScore: roundMetric(meanStability, p),
      stageCrossingCount: stageCrossings,
      movementClassification: movementClass,
      meanFacialEnergyScore: roundMetric(meanEnergy, p),
      facialEnergyVariation: roundMetric(energyVariation, p),
      facialEnergyLowSignal: lowSignal,
      framesAnalyzed: this.framesAnalyzed,
      framesReceived: this.framesReceived,
      framesSkippedBySampler: this.framesSkippedBySampler,
      framesErrored: this.framesErrored,
      framesDroppedByBackpressure:
        this.frameQueue.framesDroppedByBackpressure,
      framesDroppedByTimestamp: this.framesDroppedByTimestamp,
      framesDroppedByFinalizationBudget:
        this.framesDroppedByFinalizationBudget,
      resolutionChangeCount: this.resolutionChangeCount,
      videoQualityGrade,
      videoQualityWarning: videoQualityGrade !== "good",
      finalizationLatencyMs: this.finalizationLatencyMs,
      videoProcessingVersion: this.getVideoProcessingVersion(),
      gazeReliable,
      gestureReliable,
      stabilityReliable,
      facialEnergyReliable,
      capabilities: {
        face: !!this.deps.faceDetector,
        pose: !!this.deps.poseDetector,
      },
      // Optional high-value improvements (Req 21)
      confidenceScores: this.computeConfidenceScores(),
      detectionCoverage: this.computeDetectionCoverage(),
      cameraPlacementWarning: this.computeCameraPlacementWarning() ?? undefined,
    };
  }

  /** Compute gaze breakdown percentages. */
  private computeGazeBreakdown(): GazeBreakdown {
    const p = this.config.metricRoundingPrecision;
    const total = this.gazeClassifications.length;
    if (total === 0) {
      return { audienceFacing: 0, notesFacing: 0, other: 0 };
    }

    const audienceCount = this.gazeClassifications.filter(
      (g) => g === "audience-facing",
    ).length;
    const notesCount = this.gazeClassifications.filter(
      (g) => g === "notes-facing",
    ).length;
    const otherCount = total - audienceCount - notesCount;

    const audienceFacing = roundMetric((audienceCount / total) * 100, p);
    const notesFacing = roundMetric((notesCount / total) * 100, p);
    // Ensure percentages sum to 100 by computing "other" as remainder
    const other = roundMetric(100 - audienceFacing - notesFacing, p);

    return { audienceFacing, notesFacing, other };
  }

  /** Compute gesture per sentence ratio from transcript segments. */
  private computeGesturePerSentenceRatio(
    transcriptSegments?: TranscriptSegment[],
  ): number | null {
    // Suppress when low retention detected
    if (this.lowRetentionDetected) return null;

    if (!transcriptSegments || transcriptSegments.length === 0) return null;

    // Sparse transcript check
    const durationSeconds =
      (Date.now() - this.recordingStartTime) / 1000;
    if (
      transcriptSegments.length < 3 &&
      durationSeconds > 30
    ) {
      return null;
    }

    let segmentsWithGestures = 0;
    for (const segment of transcriptSegments) {
      const hasGesture = this.gestureEvents.some(
        (g) =>
          g.timestamp >= segment.startTime && g.timestamp <= segment.endTime,
      );
      if (hasGesture) segmentsWithGestures++;
    }

    return roundMetric(
      segmentsWithGestures / transcriptSegments.length,
      this.config.metricRoundingPrecision,
    );
  }

  /** Compute body stability aggregates (stub). */
  /**
     * Compute body stability aggregates over rolling 5-second windows.
     * - Body_Stability_Score per window: 1.0 - normalizedMaxDisplacement (clamped [0, 1])
     * - Stage_Crossing: horizontal displacement > 25% frame width between consecutive window centroids
     * - Movement classification from mean score
     * - Excludes windows with fewer than minValidFramesPerWindow frames
     * - Stage crossing detection does NOT bridge across resolution changes
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 19.2
     */
    private computeBodyStabilityAggregates(): {
      meanStability: number;
      stageCrossings: number;
      movementClass: "stationary" | "moderate_movement" | "high_movement";
    } {
      if (this.bodyCenterHistory.length === 0) {
        return {
          meanStability: 1.0,
          stageCrossings: 0,
          movementClass: this.classifyMovement(1.0),
        };
      }

      const windowSeconds = this.config.stabilityWindowSeconds;
      const minFrames = this.config.minValidFramesPerWindow;

      // Group body center history into rolling windows by timestamp
      // Each window covers [windowStart, windowStart + windowSeconds)
      const startTime = this.bodyCenterHistory[0].timestamp;
      const endTime =
        this.bodyCenterHistory[this.bodyCenterHistory.length - 1].timestamp;

      // Build windows
      interface StabilityWindow {
        centers: Array<{ timestamp: number; x: number; y: number }>;
        centroidX: number;
        centroidY: number;
        // Track whether this window spans a resolution change boundary
        spansResolutionChange: boolean;
      }

      const windows: StabilityWindow[] = [];
      let windowStart = startTime;

      while (windowStart <= endTime) {
        const windowEnd = windowStart + windowSeconds;
        const centers = this.bodyCenterHistory.filter(
          (c) => c.timestamp >= windowStart && c.timestamp < windowEnd,
        );

        if (centers.length >= minFrames) {
          const centroidX =
            centers.reduce((sum, c) => sum + c.x, 0) / centers.length;
          const centroidY =
            centers.reduce((sum, c) => sum + c.y, 0) / centers.length;

          // Check if this window spans a resolution change boundary
          const spansResolutionChange =
            this.resolutionChangeTimestamps.some(
              (t) => t > windowStart && t < windowEnd,
            );

          windows.push({
            centers,
            centroidX,
            centroidY,
            spansResolutionChange,
          });
        }

        windowStart += windowSeconds;
      }

      if (windows.length === 0) {
        return {
          meanStability: 1.0,
          stageCrossings: 0,
          movementClass: this.classifyMovement(1.0),
        };
      }

      // Compute stability score per window
      // Score = 1.0 - (maxDisplacement / frameDiagonal), clamped to [0, 1]
      // Use normalized coordinates: diagonal of normalized frame = sqrt(1^2 + 1^2) = sqrt(2)
      const normalizedDiagonal = Math.sqrt(2);
      const scores: number[] = [];

      for (const window of windows) {
        let maxDisplacement = 0;
        for (let i = 1; i < window.centers.length; i++) {
          const dx = window.centers[i].x - window.centers[0].x;
          const dy = window.centers[i].y - window.centers[0].y;
          const displacement = Math.sqrt(dx * dx + dy * dy);
          if (displacement > maxDisplacement) {
            maxDisplacement = displacement;
          }
        }
        const normalizedDisplacement = maxDisplacement / normalizedDiagonal;
        const score = Math.max(0, Math.min(1, 1.0 - normalizedDisplacement));
        scores.push(score);
      }

      // Compute mean stability score
      const meanStability =
        scores.reduce((sum, s) => sum + s, 0) / scores.length;

      // Detect stage crossings between consecutive window centroids
      // Horizontal displacement > stageCrossingThreshold (25% of frame width)
      // Since coordinates are normalized by frame width, threshold applies directly
      // Do NOT bridge across resolution changes
      let stageCrossings = 0;
      for (let i = 1; i < windows.length; i++) {
        // Skip crossing detection if either window spans a resolution change
        // or if there's a resolution change between the two windows
        if (windows[i].spansResolutionChange || windows[i - 1].spansResolutionChange) {
          continue;
        }

        // Check if a resolution change occurred between the two windows
        const prevEnd =
          windows[i - 1].centers[windows[i - 1].centers.length - 1].timestamp;
        const currStart = windows[i].centers[0].timestamp;
        const resChangeBetween = this.resolutionChangeTimestamps.some(
          (t) => t >= prevEnd && t <= currStart,
        );
        if (resChangeBetween) {
          continue;
        }

        const horizontalDisplacement = Math.abs(
          windows[i].centroidX - windows[i - 1].centroidX,
        );
        if (horizontalDisplacement > this.config.stageCrossingThreshold) {
          stageCrossings++;
        }
      }

      const movementClass = this.classifyMovement(meanStability);

      return { meanStability, stageCrossings, movementClass };
    }

  /**
   * Compute facial energy aggregates with per-session min-max normalization.
   * - Normalization only across face-detected frames
   * - Low-signal detection: if variance < epsilon, set mean=0, variation=0, flag lowSignal
   * - Computes mean and coefficient of variation of normalized values
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   */
  private computeFacialEnergyAggregates(): {
    meanEnergy: number;
    energyVariation: number;
    lowSignal: boolean;
  } {
    if (this.facialEnergyDeltas.length === 0) {
      return { meanEnergy: 0, energyVariation: 0, lowSignal: true };
    }

    const mean =
      this.facialEnergyDeltas.reduce((a, b) => a + b, 0) /
      this.facialEnergyDeltas.length;

    // Compute variance
    const variance =
      this.facialEnergyDeltas.reduce(
        (sum, d) => sum + (d - mean) ** 2,
        0,
      ) / this.facialEnergyDeltas.length;

    const lowSignal = variance < this.config.facialEnergyEpsilon;

    if (lowSignal) {
      return { meanEnergy: 0, energyVariation: 0, lowSignal: true };
    }

    // Min-max normalization
    const min = Math.min(...this.facialEnergyDeltas);
    const max = Math.max(...this.facialEnergyDeltas);
    const range = max - min;

    if (range === 0) {
      return { meanEnergy: 0, energyVariation: 0, lowSignal: true };
    }

    const normalized = this.facialEnergyDeltas.map((d) => (d - min) / range);
    const normalizedMean =
      normalized.reduce((a, b) => a + b, 0) / normalized.length;
    const normalizedVariance =
      normalized.reduce((sum, d) => sum + (d - normalizedMean) ** 2, 0) /
      normalized.length;
    const stdDev = Math.sqrt(normalizedVariance);
    const cv = normalizedMean > 0 ? stdDev / normalizedMean : 0;

    return {
      meanEnergy: normalizedMean,
      energyVariation: cv,
      lowSignal: false,
    };
  }

  /** Classify movement from mean stability score. */
  private classifyMovement(
    meanScore: number,
  ): "stationary" | "moderate_movement" | "high_movement" {
    if (meanScore >= 0.85) return "stationary";
    if (meanScore >= 0.5) return "moderate_movement";
    return "high_movement";
  }

  /** Compute per-metric reliability based on coverage. */
  private computeMetricReliability(
    validFrames: number,
    coverageThreshold: number,
  ): boolean {
    if (this.framesAnalyzed === 0) return false;
    const coverage = validFrames / this.framesAnalyzed;
    return coverage >= coverageThreshold;
  }

  /** Get effective sampling rate (accounting for adaptive mode). */
  private getEffectiveRate(): number {
    return this.isAdaptiveMode
      ? this.config.frameRate / 2
      : this.config.frameRate;
  }

  // ─── Video Quality Grading ──────────────────────────────────────────────────

  /**
   * Compute video quality grade based on frame analysis rate and face detection rate.
   * "good": ≥80% of expected samples AND face ≥60% AND no camera drop
   * "degraded": 50-79% OR camera drop recovered OR face 30-59%
   * "poor": <50% OR face <30%
   */
  private computeVideoQualityGrade(
      expectedSampleCount: number,
    ): "good" | "degraded" | "poor" {
      if (expectedSampleCount <= 0) return "poor";

      // No detectors guard — no meaningful analysis possible
      if (!this.deps.faceDetector && !this.deps.poseDetector) return "poor";

      const analysisRate = Math.min(1, this.framesAnalyzed / expectedSampleCount);

      // Camera drop detection
      const cameraDropDetected =
        this.lastFrameWallTime > 0 &&
        Date.now() - this.lastFrameWallTime >
          this.config.cameraDropTimeoutSeconds * 1000;

      if (this.deps.faceDetector) {
        // With face detector: preserve existing dual-metric logic
        const faceDetectedFrames =
          this.gazeClassifications.length - this.faceNotDetectedCount;
        const faceDetectionRate =
          this.framesAnalyzed > 0
            ? faceDetectedFrames / this.framesAnalyzed
            : 0;

        // Poor conditions
        if (analysisRate < 0.5 || faceDetectionRate < 0.3) {
          return "poor";
        }

        // Good conditions
        if (
          analysisRate >= 0.8 &&
          faceDetectionRate >= 0.6 &&
          !cameraDropDetected
        ) {
          return "good";
        }

        // Everything else is degraded
        return "degraded";
      }

      // Without face detector (pose-only mode): grade on analysisRate + cameraDrop only
      if (analysisRate < 0.5) {
        return "poor";
      }

      if (analysisRate >= 0.8 && !cameraDropDetected) {
        return "good";
      }

      return "degraded";
    }

  // ─── Video Processing Version ───────────────────────────────────────────────

  /** Get the video processing version tuple for reproducibility. */
  private getVideoProcessingVersion(): VisualObservations["videoProcessingVersion"] {
    return {
      tfjsVersion: "stub",
      tfjsBackend: "stub",
      modelVersions: { blazeface: "stub", movenet: "stub" },
      configHash: computeConfigHash(this.config),
    };
  }

  // ─── Optional High-Value Improvements (Req 21) ─────────────────────────────

  /**
   * Compute per-metric confidence scores (Req 21.1).
   * Derived from detection model confidence and frame coverage.
   */
  private computeConfidenceScores(): {
    gaze: number;
    gesture: number;
    stability: number;
    facialEnergy: number;
  } {
    const p = this.config.metricRoundingPrecision;

    // Gaze confidence: mean face detection confidence × gaze coverage
    const gazeCoverage =
      this.framesAnalyzed > 0
        ? (this.gazeClassifications.length - this.faceNotDetectedCount) /
          this.framesAnalyzed
        : 0;
    const meanFaceConf =
      this.faceConfidences.length > 0
        ? this.faceConfidences.reduce((a, b) => a + b, 0) /
          this.faceConfidences.length
        : 0;
    const gazeConfidence = roundMetric(
      Math.min(1, meanFaceConf * gazeCoverage),
      p,
    );

    // Gesture confidence: mean pose confidence × gesture coverage
    const gestureCoverage =
      this.framesAnalyzed > 0
        ? this.handsDetectedFrames / this.framesAnalyzed
        : 0;
    const meanPoseConf =
      this.poseConfidences.length > 0
        ? this.poseConfidences.reduce((a, b) => a + b, 0) /
          this.poseConfidences.length
        : 0;
    const gestureConfidence = roundMetric(
      Math.min(1, meanPoseConf * gestureCoverage),
      p,
    );

    // Stability confidence: mean pose confidence × stability coverage
    const stabilityCoverage =
      this.framesAnalyzed > 0
        ? this.bodyCenterHistory.length / this.framesAnalyzed
        : 0;
    const stabilityConfidence = roundMetric(
      Math.min(1, meanPoseConf * stabilityCoverage),
      p,
    );

    // Facial energy confidence: mean face confidence × facial energy coverage
    const facialEnergyCoverage =
      this.framesAnalyzed > 0
        ? this.facialEnergyDeltas.length / this.framesAnalyzed
        : 0;
    const facialEnergyConfidence = roundMetric(
      Math.min(1, meanFaceConf * facialEnergyCoverage),
      p,
    );

    return {
      gaze: gazeConfidence,
      gesture: gestureConfidence,
      stability: stabilityConfidence,
      facialEnergy: facialEnergyConfidence,
    };
  }

  /**
   * Compute per-metric detection coverage percentages (Req 21.2).
   * Fraction of analyzed frames where the relevant detector succeeded.
   */
  private computeDetectionCoverage(): {
    gaze: number;
    gesture: number;
    stability: number;
    facialEnergy: number;
  } {
    const p = this.config.metricRoundingPrecision;
    const total = this.framesAnalyzed;
    if (total === 0) {
      return { gaze: 0, gesture: 0, stability: 0, facialEnergy: 0 };
    }

    return {
      gaze: roundMetric(
        (this.gazeClassifications.length - this.faceNotDetectedCount) / total,
        p,
      ),
      gesture: roundMetric(this.handsDetectedFrames / total, p),
      stability: roundMetric(this.bodyCenterHistory.length / total, p),
      facialEnergy: roundMetric(this.facialEnergyDeltas.length / total, p),
    };
  }

  /**
   * Noise-floor auto-calibration for facial energy (Req 21.4).
   * Computes noise floor during first 3 seconds, subtracts from subsequent measurements.
   */
  private applyNoiseFloorCalibration(
    energyDelta: number,
    timestamp: number,
  ): number {
    // During first 3 seconds: accumulate noise floor samples
    if (timestamp <= 3.0) {
      this.noiseFloorDeltas.push(energyDelta);
      return energyDelta; // Return raw during calibration period
    }

    // Calibrate noise floor once after 3-second window
    if (!this.noiseFloorCalibrated && this.noiseFloorDeltas.length > 0) {
      this.facialEnergyNoiseFloor =
        this.noiseFloorDeltas.reduce((a, b) => a + b, 0) /
        this.noiseFloorDeltas.length;
      this.noiseFloorCalibrated = true;
    }

    // Subtract noise floor, clamp to 0
    return Math.max(0, energyDelta - this.facialEnergyNoiseFloor);
  }

  /**
   * Compute face landmark asymmetry for camera placement heuristic (Req 21.6).
   * Returns estimated angle in degrees from frontal based on ear-to-nose ratios.
   */
  private computeFaceLandmarkAsymmetry(
    landmarks: number[][],
    header: FrameHeader,
  ): number | null {
    // BlazeFace 6 landmarks: [rightEye, leftEye, nose, mouth, rightEar, leftEar]
    if (landmarks.length < 6) return null;
    const nose = landmarks[2];
    const rightEar = landmarks[4];
    const leftEar = landmarks[5];

    if (!nose || !rightEar || !leftEar) return null;
    if (header.width <= 0) return null;

    const noseToRight = Math.abs(nose[0] - rightEar[0]);
    const noseToLeft = Math.abs(nose[0] - leftEar[0]);
    const interEar = Math.abs(leftEar[0] - rightEar[0]);

    if (interEar === 0) return null;

    // Asymmetry ratio: 0 = perfectly frontal, higher = more off-axis
    const asymmetryRatio = Math.abs(noseToRight - noseToLeft) / interEar;
    // Convert to approximate angle (atan of asymmetry ratio)
    const angleDeg =
      Math.atan(asymmetryRatio) * (180 / Math.PI);

    return angleDeg;
  }

  /**
   * Compute camera placement warning from accumulated asymmetries (Req 21.6).
   */
  private computeCameraPlacementWarning(): {
    estimatedAngleDeg: number;
    isFrontal: boolean;
    warning?: string;
  } | null {
    if (this.faceLandmarkAsymmetries.length === 0) return null;

    const p = this.config.metricRoundingPrecision;
    const meanAngle = roundMetric(
      this.faceLandmarkAsymmetries.reduce((a, b) => a + b, 0) /
        this.faceLandmarkAsymmetries.length,
      p,
    );
    const isFrontal = meanAngle <= 30;

    return {
      estimatedAngleDeg: meanAngle,
      isFrontal,
      ...(isFrontal
        ? {}
        : {
            warning: `Camera appears to be ${meanAngle.toFixed(0)}° off-axis from frontal. Gaze direction accuracy may be reduced.`,
          }),
    };
  }
}
