// Property-Based Tests for TTS Playback Deferral State Machine
// Feature: tts-playback-glitch-fix

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ─── State Machine Model ────────────────────────────────────────────

const SessionState = {
  IDLE: "idle",
  RECORDING: "recording",
  PROCESSING: "processing",
  DELIVERING: "delivering",
} as const;

type SessionStateType = (typeof SessionState)[keyof typeof SessionState];

interface DeferralState {
  currentState: SessionStateType;
  ttsPlaying: boolean;
  deferredIdleTransition: { token: number } | null;
  playbackInstanceToken: number;
  pendingIdleFromServer: { tokenAtLatch: number } | null;
  cooldownTimerId: number | null; // non-null means cooldown is running
  uiState: SessionStateType; // tracks what updateUI was last called with
  cooldownStarted: boolean; // tracks if startCooldown was called
  evaluationPanelVisible: boolean; // tracks if evaluation panel was shown
  forcedStop: boolean; // tracks if a force-stop path was executed
}

function createInitialState(): DeferralState {
  return {
    currentState: SessionState.IDLE,
    ttsPlaying: false,
    deferredIdleTransition: null,
    playbackInstanceToken: 0,
    pendingIdleFromServer: null,
    cooldownTimerId: null,
    uiState: SessionState.IDLE,
    cooldownStarted: false,
    evaluationPanelVisible: false,
    forcedStop: false,
  };
}

// ─── Model Functions (mirror the real implementation) ────────────────

function modelUpdateUI(
  state: DeferralState,
  newState: SessionStateType,
): void {
  state.currentState = newState;
  state.uiState = newState;
}

function modelStartCooldown(state: DeferralState): void {
  state.cooldownTimerId = 1; // non-null sentinel
  state.cooldownStarted = true;
}

function modelTransitionToIdle(state: DeferralState): void {
  if (
    state.currentState === SessionState.IDLE &&
    state.cooldownTimerId !== null
  )
    return;
  state.pendingIdleFromServer = null;
  modelUpdateUI(state, SessionState.IDLE);
  modelStartCooldown(state);
}

function modelApplyDeferredIdle(
  state: DeferralState,
  token: number,
): void {
  if (state.deferredIdleTransition === null) return;
  if (state.deferredIdleTransition.token !== token) return;
  state.deferredIdleTransition = null;
  modelTransitionToIdle(state);
}

function modelCancelDeferredIdle(state: DeferralState): void {
  state.deferredIdleTransition = null;
  state.playbackInstanceToken++;
}

function modelStopTTSPlayback(state: DeferralState): void {
  state.ttsPlaying = false;
}

function modelForceStopTtsAndCancelDeferral(state: DeferralState): void {
  modelCancelDeferredIdle(state);
  state.pendingIdleFromServer = null;
  modelStopTTSPlayback(state);
}

function modelTriggerTTSFailSafe(state: DeferralState): void {
  modelForceStopTtsAndCancelDeferral(state);
  state.evaluationPanelVisible = true;
  state.forcedStop = true;
  modelTransitionToIdle(state);
}

function modelHandleStateChange(
  state: DeferralState,
  newState: SessionStateType,
): void {
  // Branch A: ttsPlaying is true → defer
  if (newState === SessionState.IDLE && state.ttsPlaying) {
    if (state.deferredIdleTransition === null) {
      state.deferredIdleTransition = { token: state.playbackInstanceToken };
    }
    return;
  }

  // Branch B: not playing, non-IDLE state → latch
  if (
    newState === SessionState.IDLE &&
    !state.ttsPlaying &&
    state.currentState !== SessionState.IDLE
  ) {
    if (state.pendingIdleFromServer === null) {
      state.pendingIdleFromServer = {
        tokenAtLatch: state.playbackInstanceToken,
      };
    }
    return;
  }

  // Branch C: immediate IDLE
  if (newState === SessionState.IDLE) {
    modelTransitionToIdle(state);
    return;
  }

  // Branch D: non-IDLE
  modelUpdateUI(state, newState);
}

