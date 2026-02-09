// Unit Tests for TTS Playback Deferral State Machine
// Feature: tts-playback-glitch-fix, Task 6.1
// Requirements: 1.1, 1.2, 1.3, 1.6, 1.7, 1.10, 2.1, 2.3, 4.1, 4.2, 4.3, 5.1

import { describe, it, expect } from "vitest";
import {
  SessionState,
  createInitialState,
  modelHandleStateChange,
  modelHandleTTSAudio,
  modelOnEnded,
  modelPanicMute,
  modelAudioError,
  modelWsDisconnect,
  modelPlayReject,
  modelForceStopTtsAndCancelDeferral,
  modelCancelDeferredIdle,
  modelTransitionToIdle,
} from "./tts-playback-deferral.property.test.js";

describe("TTS Playback Deferral — Unit Tests", () => {
  // ── 1. Happy path: deliver → deferred → onended → IDLE ──

  it("happy path: deliver → deferred → onended → IDLE", () => {
    const state = createInitialState();

    // Transition to DELIVERING, start audio
    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const audioToken = state.playbackInstanceToken;

    expect(state.ttsPlaying).toBe(true);
    expect(state.uiState).toBe(SessionState.DELIVERING);

    // Server sends state_change: idle while audio is playing
    modelHandleStateChange(state, SessionState.IDLE);

    // IDLE is deferred
    expect(state.deferredIdleTransition).not.toBeNull();
    expect(state.deferredIdleTransition!.token).toBe(audioToken);
    expect(state.uiState).toBe(SessionState.DELIVERING);
    expect(state.cooldownStarted).toBe(false);

    // Audio ends naturally
    modelOnEnded(state, audioToken);

    // IDLE applied, cooldown started
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.currentState).toBe(SessionState.IDLE);
    expect(state.ttsPlaying).toBe(false);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.cooldownStarted).toBe(true);
  });

  // ── 2. No-defer: idle arrives when not playing → immediate IDLE (Branch C for IDLE→IDLE) ──

  it("no-defer: idle arrives when already IDLE and not playing → immediate IDLE", () => {
    const state = createInitialState();

    // Already in IDLE (initial state), not playing
    expect(state.currentState).toBe(SessionState.IDLE);
    expect(state.ttsPlaying).toBe(false);

    state.cooldownStarted = false;
    modelHandleStateChange(state, SessionState.IDLE);

    // Branch C: immediate transition via transitionToIdle()
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.cooldownStarted).toBe(true);
  });

  // ── 3. Panic mute during deferral → immediate IDLE, deferral cancelled, token bumped, ttsPlaying false ──

  it("panic mute during deferral → immediate IDLE, deferral cancelled, token bumped, ttsPlaying false", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const tokenBeforePanic = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.deferredIdleTransition).not.toBeNull();

    // Panic mute
    modelPanicMute(state);

    expect(state.deferredIdleTransition).toBeNull();
    expect(state.ttsPlaying).toBe(false);
    expect(state.currentState).toBe(SessionState.IDLE);
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.playbackInstanceToken).toBeGreaterThan(tokenBeforePanic);
    expect(state.pendingIdleFromServer).toBeNull();
  });

  // ── 4. Audio error during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false ──

  it("audio error during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const tokenBefore = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.deferredIdleTransition).not.toBeNull();

    modelAudioError(state);

    expect(state.deferredIdleTransition).toBeNull();
    expect(state.ttsPlaying).toBe(false);
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.evaluationPanelVisible).toBe(true);
    expect(state.playbackInstanceToken).toBeGreaterThan(tokenBefore);
  });

  // ── 5. WebSocket disconnect during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false ──

  it("WebSocket disconnect during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const tokenBefore = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.deferredIdleTransition).not.toBeNull();

    modelWsDisconnect(state);

    expect(state.deferredIdleTransition).toBeNull();
    expect(state.ttsPlaying).toBe(false);
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.evaluationPanelVisible).toBe(true);
    expect(state.playbackInstanceToken).toBeGreaterThan(tokenBefore);
  });

  // ── 6. WebSocket disconnect mid-playback (no deferral yet) → fail-safe, ttsPlaying false ──

  it("WebSocket disconnect mid-playback (no deferral yet) → fail-safe, ttsPlaying false", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);

    // No state_change: idle yet — no deferral
    expect(state.ttsPlaying).toBe(true);
    expect(state.deferredIdleTransition).toBeNull();

    modelWsDisconnect(state);

    expect(state.ttsPlaying).toBe(false);
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.evaluationPanelVisible).toBe(true);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.pendingIdleFromServer).toBeNull();
  });

  // ── 7. Stale onended after cancellation (token mismatch from bump) → ignored ──

  it("stale onended after cancellation (token mismatch from bump) → ignored", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const oldToken = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.deferredIdleTransition).not.toBeNull();

    // Cancel deferral (bumps token)
    modelCancelDeferredIdle(state);
    expect(state.playbackInstanceToken).toBeGreaterThan(oldToken);
    expect(state.deferredIdleTransition).toBeNull();

    // Late onended with old token — should be ignored
    state.cooldownStarted = false;
    const uiBefore = state.uiState;
    modelOnEnded(state, oldToken);

    // No state change from stale event
    expect(state.uiState).toBe(uiBefore);
    expect(state.cooldownStarted).toBe(false);
  });

  // ── 8. Duplicate idle during deferral → idempotent ──

  it("duplicate idle during deferral → idempotent", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const audioToken = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    const originalDeferralToken = state.deferredIdleTransition!.token;
    state.cooldownStarted = false;

    // Send 5 more IDLE messages
    for (let i = 0; i < 5; i++) {
      modelHandleStateChange(state, SessionState.IDLE);
    }

    // Deferral unchanged — idempotent
    expect(state.deferredIdleTransition).not.toBeNull();
    expect(state.deferredIdleTransition!.token).toBe(originalDeferralToken);
    expect(state.uiState).toBe(SessionState.DELIVERING);
    expect(state.cooldownStarted).toBe(false);

    // Complete the round-trip to verify deferral still works
    modelOnEnded(state, audioToken);
    expect(state.uiState).toBe(SessionState.IDLE);
  });

  // ── 9. Replay path follows same deferral as initial delivery ──

  it("replay path follows same deferral as initial delivery (same model functions work for replay)", () => {
    const state = createInitialState();

    // --- Initial delivery ---
    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const firstToken = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);
    modelOnEnded(state, firstToken);
    expect(state.uiState).toBe(SessionState.IDLE);

    // --- Replay: same sequence of model functions ---
    state.cooldownStarted = false;
    state.cooldownTimerId = null; // reset cooldown for replay
    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const replayToken = state.playbackInstanceToken;

    expect(replayToken).toBeGreaterThan(firstToken);
    expect(state.ttsPlaying).toBe(true);
    expect(state.uiState).toBe(SessionState.DELIVERING);

    // Server sends IDLE during replay playback
    modelHandleStateChange(state, SessionState.IDLE);

    // Same deferral mechanism
    expect(state.deferredIdleTransition).not.toBeNull();
    expect(state.deferredIdleTransition!.token).toBe(replayToken);
    expect(state.uiState).toBe(SessionState.DELIVERING);

    // Audio ends
    modelOnEnded(state, replayToken);

    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.ttsPlaying).toBe(false);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.cooldownStarted).toBe(true);
  });

  // ── 10. play() rejection during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false ──

  it("play() rejection during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const tokenBefore = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.deferredIdleTransition).not.toBeNull();

    modelPlayReject(state);

    expect(state.deferredIdleTransition).toBeNull();
    expect(state.ttsPlaying).toBe(false);
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.evaluationPanelVisible).toBe(true);
    expect(state.playbackInstanceToken).toBeGreaterThan(tokenBefore);
    expect(state.pendingIdleFromServer).toBeNull();
  });

  // ── 11. Late onended after panic mute cannot apply IDLE (token was bumped) ──

  it("late onended after panic mute cannot apply IDLE (token was bumped)", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleTTSAudio(state);
    const audioToken = state.playbackInstanceToken;
    modelHandleStateChange(state, SessionState.IDLE);

    // Panic mute — bumps token, clears deferral
    modelPanicMute(state);
    expect(state.uiState).toBe(SessionState.IDLE);

    // Simulate a new non-IDLE state to verify late onended doesn't interfere
    modelHandleStateChange(state, SessionState.RECORDING);
    expect(state.uiState).toBe(SessionState.RECORDING);

    // Late onended from the old playback fires
    modelOnEnded(state, audioToken);

    // Should NOT transition to IDLE — token mismatch
    expect(state.uiState).toBe(SessionState.RECORDING);
  });

  // ── 12. No dead deferral: every path that sets ttsPlaying=false also resolves any pending deferral ──

  it("no dead deferral: every path that sets ttsPlaying=false also resolves any pending deferral", () => {
    // Test each exit path that sets ttsPlaying=false

    // Path 1: onended with matching token
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      const token = state.playbackInstanceToken;
      modelHandleStateChange(state, SessionState.IDLE);
      modelOnEnded(state, token);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }

    // Path 2: audioError (via triggerTTSFailSafe)
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      modelHandleStateChange(state, SessionState.IDLE);
      modelAudioError(state);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }

    // Path 3: playReject (via triggerTTSFailSafe)
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      modelHandleStateChange(state, SessionState.IDLE);
      modelPlayReject(state);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }

    // Path 4: wsDisconnect (via triggerTTSFailSafe)
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      modelHandleStateChange(state, SessionState.IDLE);
      modelWsDisconnect(state);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }

    // Path 5: panicMute (via forceStopTtsAndCancelDeferral)
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      modelHandleStateChange(state, SessionState.IDLE);
      modelPanicMute(state);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }

    // Path 6: forceStopTtsAndCancelDeferral directly
    {
      const state = createInitialState();
      modelHandleStateChange(state, SessionState.DELIVERING);
      modelHandleTTSAudio(state);
      modelHandleStateChange(state, SessionState.IDLE);
      modelForceStopTtsAndCancelDeferral(state);
      expect(state.ttsPlaying).toBe(false);
      expect(state.deferredIdleTransition).toBeNull();
    }
  });

  // ── 13. IDLE arrives before ttsPlaying=true (pendingIdleFromServer latch) ──

  it("IDLE arrives before ttsPlaying=true (pendingIdleFromServer latch): latch → handleTTSAudio consumes → onended applies IDLE", () => {
    const state = createInitialState();

    // In DELIVERING but ttsPlaying is false (audio frame not yet processed)
    modelHandleStateChange(state, SessionState.DELIVERING);
    expect(state.ttsPlaying).toBe(false);

    // IDLE arrives while ttsPlaying is false → Branch B: latch set
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.pendingIdleFromServer).not.toBeNull();
    expect(state.pendingIdleFromServer!.tokenAtLatch).toBe(state.playbackInstanceToken);
    expect(state.uiState).toBe(SessionState.DELIVERING); // no IDLE transition yet
    expect(state.deferredIdleTransition).toBeNull();

    // handleTTSAudio arrives — consumes latch (token matches: latchToken + 1 === new token)
    const latchToken = state.pendingIdleFromServer!.tokenAtLatch;
    modelHandleTTSAudio(state);

    expect(state.pendingIdleFromServer).toBeNull(); // latch consumed
    expect(state.deferredIdleTransition).not.toBeNull();
    expect(state.deferredIdleTransition!.token).toBe(latchToken + 1);
    expect(state.ttsPlaying).toBe(true);

    // onended fires with matching token → deferred IDLE applied
    modelOnEnded(state, latchToken + 1);

    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.ttsPlaying).toBe(false);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.cooldownStarted).toBe(true);
  });

  // ── 14. Stale latch discarded ──

  it("stale latch discarded: latch set during earlier session phase, then unrelated audio arrives much later (token mismatch) → latch discarded without creating deferral", () => {
    const state = createInitialState();

    // Phase 1: DELIVERING, IDLE arrives (latch set)
    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleStateChange(state, SessionState.IDLE);
    expect(state.pendingIdleFromServer).not.toBeNull();

    // Simulate several token bumps (e.g., cancellations, other playbacks)
    modelCancelDeferredIdle(state);
    modelCancelDeferredIdle(state);
    modelCancelDeferredIdle(state);

    // Much later: unrelated audio arrives — token is now latchToken + 1 + 3 bumps
    // Token mismatch: latchToken + 1 !== currentToken
    modelHandleTTSAudio(state);

    // Latch discarded, no deferral created
    expect(state.pendingIdleFromServer).toBeNull();
    expect(state.deferredIdleTransition).toBeNull();
  });

  // ── 15. Latch cleared by force-stop ──

  it("latch cleared by force-stop: pendingIdleFromServer is non-null, panic mute fires before handleTTSAudio → latch cleared, no dangling state", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.pendingIdleFromServer).not.toBeNull();

    // Panic mute before handleTTSAudio
    modelPanicMute(state);

    expect(state.pendingIdleFromServer).toBeNull();
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.uiState).toBe(SessionState.IDLE);
  });

  // ── 16. ws.onclose with pending latch ──

  it("ws.onclose with pending latch: pendingIdleFromServer is non-null, socket drops before handleTTSAudio → fail-safe triggers, latch cleared", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.pendingIdleFromServer).not.toBeNull();

    // WebSocket drops before handleTTSAudio
    modelWsDisconnect(state);

    expect(state.pendingIdleFromServer).toBeNull();
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.evaluationPanelVisible).toBe(true);
  });

  // ── 17. Latch set, no audio ever arrives ──

  it("latch set, no audio ever arrives: pendingIdleFromServer is non-null, handleTTSAudio never runs → ws.onclose fires → latch cleared, UI reaches IDLE, no stuck state", () => {
    const state = createInitialState();

    modelHandleStateChange(state, SessionState.DELIVERING);

    // IDLE arrives but no audio ever comes
    modelHandleStateChange(state, SessionState.IDLE);
    expect(state.pendingIdleFromServer).not.toBeNull();
    expect(state.uiState).toBe(SessionState.DELIVERING); // stuck in DELIVERING

    // handleTTSAudio never runs — server error, dropped binary frame, etc.
    // Eventually ws.onclose fires
    modelWsDisconnect(state);

    // Latch cleared, UI reaches IDLE
    expect(state.pendingIdleFromServer).toBeNull();
    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.deferredIdleTransition).toBeNull();
    expect(state.ttsPlaying).toBe(false);
  });

  // ── 18. Latch from PROCESSING→IDLE ──

  it("latch from PROCESSING→IDLE: idle arrives while in PROCESSING (not DELIVERING) with !ttsPlaying → latch set, same behavior as DELIVERING case", () => {
    const state = createInitialState();

    // In PROCESSING (not DELIVERING), ttsPlaying is false
    modelHandleStateChange(state, SessionState.PROCESSING);
    expect(state.ttsPlaying).toBe(false);

    // IDLE arrives → Branch B: latch set (uses currentState !== IDLE, not === DELIVERING)
    modelHandleStateChange(state, SessionState.IDLE);

    expect(state.pendingIdleFromServer).not.toBeNull();
    expect(state.pendingIdleFromServer!.tokenAtLatch).toBe(state.playbackInstanceToken);
    expect(state.uiState).toBe(SessionState.PROCESSING); // no IDLE transition yet

    // handleTTSAudio consumes latch and creates deferral
    const latchToken = state.pendingIdleFromServer!.tokenAtLatch;
    modelHandleTTSAudio(state);

    expect(state.pendingIdleFromServer).toBeNull();
    expect(state.deferredIdleTransition).not.toBeNull();
    expect(state.deferredIdleTransition!.token).toBe(latchToken + 1);

    // onended applies deferred IDLE
    modelOnEnded(state, latchToken + 1);

    expect(state.uiState).toBe(SessionState.IDLE);
    expect(state.cooldownStarted).toBe(true);
  });

  // ── 19. transitionToIdle() idempotency ──

  it("transitionToIdle() idempotency: already IDLE with cooldown running → no-op; IDLE without cooldown (recovery) → starts cooldown", () => {
    // Case 1: Already IDLE with cooldown running → no-op
    {
      const state = createInitialState();
      modelTransitionToIdle(state);
      expect(state.uiState).toBe(SessionState.IDLE);
      expect(state.cooldownTimerId).not.toBeNull();

      // Reset tracker to detect if cooldown is called again
      state.cooldownStarted = false;

      // Call again — should be no-op (IDLE + cooldown running)
      modelTransitionToIdle(state);
      expect(state.cooldownStarted).toBe(false); // no-op: cooldown not restarted
    }

    // Case 2: IDLE without cooldown (recovery path) → starts cooldown
    {
      const state = createInitialState();
      // Manually set to IDLE without cooldown
      state.currentState = SessionState.IDLE;
      state.uiState = SessionState.IDLE;
      state.cooldownTimerId = null; // no cooldown running
      state.cooldownStarted = false;

      modelTransitionToIdle(state);

      // Should start cooldown since it wasn't running
      expect(state.cooldownStarted).toBe(true);
      expect(state.cooldownTimerId).not.toBeNull();
    }
  });
});
