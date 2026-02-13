/**
 * Unit tests for face counter guards and capabilities (task 12)
 *
 * 12.1: faceNotDetectedCount remains 0 without face detector (Req 4.1)
 * 12.2: capabilities.face and capabilities.pose reflect deps configuration (Req 5.1, 5.2, 5.3)
 * 12.3: EvaluationGenerator.buildUserPrompt excludes gaze/facial energy when capabilities.face === false (Req 5.4, 6.3)
 * 12.4: lastReceivedTimestamp tracks max frame header timestamp across all received frames (Req 8.1)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  VideoProcessor,
  DEFAULT_VIDEO_CONFIG,
  type FaceDetector,
  type PoseDetector,
  type FaceDetection,
  type PoseDetection,
  type VideoProcessorDeps,
} from "./video-processor.js";
import { EvaluationGenerator, type OpenAIClient } from "./evaluation-generator.js";
import type {
  FrameHeader,
  VideoConfig,
  VisualObservations,
  TranscriptSegment,
  DeliveryMetrics,
} from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeHeader(
  seq: number,
  timestamp?: number,
  width = 640,
  height = 480,
): FrameHeader {
  return {
    timestamp: timestamp ?? seq * 0.5,
    seq,
    width,
    height,
  };
}

function makeJpeg(size = 16): Buffer {
  return Buffer.alloc(size, 0xff);
}

function makeConfig(overrides?: Partial<VideoConfig>): VideoConfig {
  return { ...DEFAULT_VIDEO_CONFIG, ...overrides };
}

function makeFaceDetector(confidence = 0.9): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [
        [100, 100], [200, 100], [150, 150],
        [150, 200], [80, 130], [220, 130],
      ],
      boundingBox: { x: 80, y: 80, width: 160, height: 160 },
      confidence,
    } satisfies FaceDetection),
  };
}

function makePoseDetector(confidence = 0.8): PoseDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      keypoints: [
        { x: 150, y: 100, confidence: 0.9, name: "nose" },
        { x: 130, y: 120, confidence: 0.8, name: "left_shoulder" },
        { x: 170, y: 120, confidence: 0.8, name: "right_shoulder" },
        { x: 120, y: 200, confidence: 0.7, name: "left_wrist" },
        { x: 180, y: 200, confidence: 0.7, name: "right_wrist" },
        { x: 125, y: 160, confidence: 0.7, name: "left_elbow" },
        { x: 175, y: 160, confidence: 0.7, name: "right_elbow" },
        { x: 140, y: 300, confidence: 0.6, name: "left_hip" },
        { x: 160, y: 300, confidence: 0.6, name: "right_hip" },
      ],
      confidence,
    } satisfies PoseDetection),
  };
}

/** Create a mock face detector that always returns low confidence (face not detected). */
function makeLowConfidenceFaceDetector(): FaceDetector {
  return {
    detect: vi.fn().mockResolvedValue({
      landmarks: [[100, 100], [200, 100], [150, 150], [150, 200], [80, 130], [220, 130]],
      boundingBox: { x: 80, y: 80, width: 160, height: 160 },
      confidence: 0.1, // below default threshold of 0.5
    } satisfies FaceDetection),
  };
}

function makeVisualObservations(overrides?: Partial<VisualObservations>): VisualObservations {
  return {
    gazeBreakdown: { audienceFacing: 65, notesFacing: 25, other: 10 },
    faceNotDetectedCount: 2,
    totalGestureCount: 12,
    gestureFrequency: 7.6,
    gesturePerSentenceRatio: 0.6,
    handsDetectedFrames: 80,
    handsNotDetectedFrames: 20,
    meanBodyStabilityScore: 0.82,
    stageCrossingCount: 1,
    movementClassification: "moderate_movement",
    meanFacialEnergyScore: 0.45,
    facialEnergyVariation: 0.3,
    facialEnergyLowSignal: false,
    framesAnalyzed: 100,
    framesReceived: 120,
    framesSkippedBySampler: 10,
    framesErrored: 2,
    framesDroppedByBackpressure: 5,
    framesDroppedByTimestamp: 3,
    framesDroppedByFinalizationBudget: 0,
    resolutionChangeCount: 0,
    videoQualityGrade: "good",
    videoQualityWarning: false,
    finalizationLatencyMs: 150,
    videoProcessingVersion: {
      tfjsVersion: "4.0.0",
      tfjsBackend: "cpu",
      modelVersions: { blazeface: "1.0.0", movenet: "1.0.0" },
      configHash: "abc123",
    },
    gazeReliable: true,
    gestureReliable: true,
    stabilityReliable: true,
    facialEnergyReliable: true,
    capabilities: { face: true, pose: true },
    ...overrides,
  };
}