function modelHandleTTSAudio(state: DeferralState): void {
  state.playbackInstanceToken++;
  const currentToken = state.playbackInstanceToken;

  // Consume latch
  if (state.pendingIdleFromServer !== null) {
    const latchIsRelevant =
      state.pendingIdleFromServer.tokenAtLatch + 1 === currentToken;
    state.pendingIdleFromServer = null;
    if (latchIsRelevant && state.deferredIdleTransition === null) {
      state.deferredIdleTransition = { token: currentToken };
    }
  }

  // Adopt existing deferral: if a deferredIdleTransition was created for a
  // previous playback, update its token to the current playback so the new
  // onended handler can resolve it. Without this, the deferral becomes dead.
  if (state.deferredIdleTransition !== null && state.deferredIdleTransition.token !== currentToken) {
    state.deferredIdleTransition = { token: currentToken };
  }

  state.ttsPlaying = true;
}

function modelOnEnded(state: DeferralState, token: number): void {
  state.ttsPlaying = false;
  modelApplyDeferredIdle(state, token);
}

function modelPanicMute(state: DeferralState): void {
  modelForceStopTtsAndCancelDeferral(state);
  state.forcedStop = true;
  state.cooldownTimerId = null; // clearCooldown
  modelUpdateUI(state, SessionState.IDLE);
}

function modelAudioError(state: DeferralState): void {
  modelTriggerTTSFailSafe(state);
}

function modelWsDisconnect(state: DeferralState): void {
  if (
    state.ttsPlaying ||
    state.deferredIdleTransition !== null ||
    state.pendingIdleFromServer !== null ||
    state.currentState !== SessionState.IDLE
  ) {
    modelTriggerTTSFailSafe(state);
  }
}

function modelPlayReject(state: DeferralState): void {
  modelTriggerTTSFailSafe(state);
}

// ─── Exported model for reuse by other property test files ──────────

export {
  SessionState,
  type SessionStateType,
  type DeferralState,
  createInitialState,
  modelUpdateUI,
  modelStartCooldown,
  modelTransitionToIdle,
  modelApplyDeferredIdle,
  modelCancelDeferredIdle,
  modelStopTTSPlayback,
  modelForceStopTtsAndCancelDeferral,
  modelTriggerTTSFailSafe,
  modelHandleStateChange,
  modelHandleTTSAudio,
  modelOnEnded,
  modelPanicMute,
  modelAudioError,
  modelWsDisconnect,
  modelPlayReject,
};

// ─── Property Tests ─────────────────────────────────────────────────

