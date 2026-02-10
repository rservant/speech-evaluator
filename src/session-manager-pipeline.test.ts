import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./session-manager.js";
import { VADMonitor } from "./vad-monitor.js";
import type { VADConfig, VADEventCallback } from "./vad-monitor.js";

/**
 * Integration test: verifies that when SessionManager is constructed with
 * the same dependency pattern used in index.ts (production entrypoint),
 * VAD is actually wired and functional during recording.
 *
 * This test exists because a missing vadMonitorFactory in index.ts caused
 * VAD to silently degrade to disabled in production. Unit tests for
 * SessionManager always injected a mock factory, so they couldn't catch
 * the gap at the composition root.
 */
describe("Production pipeline wiring — VAD factory", () => {
  it("SessionManager constructed with vadMonitorFactory creates a VADMonitor on startRecording", () => {
    // Mirror the exact construction pattern from index.ts
    const manager = new SessionManager({
      vadMonitorFactory: (config: VADConfig, callbacks: VADEventCallback) =>
        new VADMonitor(config, callbacks),
    });

    const session = manager.createSession();
    const speechEndSpy = vi.fn();
    manager.registerVADCallbacks(session.id, {
      onSpeechEnd: speechEndSpy,
      onStatus: () => {},
    });

    manager.startRecording(session.id);

    // Feed enough loud chunks to pass bootstrap + suppression, then silence
    const loudChunk = Buffer.alloc(1600);
    for (let i = 0; i < 800; i++) loudChunk.writeInt16LE(5000, i * 2);

    const silentChunk = Buffer.alloc(1600); // all zeros

    // ~15s of speech (300 chunks × 0.05s) — clears suppression (10s) and minSpeech (3s)
    for (let i = 0; i < 300; i++) {
      manager.feedAudio(session.id, loudChunk);
    }

    // ~6s of silence (120 chunks × 0.05s) — exceeds default 5s threshold
    for (let i = 0; i < 120; i++) {
      manager.feedAudio(session.id, silentChunk);
    }

    // VAD should have fired onSpeechEnd — proving the factory was wired
    expect(speechEndSpy).toHaveBeenCalled();
  });

  it("SessionManager constructed WITHOUT vadMonitorFactory never fires VAD events", () => {
    // This is the bug scenario — no factory provided
    const manager = new SessionManager({});

    const session = manager.createSession();
    const speechEndSpy = vi.fn();
    manager.registerVADCallbacks(session.id, {
      onSpeechEnd: speechEndSpy,
      onStatus: () => {},
    });

    manager.startRecording(session.id);

    const loudChunk = Buffer.alloc(1600);
    for (let i = 0; i < 800; i++) loudChunk.writeInt16LE(5000, i * 2);
    const silentChunk = Buffer.alloc(1600);

    for (let i = 0; i < 300; i++) {
      manager.feedAudio(session.id, loudChunk);
    }
    for (let i = 0; i < 120; i++) {
      manager.feedAudio(session.id, silentChunk);
    }

    // No factory = no VAD = no events — this is the silent failure mode
    expect(speechEndSpy).not.toHaveBeenCalled();
  });
});