function makeMockClient(responses: string[]): OpenAIClient {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => ({
          choices: [{ message: { content: responses[callIndex++] ?? "{}" } }],
        })),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({ data: [{ embedding: [] }] }),
    },
  };
}

function makeTranscriptSegments(): TranscriptSegment[] {
  return [
    {
      text: "Today I want to talk about the moment I realized everything had changed and how it shaped my perspective on leadership",
      startTime: 0,
      endTime: 10,
      confidence: 0.95,
      words: [
        { word: "Today", startTime: 0, endTime: 0.5, confidence: 0.95 },
        { word: "I", startTime: 0.5, endTime: 0.6, confidence: 0.95 },
        { word: "want", startTime: 0.6, endTime: 0.8, confidence: 0.95 },
        { word: "to", startTime: 0.8, endTime: 0.9, confidence: 0.95 },
        { word: "talk", startTime: 0.9, endTime: 1.1, confidence: 0.95 },
        { word: "about", startTime: 1.1, endTime: 1.3, confidence: 0.95 },
        { word: "the", startTime: 1.3, endTime: 1.4, confidence: 0.95 },
        { word: "moment", startTime: 1.4, endTime: 1.7, confidence: 0.95 },
        { word: "I", startTime: 1.7, endTime: 1.8, confidence: 0.95 },
        { word: "realized", startTime: 1.8, endTime: 2.2, confidence: 0.95 },
        { word: "everything", startTime: 2.2, endTime: 2.7, confidence: 0.95 },
        { word: "had", startTime: 2.7, endTime: 2.9, confidence: 0.95 },
        { word: "changed", startTime: 2.9, endTime: 3.3, confidence: 0.95 },
      ],
    },
  ];
}

function makeMetrics(): DeliveryMetrics {
  return {
    durationSeconds: 95,
    wordCount: 150,
    wordsPerMinute: 142,
    fillerWordCount: 3,
    fillerWordsPerMinute: 1.9,
    fillerWords: [],
    classifiedFillerWords: [],
    pauseCount: 5,
    averagePauseDuration: 1.2,
    longestPauseDuration: 2.5,
    classifiedPauses: [],
    energyProfile: { mean: 0.6, variance: 0.04, low: 0.3, high: 0.9 },
  };
}

// ─── 12.1: faceNotDetectedCount remains 0 without face detector (Req 4.1) ────

describe("faceNotDetectedCount without face detector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remains 0 after processing frames without face detector (pose-only mode)", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue several frames
    for (let i = 1; i <= 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    const obs = await vp.finalize();

    expect(obs.faceNotDetectedCount).toBe(0);
    expect(obs.framesAnalyzed).toBeGreaterThan(0);
  });

  it("remains 0 even with many frames when no face detector is configured", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue 20 frames
    for (let i = 1; i <= 20; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    const obs = await vp.finalize();

    expect(obs.faceNotDetectedCount).toBe(0);
  });

  it("increments faceNotDetectedCount when face detector IS configured but face not detected", async () => {
    // Regression: with a face detector that returns low confidence, faceNotDetectedCount should increment
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = {
      faceDetector: makeLowConfidenceFaceDetector(),
      poseDetector: makePoseDetector(),
    };
    const vp = new VideoProcessor(config, deps);

    for (let i = 1; i <= 5; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    const obs = await vp.finalize();

    // With a low-confidence face detector, every frame should increment faceNotDetectedCount
    expect(obs.faceNotDetectedCount).toBeGreaterThan(0);
    expect(obs.faceNotDetectedCount).toBe(obs.framesAnalyzed);
  });
});