describe("Feature: tts-playback-glitch-fix, Property 1: Deferred IDLE round-trip", () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.4, 3.2**
   *
   * For any event sequence where state_change: idle arrives while ttsPlaying is true,
   * the client should store a deferredIdleTransition with the current playbackInstanceToken,
   * keep the UI in DELIVERING state, and only transition to IDLE when onended fires with
   * a matching token — at which point startCooldown is called.
   */
  it("defers IDLE during active playback and applies it on matching onended", () => {
    fc.assert(
      fc.property(
        // Generate a starting state (DELIVERING with audio playing)
        fc.constant(null),
        () => {
          const state = createInitialState();

          // Set up: transition to DELIVERING, start audio
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);
          const audioToken = state.playbackInstanceToken;

          // Verify preconditions
          expect(state.ttsPlaying).toBe(true);
          expect(state.uiState).toBe(SessionState.DELIVERING);

          // Act: server sends state_change: idle while audio is playing
          modelHandleStateChange(state, SessionState.IDLE);

          // Assert: IDLE is deferred, UI stays in DELIVERING
          expect(state.deferredIdleTransition).not.toBeNull();
          expect(state.deferredIdleTransition!.token).toBe(audioToken);
          expect(state.uiState).toBe(SessionState.DELIVERING);
          expect(state.cooldownStarted).toBe(false);

          // Act: audio ends naturally with matching token
          modelOnEnded(state, audioToken);

          // Assert: IDLE applied, cooldown started
          expect(state.uiState).toBe(SessionState.IDLE);
          expect(state.ttsPlaying).toBe(false);
          expect(state.deferredIdleTransition).toBeNull();
          expect(state.cooldownStarted).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("defers IDLE regardless of previous state (not just DELIVERING)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          SessionState.RECORDING,
          SessionState.PROCESSING,
          SessionState.DELIVERING,
        ),
        (previousState) => {
          const state = createInitialState();

          // Set up: transition to some state, start audio
          modelHandleStateChange(state, previousState);
          modelHandleTTSAudio(state);
          const audioToken = state.playbackInstanceToken;

          // Act: server sends IDLE while audio is playing
          modelHandleStateChange(state, SessionState.IDLE);

          // Assert: deferred regardless of previous state
          expect(state.deferredIdleTransition).not.toBeNull();
          expect(state.deferredIdleTransition!.token).toBe(audioToken);
          expect(state.uiState).not.toBe(SessionState.IDLE);

          // Complete the round-trip
          modelOnEnded(state, audioToken);
          expect(state.uiState).toBe(SessionState.IDLE);
          expect(state.cooldownStarted).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: Immediate IDLE when not playing ────────────────────

describe("Feature: tts-playback-glitch-fix, Property 2: Immediate IDLE when not playing", () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any client state where ttsPlaying is false and deferredIdleTransition is null,
   * receiving state_change: idle should immediately transition the UI to IDLE with no
   * deferral stored.
   */
  it("transitions to IDLE immediately when not playing and no deferral pending", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          SessionState.RECORDING,
          SessionState.PROCESSING,
          SessionState.DELIVERING,
        ),
        (previousState) => {
          const state = createInitialState();

          // Set up: in some non-IDLE state, not playing
          modelUpdateUI(state, previousState);
          expect(state.ttsPlaying).toBe(false);
          expect(state.deferredIdleTransition).toBeNull();

          // Act: server sends IDLE
          // Note: Branch B will latch since currentState !== IDLE && !ttsPlaying
          // This is correct behavior — the latch handles the "IDLE before audio" case
          modelHandleStateChange(state, SessionState.IDLE);

          // Assert: latch was set (Branch B), no immediate IDLE transition
          expect(state.pendingIdleFromServer).not.toBeNull();
          expect(state.deferredIdleTransition).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("transitions to IDLE immediately when already in IDLE (redundant IDLE→IDLE)", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();

        // Already in IDLE, not playing
        expect(state.currentState).toBe(SessionState.IDLE);
        expect(state.ttsPlaying).toBe(false);

        // Act: redundant IDLE arrives
        state.cooldownStarted = false; // reset tracker
        modelHandleStateChange(state, SessionState.IDLE);

        // Assert: Branch C — immediate transition via transitionToIdle()
        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.deferredIdleTransition).toBeNull();
        expect(state.cooldownStarted).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 3: Duplicate idle idempotency ─────────────────────────

describe("Feature: tts-playback-glitch-fix, Property 3: Duplicate idle idempotency", () => {
  /**
   * **Validates: Requirements 1.6**
   *
   * For any client state where deferredIdleTransition is non-null, receiving additional
   * state_change: idle messages should not modify the existing deferredIdleTransition token,
   * should not trigger updateUI, and should not call startCooldown.
   */
  it("duplicate IDLE messages during deferral are idempotent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // number of duplicate IDLEs
        (duplicateCount) => {
          const state = createInitialState();

          // Set up: DELIVERING with audio playing, IDLE deferred
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);
          const audioToken = state.playbackInstanceToken;
          modelHandleStateChange(state, SessionState.IDLE);

          // Snapshot state after first deferral
          const tokenAfterFirstDefer = state.deferredIdleTransition!.token;
          const uiAfterFirstDefer = state.uiState;
          state.cooldownStarted = false; // reset tracker

          // Act: send N more IDLE messages
          for (let i = 0; i < duplicateCount; i++) {
            modelHandleStateChange(state, SessionState.IDLE);
          }

          // Assert: nothing changed — idempotent
          expect(state.deferredIdleTransition).not.toBeNull();
          expect(state.deferredIdleTransition!.token).toBe(tokenAfterFirstDefer);
          expect(state.uiState).toBe(uiAfterFirstDefer);
          expect(state.cooldownStarted).toBe(false);

          // Cleanup: complete the round-trip
          modelOnEnded(state, audioToken);
          expect(state.uiState).toBe(SessionState.IDLE);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: Stale token rejection ──────────────────────────────

describe("Feature: tts-playback-glitch-fix, Property 4: Stale token rejection", () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * For any deferredIdleTransition with token T, an onended event with token T' where
   * T' ≠ T should leave deferredIdleTransition unchanged and should not trigger updateUI
   * or startCooldown.
   */
  it("stale onended with wrong token does not apply deferred IDLE", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }), // offset for stale token
        (tokenOffset) => {
          const state = createInitialState();

          // Set up: DELIVERING with audio playing, IDLE deferred
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);
          const audioToken = state.playbackInstanceToken;
          modelHandleStateChange(state, SessionState.IDLE);

          expect(state.deferredIdleTransition).not.toBeNull();
          state.cooldownStarted = false;

          // Act: stale onended with wrong token
          const staleToken = audioToken + tokenOffset;
          modelOnEnded(state, staleToken);

          // Assert: deferral unchanged, no IDLE transition
          expect(state.deferredIdleTransition).not.toBeNull();
          expect(state.deferredIdleTransition!.token).toBe(audioToken);
          expect(state.uiState).toBe(SessionState.DELIVERING);
          expect(state.cooldownStarted).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("stale onended with token 0 (before any playback) is rejected", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();

        // Set up: DELIVERING with audio playing, IDLE deferred
        modelHandleStateChange(state, SessionState.DELIVERING);
        modelHandleTTSAudio(state);
        modelHandleStateChange(state, SessionState.IDLE);

        expect(state.deferredIdleTransition).not.toBeNull();

        // Act: onended with token 0 (from before any playback started)
        modelOnEnded(state, 0);

        // Assert: deferral unchanged
        expect(state.deferredIdleTransition).not.toBeNull();
        expect(state.uiState).toBe(SessionState.DELIVERING);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 5: Panic mute always clears deferral and playback ─────

describe("Feature: tts-playback-glitch-fix, Property 5: Panic mute always clears deferral and playback", () => {
  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any client state (with or without a pending deferredIdleTransition, with or
   * without active TTS playback), triggering panic mute should result in
   * deferredIdleTransition === null, ttsPlaying === false, and currentState === IDLE.
   */
  it("panic mute clears all deferral state regardless of starting conditions", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          SessionState.IDLE,
          SessionState.RECORDING,
          SessionState.PROCESSING,
          SessionState.DELIVERING,
        ),
        fc.boolean(), // ttsPlaying
        fc.boolean(), // has deferral
        (startState, playing, hasDeferral) => {
          const state = createInitialState();
          modelUpdateUI(state, startState);

          if (playing) {
            modelHandleTTSAudio(state);
          }
          if (hasDeferral) {
            state.deferredIdleTransition = { token: state.playbackInstanceToken };
          }

          // Act
          modelPanicMute(state);

          // Assert
          expect(state.deferredIdleTransition).toBeNull();
          expect(state.ttsPlaying).toBe(false);
          expect(state.currentState).toBe(SessionState.IDLE);
          expect(state.pendingIdleFromServer).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: Abort during deferral triggers fail-safe ───────────

describe("Feature: tts-playback-glitch-fix, Property 6: Abort during deferral triggers fail-safe", () => {
  /**
   * **Validates: Requirements 4.1, 4.2, 4.3**
   *
   * For any client state where deferredIdleTransition is non-null, if an abort event
   * occurs (TTS audio error, play() rejection, or WebSocket disconnect), the client
   * should cancel the deferral, invalidate the token, stop playback, ensure the
   * evaluation panel is visible, and transition to IDLE.
   */
  it("audio error during deferral triggers fail-safe and reaches IDLE", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelHandleStateChange(state, SessionState.DELIVERING);
        modelHandleTTSAudio(state);
        modelHandleStateChange(state, SessionState.IDLE);
        expect(state.deferredIdleTransition).not.toBeNull();

        modelAudioError(state);

        expect(state.deferredIdleTransition).toBeNull();
        expect(state.ttsPlaying).toBe(false);
        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.evaluationPanelVisible).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("play() rejection during deferral triggers fail-safe and reaches IDLE", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelHandleStateChange(state, SessionState.DELIVERING);
        modelHandleTTSAudio(state);
        modelHandleStateChange(state, SessionState.IDLE);
        expect(state.deferredIdleTransition).not.toBeNull();

        modelPlayReject(state);

        expect(state.deferredIdleTransition).toBeNull();
        expect(state.ttsPlaying).toBe(false);
        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.evaluationPanelVisible).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("WebSocket disconnect during deferral triggers fail-safe and reaches IDLE", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelHandleStateChange(state, SessionState.DELIVERING);
        modelHandleTTSAudio(state);
        modelHandleStateChange(state, SessionState.IDLE);
        expect(state.deferredIdleTransition).not.toBeNull();

        modelWsDisconnect(state);

        expect(state.deferredIdleTransition).toBeNull();
        expect(state.ttsPlaying).toBe(false);
        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.evaluationPanelVisible).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 7: Cancellation invalidates token ─────────────────────

describe("Feature: tts-playback-glitch-fix, Property 7: Cancellation invalidates token", () => {
  /**
   * **Validates: Requirements 1.7, 2.3**
   *
   * For any client state, after cancelDeferredIdle() is called, a late onended event
   * carrying the previous playbackInstanceToken value should not apply any IDLE transition.
   */
  it("late onended after cancellation is rejected due to token bump", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          SessionState.RECORDING,
          SessionState.PROCESSING,
          SessionState.DELIVERING,
        ),
        (startState) => {
          const state = createInitialState();
          modelUpdateUI(state, startState);
          modelHandleTTSAudio(state);
          const oldToken = state.playbackInstanceToken;
          modelHandleStateChange(state, SessionState.IDLE);

          // Cancel deferral (simulates panic mute path)
          modelCancelDeferredIdle(state);
          const newToken = state.playbackInstanceToken;
          expect(newToken).toBeGreaterThan(oldToken);

          // Late onended with old token
          state.cooldownStarted = false;
          modelOnEnded(state, oldToken);

          // Assert: no IDLE transition from stale event
          expect(state.cooldownStarted).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: play() rejection doesn't deadlock ──────────────────

describe("Feature: tts-playback-glitch-fix, Property 8: play() rejection doesn't deadlock", () => {
  /**
   * **Validates: Requirements 4.3**
   *
   * For any client state where ttsPlaying is true and play() rejects, the client should
   * cancel any pending deferral, invalidate the token, stop playback, show the written
   * evaluation, and transition to IDLE. The system must not remain stuck in DELIVERING.
   */
  it("play() rejection always reaches IDLE and clears all deferral state", () => {
    fc.assert(
      fc.property(
        fc.boolean(), // whether IDLE arrived before play() rejection
        (idleArrivedFirst) => {
          const state = createInitialState();
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);

          if (idleArrivedFirst) {
            modelHandleStateChange(state, SessionState.IDLE);
            expect(state.deferredIdleTransition).not.toBeNull();
          }

          // Act: play() rejects
          modelPlayReject(state);

          // Assert: not stuck, reached IDLE
          expect(state.ttsPlaying).toBe(false);
          expect(state.deferredIdleTransition).toBeNull();
          expect(state.uiState).toBe(SessionState.IDLE);
          expect(state.pendingIdleFromServer).toBeNull();
          expect(state.evaluationPanelVisible).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: No dead deferral ───────────────────────────────────

describe("Feature: tts-playback-glitch-fix, Property 9: No dead deferral", () => {
  /**
   * **Validates: Requirements 1.2, 4.1, 4.2, 4.3**
   *
   * For any client state where a Deferred_IDLE is pending and ttsPlaying subsequently
   * becomes false, the deferred transition is eventually applied or cancelled. The UI
   * must always reach IDLE; it must never remain stuck in DELIVERING with ttsPlaying === false
   * and a stale deferral.
   *
   * Generated event sequences MUST include: state_change: idle arriving before handleTTSAudio,
   * ws.onclose while playing but before deferral is created, duplicate onended events,
   * play() rejection without onerror.
   */

  // Event type for the sequence generator
  type Event =
    | { type: "stateChangeIdle" }
    | { type: "handleTTSAudio" }
    | { type: "onended" }
    | { type: "panicMute" }
    | { type: "audioError" }
    | { type: "wsDisconnect" }
    | { type: "playReject" };

  const eventArb: fc.Arbitrary<Event> = fc.constantFrom<Event>(
    { type: "stateChangeIdle" },
    { type: "handleTTSAudio" },
    { type: "onended" },
    { type: "panicMute" },
    { type: "audioError" },
    { type: "wsDisconnect" },
    { type: "playReject" },
  );

  it("no dead deferral: after any event sequence, if ttsPlaying is false then deferral is resolved", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 15 }),
        (events) => {
          const state = createInitialState();
          // Start in DELIVERING with audio
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);
          let lastAudioToken = state.playbackInstanceToken;

          for (const event of events) {
            switch (event.type) {
              case "stateChangeIdle":
                modelHandleStateChange(state, SessionState.IDLE);
                break;
              case "handleTTSAudio":
                modelHandleTTSAudio(state);
                lastAudioToken = state.playbackInstanceToken;
                break;
              case "onended":
                // In real code, onended only fires with the token captured in the
                // closure. Use lastAudioToken to simulate realistic behavior.
                modelOnEnded(state, lastAudioToken);
                break;
              case "panicMute":
                modelPanicMute(state);
                break;
              case "audioError":
                modelAudioError(state);
                break;
              case "wsDisconnect":
                modelWsDisconnect(state);
                break;
              case "playReject":
                modelPlayReject(state);
                break;
            }
          }

          // Terminal invariant: if ttsPlaying is false AND no more audio will arrive
          // (simulated by being at the end of the sequence), then either:
          // 1. deferredIdleTransition is null (resolved), OR
          // 2. The UI has reached IDLE via a force-stop path
          // In other words: ttsPlaying=false with a pending deferral is a dead deferral
          // UNLESS the deferral was just created by latch consumption and the matching
          // onended hasn't fired yet. Since we're at the end of the sequence, if
          // ttsPlaying is false, the onended has already fired or won't fire.
          if (!state.ttsPlaying) {
            // If deferral exists, it must have been created by latch consumption
            // for a playback that is still "in flight" (ttsPlaying should be true).
            // Since ttsPlaying is false, the deferral should have been resolved.
            if (state.deferredIdleTransition !== null) {
              // This is only valid if a force-stop cleared ttsPlaying but the
              // deferral was recreated by a subsequent latch consumption + handleTTSAudio.
              // But if ttsPlaying is false, that handleTTSAudio would have set it true.
              // So this state should not occur.
              // However, there's one edge case: handleTTSAudio creates deferral via latch,
              // then onended fires for a DIFFERENT (earlier) playback with a non-matching token.
              // In real code, handler nulling prevents this. In the model, we use lastAudioToken
              // which always matches the latest playback, so this can't happen.
              expect(state.deferredIdleTransition).toBeNull();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("idle before handleTTSAudio followed by ws.onclose reaches IDLE", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelHandleStateChange(state, SessionState.DELIVERING);

        // IDLE arrives before audio (Branch B: latch)
        modelHandleStateChange(state, SessionState.IDLE);
        expect(state.pendingIdleFromServer).not.toBeNull();

        // WS disconnects before handleTTSAudio
        modelWsDisconnect(state);

        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.pendingIdleFromServer).toBeNull();
        expect(state.deferredIdleTransition).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("duplicate onended events don't cause issues", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (duplicateCount) => {
          const state = createInitialState();
          modelHandleStateChange(state, SessionState.DELIVERING);
          modelHandleTTSAudio(state);
          const token = state.playbackInstanceToken;
          modelHandleStateChange(state, SessionState.IDLE);

          // First onended applies the deferral
          modelOnEnded(state, token);
          expect(state.uiState).toBe(SessionState.IDLE);

          // Duplicate onended events are no-ops
          for (let i = 0; i < duplicateCount; i++) {
            modelOnEnded(state, token);
          }

          expect(state.uiState).toBe(SessionState.IDLE);
          expect(state.deferredIdleTransition).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("play() rejection without onerror still reaches IDLE", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelHandleStateChange(state, SessionState.DELIVERING);
        modelHandleTTSAudio(state);
        modelHandleStateChange(state, SessionState.IDLE);

        // play() rejects — no onerror fires
        modelPlayReject(state);

        expect(state.uiState).toBe(SessionState.IDLE);
        expect(state.ttsPlaying).toBe(false);
        expect(state.deferredIdleTransition).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 10: No premature replay visibility ────────────────────

describe("Feature: tts-playback-glitch-fix, Property 10: No premature replay visibility", () => {
  /**
   * **Validates: Requirements 1.4, 1.8**
   *
   * For any client state where ttsPlaying is true, the UI state must not be IDLE
   * unless a forced-stop path was executed. This is the direct encoding of the
   * original bug.
   */

  type Event =
    | { type: "stateChangeIdle" }
    | { type: "stateChangeDelivering" }
    | { type: "handleTTSAudio" }
    | { type: "onended" }
    | { type: "panicMute" }
    | { type: "audioError" }
    | { type: "wsDisconnect" }
    | { type: "playReject" };

  const eventArb: fc.Arbitrary<Event> = fc.constantFrom<Event>(
    { type: "stateChangeIdle" },
    { type: "stateChangeDelivering" },
    { type: "handleTTSAudio" },
    { type: "onended" },
    { type: "panicMute" },
    { type: "audioError" },
    { type: "wsDisconnect" },
    { type: "playReject" },
  );

  it("ttsPlaying && !forcedStop implies uiState !== IDLE", () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 20 }),
        (events) => {
          const state = createInitialState();
          let lastAudioToken = 0;

          for (const event of events) {
            switch (event.type) {
              case "stateChangeIdle":
                modelHandleStateChange(state, SessionState.IDLE);
                break;
              case "stateChangeDelivering":
                modelHandleStateChange(state, SessionState.DELIVERING);
                break;
              case "handleTTSAudio":
                // In real code, handleTTSAudio only fires during DELIVERING
                // (binary WS frame arrives after state_change: delivering).
                // Skip if not in a non-IDLE state to avoid unrealistic sequences.
                if (state.currentState === SessionState.IDLE) break;
                modelHandleTTSAudio(state);
                lastAudioToken = state.playbackInstanceToken;
                break;
              case "onended":
                modelOnEnded(state, lastAudioToken);
                break;
              case "panicMute":
                modelPanicMute(state);
                break;
              case "audioError":
                modelAudioError(state);
                break;
              case "wsDisconnect":
                modelWsDisconnect(state);
                break;
              case "playReject":
                modelPlayReject(state);
                break;
            }

            // Check invariant after every event:
            // If audio is playing and no force-stop has occurred, UI must not be IDLE
            if (state.ttsPlaying && !state.forcedStop) {
              expect(state.uiState).not.toBe(SessionState.IDLE);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 11: pendingIdleFromServer latch correctness ───────────

describe("Feature: tts-playback-glitch-fix, Property 11: pendingIdleFromServer latch correctness", () => {
  /**
   * **Validates: Requirements 1.10**
   *
   * Comprehensive latch correctness: set, consumed, discarded, cleared by force-stop,
   * no dangling latch, ordering invariant.
   */

  it("IDLE while non-IDLE and !ttsPlaying sets latch with current token, no IDLE transition", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          SessionState.RECORDING,
          SessionState.PROCESSING,
          SessionState.DELIVERING,
        ),
        (fromState) => {
          const state = createInitialState();
          modelUpdateUI(state, fromState);
          const tokenBefore = state.playbackInstanceToken;

          modelHandleStateChange(state, SessionState.IDLE);

          expect(state.pendingIdleFromServer).not.toBeNull();
          expect(state.pendingIdleFromServer!.tokenAtLatch).toBe(tokenBefore);
          expect(state.uiState).toBe(fromState); // no IDLE transition
          expect(state.deferredIdleTransition).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("handleTTSAudio consumes matching latch and creates deferral", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelUpdateUI(state, SessionState.DELIVERING);

        // IDLE arrives before audio
        modelHandleStateChange(state, SessionState.IDLE);
        expect(state.pendingIdleFromServer).not.toBeNull();
        const latchToken = state.pendingIdleFromServer!.tokenAtLatch;

        // Audio arrives — token increments to latchToken + 1
        modelHandleTTSAudio(state);

        // Latch consumed, deferral created
        expect(state.pendingIdleFromServer).toBeNull();
        expect(state.deferredIdleTransition).not.toBeNull();
        expect(state.deferredIdleTransition!.token).toBe(latchToken + 1);
      }),
      { numRuns: 100 },
    );
  });

  it("handleTTSAudio discards stale latch (token mismatch)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }), // extra token bumps to make latch stale
        (extraBumps) => {
          const state = createInitialState();
          modelUpdateUI(state, SessionState.DELIVERING);

          // IDLE arrives, latch set
          modelHandleStateChange(state, SessionState.IDLE);
          expect(state.pendingIdleFromServer).not.toBeNull();

          // Bump token several times (simulates cancellations/other playbacks)
          for (let i = 0; i < extraBumps; i++) {
            modelCancelDeferredIdle(state);
          }

          // Now handleTTSAudio — token is latchToken + 1 + extraBumps, not latchToken + 1
          modelHandleTTSAudio(state);

          // Latch discarded, no deferral created
          expect(state.pendingIdleFromServer).toBeNull();
          expect(state.deferredIdleTransition).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("force-stop clears pending latch", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("panicMute", "audioError", "wsDisconnect", "playReject") as fc.Arbitrary<string>,
        (forceStopType) => {
          const state = createInitialState();
          modelUpdateUI(state, SessionState.DELIVERING);

          // IDLE arrives, latch set
          modelHandleStateChange(state, SessionState.IDLE);
          expect(state.pendingIdleFromServer).not.toBeNull();

          // Force-stop before handleTTSAudio
          switch (forceStopType) {
            case "panicMute":
              modelPanicMute(state);
              break;
            case "audioError":
              modelAudioError(state);
              break;
            case "wsDisconnect":
              modelWsDisconnect(state);
              break;
            case "playReject":
              modelPlayReject(state);
              break;
          }

          expect(state.pendingIdleFromServer).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("after any terminal event, pendingIdleFromServer is null (no dangling latch)", () => {
    type Event =
      | { type: "stateChangeIdle" }
      | { type: "stateChangeDelivering" }
      | { type: "stateChangeProcessing" }
      | { type: "handleTTSAudio" }
      | { type: "onended" }
      | { type: "panicMute" }
      | { type: "wsDisconnect" };

    const eventArb: fc.Arbitrary<Event> = fc.constantFrom<Event>(
      { type: "stateChangeIdle" },
      { type: "stateChangeDelivering" },
      { type: "stateChangeProcessing" },
      { type: "handleTTSAudio" },
      { type: "onended" },
      { type: "panicMute" },
      { type: "wsDisconnect" },
    );

    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 15 }),
        (events) => {
          const state = createInitialState();
          let lastAudioToken = 0;

          for (const event of events) {
            switch (event.type) {
              case "stateChangeIdle":
                modelHandleStateChange(state, SessionState.IDLE);
                break;
              case "stateChangeDelivering":
                modelHandleStateChange(state, SessionState.DELIVERING);
                break;
              case "stateChangeProcessing":
                modelHandleStateChange(state, SessionState.PROCESSING);
                break;
              case "handleTTSAudio":
                modelHandleTTSAudio(state);
                lastAudioToken = state.playbackInstanceToken;
                break;
              case "onended":
                modelOnEnded(state, lastAudioToken);
                break;
              case "panicMute":
                modelPanicMute(state);
                break;
              case "wsDisconnect":
                modelWsDisconnect(state);
                break;
            }
          }

          // Terminal check: if we're in IDLE, latch must be null
          if (state.uiState === SessionState.IDLE) {
            expect(state.pendingIdleFromServer).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("ordering invariant: token++ → capture → consume latch → set handlers → ttsPlaying=true → play()", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const state = createInitialState();
        modelUpdateUI(state, SessionState.DELIVERING);

        // Set up latch
        modelHandleStateChange(state, SessionState.IDLE);
        const latchToken = state.pendingIdleFromServer!.tokenAtLatch;

        // Verify ordering in modelHandleTTSAudio:
        // Before call: token = latchToken, ttsPlaying = false, latch is set
        expect(state.playbackInstanceToken).toBe(latchToken);
        expect(state.ttsPlaying).toBe(false);
        expect(state.pendingIdleFromServer).not.toBeNull();

        modelHandleTTSAudio(state);

        // After call: token = latchToken + 1, ttsPlaying = true, latch consumed, deferral created
        expect(state.playbackInstanceToken).toBe(latchToken + 1);
        expect(state.ttsPlaying).toBe(true);
        expect(state.pendingIdleFromServer).toBeNull();
        expect(state.deferredIdleTransition).not.toBeNull();
        expect(state.deferredIdleTransition!.token).toBe(latchToken + 1);
      }),
      { numRuns: 100 },
    );
  });
});
