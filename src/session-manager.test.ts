// Unit tests for SessionManager
// Validates: Requirements 1.1, 1.2, 1.4, 1.6, 1.8

import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";
import { Session, SessionState } from "./types.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  // ─── createSession ──────────────────────────────────────────────────────────

  describe("createSession()", () => {
    it("returns a session in IDLE state with runId=0", () => {
      const session = manager.createSession();

      expect(session.state).toBe(SessionState.IDLE);
      expect(session.runId).toBe(0);
    });

    it("initializes all session fields correctly", () => {
      const session = manager.createSession();

      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.startedAt).toBeNull();
      expect(session.stoppedAt).toBeNull();
      expect(session.transcript).toEqual([]);
      expect(session.liveTranscript).toEqual([]);
      expect(session.audioChunks).toEqual([]);
      expect(session.metrics).toBeNull();
      expect(session.evaluation).toBeNull();
      expect(session.evaluationScript).toBeNull();
      expect(session.qualityWarning).toBe(false);
      expect(session.outputsSaved).toBe(false);
    });

    it("creates sessions with unique IDs", () => {
      const session1 = manager.createSession();
      const session2 = manager.createSession();

      expect(session1.id).not.toBe(session2.id);
    });
  });

  // ─── getSession ─────────────────────────────────────────────────────────────

  describe("getSession()", () => {
    it("retrieves an existing session by ID", () => {
      const created = manager.createSession();
      const retrieved = manager.getSession(created.id);

      expect(retrieved).toBe(created);
    });

    it("throws for a non-existent session ID", () => {
      expect(() => manager.getSession("non-existent-id")).toThrow(
        "Session not found: non-existent-id",
      );
    });
  });

  // ─── Valid state transitions (full lifecycle) ───────────────────────────────

  describe("valid state transitions", () => {
    it("transitions IDLE → RECORDING via startRecording()", () => {
      const session = manager.createSession();

      manager.startRecording(session.id);

      expect(session.state).toBe(SessionState.RECORDING);
    });

    it("transitions RECORDING → PROCESSING via stopRecording()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      await manager.stopRecording(session.id);

      expect(session.state).toBe(SessionState.PROCESSING);
    });

    it("transitions PROCESSING → DELIVERING via generateEvaluation()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);

      await manager.generateEvaluation(session.id);

      expect(session.state).toBe(SessionState.DELIVERING);
    });

    it("transitions DELIVERING → IDLE via completeDelivery()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);

      manager.completeDelivery(session.id);

      expect(session.state).toBe(SessionState.IDLE);
    });

    it("completes a full lifecycle: IDLE → RECORDING → PROCESSING → DELIVERING → IDLE", async () => {
      const session = manager.createSession();
      expect(session.state).toBe(SessionState.IDLE);

      manager.startRecording(session.id);
      expect(session.state).toBe(SessionState.RECORDING);

      await manager.stopRecording(session.id);
      expect(session.state).toBe(SessionState.PROCESSING);

      await manager.generateEvaluation(session.id);
      expect(session.state).toBe(SessionState.DELIVERING);

      manager.completeDelivery(session.id);
      expect(session.state).toBe(SessionState.IDLE);
    });

    it("sets startedAt when recording starts", () => {
      const session = manager.createSession();
      const before = new Date();

      manager.startRecording(session.id);

      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session.startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("sets stoppedAt when recording stops", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      const before = new Date();

      await manager.stopRecording(session.id);

      expect(session.stoppedAt).toBeInstanceOf(Date);
      expect(session.stoppedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  // ─── Invalid state transitions ─────────────────────────────────────────────

  describe("invalid state transitions", () => {
    it("throws when calling startRecording() from RECORDING state", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      expect(() => manager.startRecording(session.id)).toThrow(/cannot call startRecording\(\)/);
      expect(() => manager.startRecording(session.id)).toThrow(/Current state: "recording"/);
    });

    it("throws when calling startRecording() from PROCESSING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);

      expect(() => manager.startRecording(session.id)).toThrow(/cannot call startRecording\(\)/);
      expect(() => manager.startRecording(session.id)).toThrow(/Current state: "processing"/);
    });

    it("throws when calling startRecording() from DELIVERING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);

      expect(() => manager.startRecording(session.id)).toThrow(/cannot call startRecording\(\)/);
      expect(() => manager.startRecording(session.id)).toThrow(/Current state: "delivering"/);
    });

    it("throws when calling stopRecording() from IDLE state", async () => {
      const session = manager.createSession();

      await expect(() => manager.stopRecording(session.id)).rejects.toThrow(/cannot call stopRecording\(\)/);
    });

    it("throws when calling stopRecording() from PROCESSING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);

      await expect(() => manager.stopRecording(session.id)).rejects.toThrow(
        /cannot call stopRecording\(\)/,
      );
    });

    it("throws when calling stopRecording() from DELIVERING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);

      await expect(() => manager.stopRecording(session.id)).rejects.toThrow(
        /cannot call stopRecording\(\)/,
      );
    });

    it("throws when calling generateEvaluation() from IDLE state", async () => {
      const session = manager.createSession();

      await expect(() => manager.generateEvaluation(session.id)).rejects.toThrow(
        /cannot call generateEvaluation\(\)/,
      );
    });

    it("throws when calling generateEvaluation() from RECORDING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      await expect(() => manager.generateEvaluation(session.id)).rejects.toThrow(
        /cannot call generateEvaluation\(\)/,
      );
    });

    it("throws when calling generateEvaluation() from DELIVERING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);

      await expect(() => manager.generateEvaluation(session.id)).rejects.toThrow(
        /cannot call generateEvaluation\(\)/,
      );
    });

    it("throws when calling completeDelivery() from IDLE state", () => {
      const session = manager.createSession();

      expect(() => manager.completeDelivery(session.id)).toThrow(
        /cannot call completeDelivery\(\)/,
      );
    });

    it("throws when calling completeDelivery() from RECORDING state", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      expect(() => manager.completeDelivery(session.id)).toThrow(
        /cannot call completeDelivery\(\)/,
      );
    });

    it("throws when calling completeDelivery() from PROCESSING state", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);

      expect(() => manager.completeDelivery(session.id)).toThrow(
        /cannot call completeDelivery\(\)/,
      );
    });

    it("includes descriptive error messages with method name, expected state, and current state", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      try {
        manager.startRecording(session.id);
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain("startRecording()");
        expect(msg).toContain('"recording"');
        expect(msg).toContain("Expected state");
        expect(msg).toContain("Current state");
      }
    });
  });

  // ─── panicMute ──────────────────────────────────────────────────────────────

  describe("panicMute()", () => {
    it("is a no-op from IDLE state (no runId increment)", () => {
      const session = manager.createSession();
      const initialRunId = session.runId;

      manager.panicMute(session.id);

      expect(session.state).toBe(SessionState.IDLE);
      expect(session.runId).toBe(initialRunId);
    });

    it("transitions from RECORDING to IDLE and increments runId", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      const runIdAfterStart = session.runId;

      manager.panicMute(session.id);

      expect(session.state).toBe(SessionState.IDLE);
      expect(session.runId).toBe(runIdAfterStart + 1);
    });

    it("transitions from PROCESSING to IDLE and increments runId", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      const runIdBeforePanic = session.runId;

      manager.panicMute(session.id);

      expect(session.state).toBe(SessionState.IDLE);
      expect(session.runId).toBe(runIdBeforePanic + 1);
    });

    it("transitions from DELIVERING to IDLE and increments runId", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);
      const runIdBeforePanic = session.runId;

      manager.panicMute(session.id);

      expect(session.state).toBe(SessionState.IDLE);
      expect(session.runId).toBe(runIdBeforePanic + 1);
    });

    it("preserves audio chunks after panicMute", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);

      // Simulate buffered audio chunks
      const chunk1 = Buffer.from([0x01, 0x02]);
      const chunk2 = Buffer.from([0x03, 0x04]);
      session.audioChunks.push(chunk1, chunk2);

      manager.panicMute(session.id);

      expect(session.audioChunks).toHaveLength(2);
      expect(session.audioChunks[0]).toBe(chunk1);
      expect(session.audioChunks[1]).toBe(chunk2);
    });

    it("allows starting a new recording after panicMute", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      manager.panicMute(session.id);

      // Should not throw — session is back in IDLE
      manager.startRecording(session.id);

      expect(session.state).toBe(SessionState.RECORDING);
    });
  });

  // ─── runId tracking ─────────────────────────────────────────────────────────

  describe("runId increments", () => {
    it("starts at 0 on session creation", () => {
      const session = manager.createSession();
      expect(session.runId).toBe(0);
    });

    it("increments to 1 on first startRecording()", () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      expect(session.runId).toBe(1);
    });

    it("does not increment on stopRecording()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      const runIdAfterStart = session.runId;

      await manager.stopRecording(session.id);

      expect(session.runId).toBe(runIdAfterStart);
    });

    it("does not increment on generateEvaluation()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      const runIdBeforeEval = session.runId;

      await manager.generateEvaluation(session.id);

      expect(session.runId).toBe(runIdBeforeEval);
    });

    it("does not increment on completeDelivery()", async () => {
      const session = manager.createSession();
      manager.startRecording(session.id);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);
      const runIdBeforeComplete = session.runId;

      manager.completeDelivery(session.id);

      expect(session.runId).toBe(runIdBeforeComplete);
    });

    it("increments correctly across multiple full lifecycles", async () => {
      const session = manager.createSession();
      expect(session.runId).toBe(0);

      // First lifecycle
      manager.startRecording(session.id);
      expect(session.runId).toBe(1);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);
      manager.completeDelivery(session.id);
      expect(session.runId).toBe(1);

      // Second lifecycle
      manager.startRecording(session.id);
      expect(session.runId).toBe(2);
      await manager.stopRecording(session.id);
      await manager.generateEvaluation(session.id);
      manager.completeDelivery(session.id);
      expect(session.runId).toBe(2);
    });

    it("increments on panicMute from non-IDLE states but not from IDLE", async () => {
      const session = manager.createSession();
      expect(session.runId).toBe(0);

      // panicMute from IDLE — no increment
      manager.panicMute(session.id);
      expect(session.runId).toBe(0);

      // Start recording (runId → 1), then panic (runId → 2)
      manager.startRecording(session.id);
      expect(session.runId).toBe(1);
      manager.panicMute(session.id);
      expect(session.runId).toBe(2);

      // Start again (runId → 3), stop, then panic from PROCESSING (runId → 4)
      manager.startRecording(session.id);
      expect(session.runId).toBe(3);
      await manager.stopRecording(session.id);
      manager.panicMute(session.id);
      expect(session.runId).toBe(4);
    });
  });
});

describe("replayTTS()", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it("returns undefined without state change when ttsAudioCache is null", () => {
    const session = manager.createSession();
    expect(session.state).toBe(SessionState.IDLE);
    expect(session.ttsAudioCache).toBeNull();

    const result = manager.replayTTS(session.id);

    expect(result).toBeUndefined();
    expect(session.state).toBe(SessionState.IDLE);
  });

  it("throws error when called in non-IDLE state (RECORDING)", () => {
    const session = manager.createSession();
    manager.startRecording(session.id);

    // Set ttsAudioCache so we don't hit the early-return path
    session.ttsAudioCache = Buffer.from([0x01, 0x02, 0x03]);

    expect(() => manager.replayTTS(session.id)).toThrow(/replayTTS\(\)/);
    expect(() => manager.replayTTS(session.id)).toThrow(/recording/);
  });
});