// ─── 12.2: capabilities reflect deps configuration (Req 5.1, 5.2, 5.3) ──────

describe("capabilities reflect deps configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("capabilities.face=true, capabilities.pose=true when both detectors configured", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = {
      faceDetector: makeFaceDetector(),
      poseDetector: makePoseDetector(),
    };
    const vp = new VideoProcessor(config, deps);

    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.capabilities.face).toBe(true);
    expect(obs.capabilities.pose).toBe(true);
  });

  it("capabilities.face=false, capabilities.pose=true when only pose detector configured", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.capabilities.face).toBe(false);
    expect(obs.capabilities.pose).toBe(true);
  });

  it("capabilities.face=true, capabilities.pose=false when only face detector configured", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { faceDetector: makeFaceDetector() };
    const vp = new VideoProcessor(config, deps);

    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.capabilities.face).toBe(true);
    expect(obs.capabilities.pose).toBe(false);
  });

  it("capabilities.face=false, capabilities.pose=false when no detectors configured", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = {};
    const vp = new VideoProcessor(config, deps);

    vp.enqueueFrame(makeHeader(1, 0.5), makeJpeg());
    const obs = await vp.finalize();

    expect(obs.capabilities.face).toBe(false);
    expect(obs.capabilities.pose).toBe(false);
  });
});

// ─── 12.3: buildUserPrompt excludes gaze/facial energy when capabilities.face === false (Req 5.4, 6.3) ──

describe("EvaluationGenerator.buildUserPrompt excludes face metrics when capabilities.face === false", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("excludes gazeBreakdown, faceNotDetectedCount, and facial energy metrics when capabilities.face === false", async () => {
    const visualObs = makeVisualObservations({
      capabilities: { face: false, pose: true },
      videoQualityGrade: "good",
      videoQualityWarning: false,
      gazeReliable: true,
      facialEnergyReliable: true,
    });

    const evaluation = {
      opening: "Thank you for that wonderful speech.",
      items: [
        {
          type: "commendation" as const,
          summary: "Strong opening",
          explanation: "When you said 'the moment I realized everything had changed,' the audience leaned in.",
          evidence_quote: "the moment I realized everything had changed",
          evidence_timestamp: 1.4,
        },
        {
          type: "commendation" as const,
          summary: "Good pace",
          explanation: "You maintained a steady pace throughout.",
          evidence_quote: "Today I want to talk about the moment",
          evidence_timestamp: 0,
        },
        {
          type: "recommendation" as const,
          summary: "Add pauses",
          explanation: "Try pausing after key points.",
          evidence_quote: "I realized everything had changed and how",
          evidence_timestamp: 1.8,
        },
      ],
      closing: "Keep up the great work!",
    };
    const response = JSON.stringify(evaluation);
    const client = makeMockClient([response]);
    const generator = new EvaluationGenerator(client);
    const segments = makeTranscriptSegments();
    const metrics = makeMetrics();

    await generator.generate(segments, metrics, undefined, visualObs);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userPrompt: string = call.messages[1].content;

    // Visual Observations section should still be present (grade is "good")
    expect(userPrompt).toContain("Visual Observations");

    // Face-dependent metrics MUST be excluded when capabilities.face === false
    expect(userPrompt).not.toContain("audienceFacing");
    expect(userPrompt).not.toContain("notesFacing");
    expect(userPrompt).not.toContain("faceNotDetectedCount");
    expect(userPrompt).not.toContain("meanFacialEnergyScore");
    expect(userPrompt).not.toContain("facialEnergyVariation");

    // Pose-based metrics should still be included (when reliable)
    expect(userPrompt).toContain("framesAnalyzed");
    expect(userPrompt).toContain("videoQualityGrade");
  });

  it("includes gaze and facial energy metrics when capabilities.face === true", async () => {
    const visualObs = makeVisualObservations({
      capabilities: { face: true, pose: true },
      videoQualityGrade: "good",
      videoQualityWarning: false,
      gazeReliable: true,
      facialEnergyReliable: true,
    });

    const evaluation = {
      opening: "Thank you for that wonderful speech.",
      items: [
        {
          type: "commendation" as const,
          summary: "Strong opening",
          explanation: "When you said 'the moment I realized everything had changed,' the audience leaned in.",
          evidence_quote: "the moment I realized everything had changed",
          evidence_timestamp: 1.4,
        },
        {
          type: "commendation" as const,
          summary: "Good pace",
          explanation: "You maintained a steady pace throughout.",
          evidence_quote: "Today I want to talk about the moment",
          evidence_timestamp: 0,
        },
        {
          type: "recommendation" as const,
          summary: "Add pauses",
          explanation: "Try pausing after key points.",
          evidence_quote: "I realized everything had changed and how",
          evidence_timestamp: 1.8,
        },
      ],
      closing: "Keep up the great work!",
    };
    const response = JSON.stringify(evaluation);
    const client = makeMockClient([response]);
    const generator = new EvaluationGenerator(client);
    const segments = makeTranscriptSegments();
    const metrics = makeMetrics();

    await generator.generate(segments, metrics, undefined, visualObs);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userPrompt: string = call.messages[1].content;

    // Face metrics should be included when capabilities.face === true and reliable
    expect(userPrompt).toContain("audienceFacing");
    expect(userPrompt).toContain("faceNotDetectedCount");
    expect(userPrompt).toContain("meanFacialEnergyScore");
    expect(userPrompt).toContain("facialEnergyVariation");
  });
});

