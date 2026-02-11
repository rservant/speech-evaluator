// Property-Based Test: Video consent independence from audio consent
// Feature: phase-4-multimodal-video, Property 1

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { SessionManager } from "./session-manager.js";
import type { VideoConsent } from "./types.js";

// ─── Generators ─────────────────────────────────────────────────────────────────

/** Generator for non-empty speaker names (trimmed, printable strings). */
const arbitrarySpeakerName = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Generator for VideoConsent objects with arbitrary consent status and timestamp. */
const arbitraryVideoConsent = (): fc.Arbitrary<VideoConsent> =>
  fc.record({
    consentGranted: fc.boolean(),
    timestamp: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }),
  });

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-4-multimodal-video, Property 1: Video consent independence from audio consent", () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any session, setting or modifying video consent SHALL NOT change the
   * audio Consent_Record, and setting or modifying the audio Consent_Record
   * SHALL NOT change the Video_Consent. Both fields are independently stored
   * and independently queryable.
   */

  it("setting video consent does not affect audio consent", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySpeakerName(),
        fc.boolean(),
        arbitraryVideoConsent(),
        async (speakerName, audioConsentConfirmed, videoConsent) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set audio consent first
          sm.setConsent(sessionId, speakerName, audioConsentConfirmed);

          // Capture audio consent state
          const audioConsentBefore = {
            speakerName: session.consent!.speakerName,
            consentConfirmed: session.consent!.consentConfirmed,
            consentTimestamp: session.consent!.consentTimestamp,
          };

          // Set video consent — should not affect audio consent
          sm.setVideoConsent(sessionId, videoConsent);

          // Audio consent must be unchanged
          expect(session.consent).not.toBeNull();
          expect(session.consent!.speakerName).toBe(audioConsentBefore.speakerName);
          expect(session.consent!.consentConfirmed).toBe(audioConsentBefore.consentConfirmed);
          expect(session.consent!.consentTimestamp).toBe(audioConsentBefore.consentTimestamp);

          // Video consent must be set correctly
          expect(session.videoConsent).not.toBeNull();
          expect(session.videoConsent!.consentGranted).toBe(videoConsent.consentGranted);
          expect(session.videoConsent!.timestamp).toBe(videoConsent.timestamp);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("setting audio consent does not affect video consent", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryVideoConsent(),
        arbitrarySpeakerName(),
        fc.boolean(),
        async (videoConsent, speakerName, audioConsentConfirmed) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          // Set video consent first
          sm.setVideoConsent(sessionId, videoConsent);

          // Capture video consent state
          const videoConsentBefore = {
            consentGranted: session.videoConsent!.consentGranted,
            timestamp: session.videoConsent!.timestamp,
          };

          // Set audio consent — should not affect video consent
          sm.setConsent(sessionId, speakerName, audioConsentConfirmed);

          // Video consent must be unchanged
          expect(session.videoConsent).not.toBeNull();
          expect(session.videoConsent!.consentGranted).toBe(videoConsentBefore.consentGranted);
          expect(session.videoConsent!.timestamp).toBe(videoConsentBefore.timestamp);

          // Audio consent must be set correctly
          expect(session.consent).not.toBeNull();
          expect(session.consent!.speakerName).toBe(speakerName);
          expect(session.consent!.consentConfirmed).toBe(audioConsentConfirmed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("arbitrary interleaved modifications preserve independence", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a sequence of operations: either set audio consent or set video consent
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant("audio" as const),
              speakerName: arbitrarySpeakerName(),
              consentConfirmed: fc.boolean(),
            }),
            fc.record({
              op: fc.constant("video" as const),
              videoConsent: arbitraryVideoConsent(),
            }),
          ),
          { minLength: 2, maxLength: 20 },
        ),
        async (operations) => {
          const sm = new SessionManager();
          const session = sm.createSession();
          const sessionId = session.id;

          for (const operation of operations) {
            if (operation.op === "audio") {
              const videoBefore = session.videoConsent
                ? { consentGranted: session.videoConsent.consentGranted, timestamp: session.videoConsent.timestamp }
                : null;

              sm.setConsent(sessionId, operation.speakerName, operation.consentConfirmed);

              // Video consent must be unchanged
              if (videoBefore === null) {
                expect(session.videoConsent).toBeNull();
              } else {
                expect(session.videoConsent).not.toBeNull();
                expect(session.videoConsent!.consentGranted).toBe(videoBefore.consentGranted);
                expect(session.videoConsent!.timestamp).toBe(videoBefore.timestamp);
              }
            } else {
              const audioBefore = session.consent
                ? {
                    speakerName: session.consent.speakerName,
                    consentConfirmed: session.consent.consentConfirmed,
                    consentTimestamp: session.consent.consentTimestamp,
                  }
                : null;

              sm.setVideoConsent(sessionId, operation.videoConsent);

              // Audio consent must be unchanged
              if (audioBefore === null) {
                expect(session.consent).toBeNull();
              } else {
                expect(session.consent).not.toBeNull();
                expect(session.consent!.speakerName).toBe(audioBefore.speakerName);
                expect(session.consent!.consentConfirmed).toBe(audioBefore.consentConfirmed);
                expect(session.consent!.consentTimestamp).toBe(audioBefore.consentTimestamp);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