// ─── 12.4: lastReceivedTimestamp tracks max frame header timestamp (Req 8.1) ──

describe("lastReceivedTimestamp tracks max frame header timestamp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks the maximum timestamp across all received frames", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue frames with increasing timestamps
    vp.enqueueFrame(makeHeader(1, 1.0), makeJpeg());
    vp.enqueueFrame(makeHeader(2, 2.0), makeJpeg());
    vp.enqueueFrame(makeHeader(3, 3.5), makeJpeg());

    // Access lastReceivedTimestamp via internal state
    expect((vp as any).lastReceivedTimestamp).toBe(3.5);
  });

  it("tracks max timestamp even for frames rejected by sampler", async () => {
    // Use a very low frame rate so the sampler skips most frames
    const config = makeConfig({
      frameRate: 0.5, // very low — will skip many frames
      staleFrameThresholdSeconds: 100,
    });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue frames at 0.1s intervals — sampler will skip most
    for (let i = 1; i <= 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.1), makeJpeg());
    }

    // lastReceivedTimestamp should be the max timestamp regardless of sampling
    expect((vp as any).lastReceivedTimestamp).toBe(1.0);
  });

  it("uses lastReceivedTimestamp for expectedSampleCount in finalize", async () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue frames — last timestamp is 5.0
    for (let i = 1; i <= 10; i++) {
      vp.enqueueFrame(makeHeader(i, i * 0.5), makeJpeg());
    }

    expect((vp as any).lastReceivedTimestamp).toBe(5.0);

    // Finalize and verify the grade uses video-time, not wall-clock
    const obs = await vp.finalize();

    // With 10 frames analyzed and expectedSampleCount = 5.0 * 2 (frameRate) = 10,
    // analysisRate = 10/10 = 1.0 → "good"
    expect(obs.videoQualityGrade).toBe("good");
  });

  it("does not update lastReceivedTimestamp for malformed frames", () => {
    const config = makeConfig({ staleFrameThresholdSeconds: 100 });
    const deps: VideoProcessorDeps = { poseDetector: makePoseDetector() };
    const vp = new VideoProcessor(config, deps);

    // Enqueue a valid frame
    vp.enqueueFrame(makeHeader(1, 1.0), makeJpeg());
    expect((vp as any).lastReceivedTimestamp).toBe(1.0);

    // Enqueue a malformed frame (empty buffer)
    vp.enqueueFrame(makeHeader(2, 5.0), Buffer.alloc(0));

    // lastReceivedTimestamp should NOT advance for malformed frames
    expect((vp as any).lastReceivedTimestamp).toBe(1.0);
  });
});
