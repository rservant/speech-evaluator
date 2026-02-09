# Implementation Plan: TTS Playback Glitch Fix

## Overview

Client-side fix for the race condition between server-sent `state_change: idle` and async `HTMLAudioElement.play()`. Introduces a deferred IDLE transition mechanism gated on a playback instance token. All changes are in `public/index.html`. Property tests model the deferral state machine in `src/tts-playback-deferral.property.test.ts`.

## Tasks

- [ ] 1. Add deferral state variables and helper functions
  - [ ] 1.1 Add `playbackInstanceToken`, `deferredIdleTransition`, `pendingIdleFromServer` variables and `applyDeferredIdle(token)`, `cancelDeferredIdle()`, `transitionToIdle()` functions to the client script in `public/index.html`
    - Add `let playbackInstanceToken = 0;` and `let deferredIdleTransition = null;` to the TTS Audio Playback State section
    - Add `let pendingIdleFromServer = null;` — token-stamped latch for the "IDLE arrives before ttsPlaying=true" ordering edge case. Shape: `{ tokenAtLatch: number } | null`. Set when `state_change: idle` arrives while in any non-IDLE state but `ttsPlaying` is false (uses `currentState !== IDLE`). Stores the current `playbackInstanceToken` at latch time. Idempotent: won't re-latch if already set. Does NOT fire on redundant IDLE→IDLE. Consumed by `handleTTSAudio` with token validation: only creates deferral if `latchToken + 1 === currentToken` (expected progression); otherwise discards as stale — prevents a latent latch from attaching to unrelated audio. Cleared by: `handleTTSAudio` (consumed or discarded), `forceStopTtsAndCancelDeferral()` (force-stop paths), and `transitionToIdle()` (normal IDLE application)
    - Add `applyDeferredIdle(token)` function: explicit no-op if `deferredIdleTransition === null` (no deferral pending) or token mismatch; otherwise clears `deferredIdleTransition = null` BEFORE calling `transitionToIdle()` — this ordering prevents reentrancy (e.g., duplicate `onended`) from re-running `transitionToIdle()`
    - Add `transitionToIdle()` function: single authoritative entry point for ALL IDLE transitions with cooldown — calls `updateUI(SessionState.IDLE)` FIRST (pure visual flip), then `startCooldown()` (timers/side effects). Must clear `pendingIdleFromServer = null` before `updateUI`. Idempotency guard: `currentState === SessionState.IDLE && cooldownTimerId !== null` — this is precise enough to distinguish "IDLE with cooldown active" (no-op) from "IDLE without cooldown" (needs cooldown start, e.g., recovery paths). Using just `currentState === IDLE` would skip cooldown in legitimate cases. ALL code paths that transition to IDLE must go through `transitionToIdle()` (including `triggerTTSFailSafe()`) — this prevents double-cooldown, missing-cooldown, and micro-hiccup bugs
    - Add `cancelDeferredIdle()` function: sets `deferredIdleTransition = null`, bumps `playbackInstanceToken++` (invalidates in-flight `onended` closures). Does NOT set `ttsPlaying = false`, does NOT clear `pendingIdleFromServer`, and does NOT stop playback — it is purely a deferral/token operation
    - Add `forceStopTtsAndCancelDeferral()` function: the single composite primitive for all force-stop and error paths. Calls `cancelDeferredIdle()`, then sets `pendingIdleFromServer = null`, then calls `stopTTSPlayback()`. Post-conditions hold immediately after the call: `deferredIdleTransition === null`, `pendingIdleFromServer === null`, `playbackInstanceToken` bumped, `ttsPlaying === false`, audio event handlers nulled. Note: this is NOT truly atomic against queued browser events — a late `onended` CAN still fire after this call returns. That is safe because the token bump + handler nulling ensures late callbacks are no-ops. Do not assume "no late callbacks possible"; assume "late callbacks are harmless." ALL force-stop paths (panic mute, revoke consent, ws close, onerror, play reject) MUST call this instead of calling the pieces separately
    - _Requirements: 1.1, 1.2, 1.7, 1.9, 1.10, 2.3_

- [ ] 2. Modify handleStateChange to defer IDLE during active playback
  - [ ] 2.1 Update `handleStateChange(newState)` in `public/index.html` to check `ttsPlaying` before applying IDLE transition
    - Implement the IDLE transition decision chain as an explicit else-if chain (Branches A→B→C→D) to prevent future reorder mistakes:
      - **Branch A** (`newState === IDLE && ttsPlaying`): Defer — keyed on the authoritative `ttsPlaying` flag ONLY, NOT on `previousState === DELIVERING`. Debug only: if `ttsPlaying` is true but `ttsAudioElement` is null or `.src` is empty, log `console.warn(...)` — no behavioural change, still defers. Idempotent: only store `deferredIdleTransition = { token: playbackInstanceToken }` if `deferredIdleTransition === null`. Return early (skip `updateUI`). Do not mutate `ttsPlaying`, `ttsAudioElement`, or `playbackInstanceToken` — only store the deferral and return
      - **Branch B** (`else if newState === IDLE && !ttsPlaying && currentState !== SessionState.IDLE`): Latch — set `pendingIdleFromServer = { tokenAtLatch: playbackInstanceToken }` (idempotent — only if currently null) and return early (don't transition yet). Token-stamped so `handleTTSAudio` can validate progression. Uses `currentState !== IDLE` rather than `=== DELIVERING` to handle reconnect oddities, missed delivering messages, or state already flipped due to other UI logic. Does NOT fire on redundant IDLE→IDLE. If `handleTTSAudio` never runs, the latch is harmless — `transitionToIdle()` and `forceStopTtsAndCancelDeferral()` both clear it
      - **Branch C** (`else if newState === IDLE`): Immediate transition — call `transitionToIdle()` unconditionally. ALL IDLE transitions use the single unified path — no second code path where timing glitches can creep back in
      - **Branch D** (else — non-IDLE `newState`): Pass through — call `updateUI(newState)` as before
    - Add `cancelDeferredIdle()` call in the `!ttsDeliveryComplete` force-stop branch — use `forceStopTtsAndCancelDeferral()` which handles deferral/token, latch, and ttsPlaying in one call
    - When transitioning to IDLE without deferral from DELIVERING, call `transitionToIdle()` instead of separate `startCooldown()` + `updateUI()`
    - _Requirements: 1.1, 1.3, 1.6, 1.10_

  - [ ]* 2.2 Write property test: Deferred IDLE round-trip (Property 1)
    - **Property 1: Deferred IDLE round-trip**
    - **Validates: Requirements 1.1, 1.2, 1.4, 3.2**

  - [ ]* 2.3 Write property test: Immediate IDLE when not playing (Property 2)
    - **Property 2: Immediate IDLE when not playing**
    - **Validates: Requirements 1.3**

  - [ ]* 2.4 Write property test: Duplicate idle idempotency (Property 3)
    - **Property 3: Duplicate idle idempotency**
    - **Validates: Requirements 1.6**

  - [ ]* 2.5 Write property test: Stale token rejection (Property 4)
    - **Property 4: Stale token rejection**
    - **Validates: Requirements 1.7**

- [ ] 3. Modify handleTTSAudio to bind playback instance token
  - [ ] 3.1 Update `handleTTSAudio(audioData)` in `public/index.html` to increment `playbackInstanceToken` and capture it in the `onended`/`onerror` closures
    - Explicit single ordering: `token++` → `currentToken = token` → consume latch → set `onended`/`onerror` handlers → `ttsPlaying = true` → call `play()`. This is a MUST-NOT-REFACTOR ordering invariant — reordering any step (especially moving latch consumption after play() or after setting ttsPlaying) can reintroduce the race condition. Encode this ordering in the property model (Property 11)
    - Increment `playbackInstanceToken++` first
    - Capture `const currentToken = playbackInstanceToken` for closure
    - Consume `pendingIdleFromServer` latch with token validation: if `pendingIdleFromServer` is non-null, check if `pendingIdleFromServer.tokenAtLatch + 1 === currentToken` (expected progression). If match: clear latch and create `deferredIdleTransition = { token: currentToken }` (if not already set). If mismatch: clear latch without creating deferral (stale latch from earlier session phase — prevents attaching to unrelated audio like replay). Always clear the latch regardless of match result
    - Set `onended` and `onerror` handlers BEFORE `play()` so they're ready for immediate events
    - Set `ttsPlaying = true` immediately before calling `play()` (covers the decode gap)
    - In `onended`: set `ttsPlaying = false`, call `cleanupTTSAudio()` FIRST (so `updateUI` sees consistent flags), then call `applyDeferredIdle(currentToken)`
    - `cleanupTTSAudio()` (and/or `stopTTSPlayback()`) must null out event handlers: `ttsAudioElement.onended = null; ttsAudioElement.onerror = null;` — prevents lingering handlers from firing on reused elements and reduces reentrancy risk. Handler nulling must live in `stopTTSPlayback()` (not only in `cleanupTTSAudio()`) so that force-stop paths that skip cleanup are still safe
    - In `onerror`: call `triggerTTSFailSafe()` only — it calls `forceStopTtsAndCancelDeferral()` internally
    - In `play().catch()`: call `triggerTTSFailSafe()` only — same contract. Browsers can reject `play()` without firing `onerror`
    - `ttsPlaying` must be set `false` on ALL exit paths: `onended` (directly), `onerror`/`play().catch()` (via `triggerTTSFailSafe` → `stopTTSPlayback`), `stopTTSPlayback()` (directly). Missing any exit creates a dead deferral (Property 9 violation)
    - _Requirements: 1.2, 1.7, 1.10, 4.1, 4.3_

- [ ] 4. Modify panic mute, revoke consent, and WebSocket close to cancel deferral
  - [ ] 4.1 Update `onPanicMute()` in `public/index.html` to call `forceStopTtsAndCancelDeferral()` instead of separate `cancelDeferredIdle()` + `stopTTSPlayback()`
    - Single call handles: bump token, clear deferral, stop audio, clear ttsPlaying
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 4.2 Update `onRevokeConsent()` in `public/index.html` to call `forceStopTtsAndCancelDeferral()` instead of separate `cancelDeferredIdle()` + `stopTTSPlayback()`
    - Same single-call pattern as panic mute
    - _Requirements: 2.1, 2.3_

  - [ ] 4.3 Update `ws.onclose` handler in `public/index.html` to fail-safe on playback, deferral, latch, OR non-IDLE state
    - Condition: `if (ttsPlaying || deferredIdleTransition !== null || pendingIdleFromServer !== null || currentState !== SessionState.IDLE)` — includes `pendingIdleFromServer` to cover the case where the latch is set (e.g., PROCESSING→IDLE with !ttsPlaying) and the socket drops before `handleTTSAudio` runs. Also uses `currentState !== IDLE` instead of `=== DELIVERING` for consistency with the broadened latch condition
    - Call `triggerTTSFailSafe()` only — it calls `forceStopTtsAndCancelDeferral()` internally (callers never call forceStop separately)
    - `triggerTTSFailSafe()` contract: calls `forceStopTtsAndCancelDeferral()` first (idempotent if already stopped), shows written evaluation panel, then calls `transitionToIdle()`. Single entry point — callers never need to force-stop before calling it
    - _Requirements: 4.2_

  - [ ]* 4.4 Write property test: Panic mute always clears deferral and playback (Property 5)
    - **Property 5: Panic mute always clears deferral and playback**
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 4.5 Write property test: Abort during deferral triggers fail-safe (Property 6)
    - **Property 6: Abort during deferral triggers fail-safe**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ]* 4.6 Write property test: Cancellation invalidates token (Property 7)
    - **Property 7: Cancellation invalidates token**
    - **Validates: Requirements 1.7, 2.3**

  - [ ]* 4.7 Write property test: play() rejection doesn't deadlock (Property 8)
    - **Property 8: play() rejection doesn't deadlock**
    - **Validates: Requirements 4.3**

  - [ ]* 4.8 Write property test: No dead deferral (Property 9)
    - **Property 9: No dead deferral**
    - **Validates: Requirements 1.2, 4.1, 4.2, 4.3**
    - Generated event sequences MUST include: `state_change: idle` arriving before `handleTTSAudio`, `ws.onclose` while playing but before deferral is created, duplicate `onended` events, `play()` rejection without `onerror`

  - [ ]* 4.9 Write property test: No premature replay visibility (Property 10)
    - **Property 10: No premature replay visibility**
    - **Validates: Requirements 1.4, 1.8**
    - Assert: `ttsPlaying === true` implies `uiState !== IDLE` unless a force-stop path was executed. This is the direct encoding of the original bug
    - Model must include a `forcedStop: boolean` flag, set by panic mute / revoke / fail-safe actions. Property 10 asserts: if `ttsPlaying && !forcedStop` then `uiState !== IDLE`

  - [ ]* 4.10 Write property test: pendingIdleFromServer latch correctness (Property 11)
    - **Property 11: pendingIdleFromServer latch correctness**
    - **Validates: Requirements 1.10**
    - Assert: when `state_change: idle` arrives while `currentState !== IDLE && !ttsPlaying`, `pendingIdleFromServer` is set with the current token and no IDLE transition occurs. Generator must include paths from PROCESSING→IDLE and RECORDING→IDLE (not just DELIVERING→IDLE)
    - Assert: when `handleTTSAudio` runs with `pendingIdleFromServer !== null` and token matches expected progression (`latchToken + 1 === currentToken`), the latch is consumed and a deferral is created with the new token
    - Assert: when `handleTTSAudio` runs with `pendingIdleFromServer !== null` but token does NOT match (stale latch from earlier session phase), the latch is discarded without creating a deferral — prevents attaching to unrelated audio
    - Assert: when a force-stop event occurs with `pendingIdleFromServer !== null` (before `handleTTSAudio`), the latch is cleared
    - Assert: after any terminal event, `pendingIdleFromServer === null` (no dangling latch)
    - Assert: the ordering invariant in `handleTTSAudio` is: `token++` → `capture token` → `consume latch` → `set handlers` → `ttsPlaying = true` → `play()`. This is a must-not-refactor invariant encoded in the property model

- [ ] 5. Checkpoint — Verify all paths
  - Ensure all tests pass, ask the user if questions arise.
  - Manually verify: deliver from cache → audio plays smoothly → Replay button appears only after audio ends
  - Verify panic mute still works instantly during playback
  - Verify replay path uses same deferral logic (Requirement 5.1, 5.2)
  - Audit: search for all call sites of `ttsAudioElement.play()` and ensure they set token/handlers identically (i.e., funnel through `handleTTSAudio`). If replay uses a different code path, it will reintroduce the race
  - Audit: grep for direct `updateUI(SessionState.IDLE)` calls and ensure they all route through `transitionToIdle()` (except `onPanicMute` which has its own explicit path). Refactor any existing `updateUI(SessionState.IDLE)` call sites to call `transitionToIdle()` instead — this is a required refactor step, not just a verification
  - Audit: grep for `playbackInstanceToken++` and confirm only two call sites exist: `handleTTSAudio` (new playback) and `cancelDeferredIdle` (force-stop). If any other site increments the token, the latch's `+1` progression check becomes wrong and will silently discard legitimate latches
  - Audit: grep for `ttsAudioElement.src =`, `.load()`, `removeChild` — any code that mutates the audio element while `ttsPlaying` is true can cause `onended` to never fire (browser-dependent). Flag and protect or remove
  - Verify late `onended` after panic mute does not trigger unexpected IDLE transition
  - Verify WS disconnect mid-playback (no deferral yet) triggers fail-safe correctly

- [ ] 6. Write unit tests for specific scenarios
  - [ ]* 6.1 Write unit tests for deferral edge cases
    - Happy path: deliver → deferred → onended → IDLE
    - No-defer: idle arrives when not playing → immediate IDLE
    - Panic mute during deferral → immediate IDLE, deferral cancelled, token bumped, ttsPlaying false
    - Audio error during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false
    - WebSocket disconnect during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false
    - WebSocket disconnect mid-playback (no deferral yet) → fail-safe, ttsPlaying false
    - Stale onended after cancellation (token mismatch from bump) → ignored
    - Duplicate idle during deferral → idempotent
    - Replay path follows same deferral as initial delivery
    - play() rejection during deferral → fail-safe, deferral cancelled, token bumped, ttsPlaying false
    - Late onended after panic mute cannot apply IDLE (token was bumped)
    - No dead deferral: every path that sets ttsPlaying=false also resolves any pending deferral
    - IDLE arrives before ttsPlaying=true (pendingIdleFromServer latch): idle arrives while DELIVERING but ttsPlaying is false → latch set with token, no IDLE transition → handleTTSAudio consumes latch (token matches) and creates deferral → onended applies deferred IDLE
    - Stale latch discarded: latch set during earlier session phase, then unrelated audio arrives much later (token mismatch) → latch discarded without creating deferral
    - Latch cleared by force-stop: pendingIdleFromServer is non-null, panic mute fires before handleTTSAudio → latch cleared, no dangling state
    - ws.onclose with pending latch: pendingIdleFromServer is non-null, socket drops before handleTTSAudio → fail-safe triggers, latch cleared
    - Latch set, no audio ever arrives: pendingIdleFromServer is non-null, handleTTSAudio never runs (server error, dropped binary frame) → ws.onclose or triggerTTSFailSafe fires → latch cleared, UI reaches IDLE, no stuck state
    - Latch from PROCESSING→IDLE: idle arrives while in PROCESSING (not DELIVERING) with !ttsPlaying → latch set, same behavior as DELIVERING case
    - transitionToIdle() idempotency: already IDLE with cooldown running → no-op; IDLE without cooldown (recovery) → starts cooldown
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.7, 1.10, 2.1, 2.3, 4.1, 4.2, 4.3, 5.1_

- [ ] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- All changes are in `public/index.html` — no server-side modifications
- Property tests model the deferral state machine as a pure function for fast-check generation
- The server protocol is unchanged; this is purely a client-side timing fix
- `cancelDeferredIdle()` bumps the token but does NOT clear `ttsPlaying` or stop playback — it is purely a deferral/token operation. Never call it alone in force-stop paths
- `forceStopTtsAndCancelDeferral()` is the single composite primitive for ALL force-stop and error paths — calls `cancelDeferredIdle()`, clears `pendingIdleFromServer = null`, then calls `stopTTSPlayback()`. Post-conditions hold immediately: `deferredIdleTransition = null`, `pendingIdleFromServer = null`, token bumped, `ttsPlaying = false`, audio event handlers nulled. Note: NOT truly atomic against queued browser events — late `onended` CAN still fire, but token bump + handler nulling makes late callbacks harmless. Do not assume "no late callbacks possible"; assume "late callbacks are harmless"
- `transitionToIdle()` is the single authoritative function for ALL IDLE transitions — clears `pendingIdleFromServer`, calls `updateUI(IDLE)` (visual), then `startCooldown()` (timers). Idempotency guard: `currentState === SessionState.IDLE && cooldownTimerId !== null` — precise enough to distinguish "IDLE with cooldown active" (no-op) from "IDLE without cooldown" (needs cooldown start). ALL paths must go through it (including `triggerTTSFailSafe()`, `applyDeferredIdle()`, `handleStateChange()`) — prevents double-cooldown, missing-cooldown, and micro-hiccup bugs
- `pendingIdleFromServer` is the token-stamped latch for the "IDLE arrives before ttsPlaying=true" ordering edge case. Shape: `{ tokenAtLatch: number } | null`. Set by `handleStateChange` when IDLE arrives while in any non-IDLE state but `ttsPlaying` is false (uses `currentState !== IDLE`). Idempotent: won't re-latch if already set. Does NOT fire on redundant IDLE→IDLE. Consumed by `handleTTSAudio` with token validation: only creates deferral if `latchToken + 1 === currentToken` (expected progression); otherwise discards as stale — prevents a latent latch from attaching to unrelated audio. Cleared by: `handleTTSAudio` (consumed or discarded), `forceStopTtsAndCancelDeferral()` (force-stop paths), `transitionToIdle()` (normal IDLE application). Never left dangling
- `ttsPlaying` must be cleared on ALL exit paths — missing one creates a dead deferral where IDLE never applies
- `triggerTTSFailSafe()` contract: calls `forceStopTtsAndCancelDeferral()` internally (idempotent), shows written evaluation, calls `transitionToIdle()`. Callers never force-stop before calling it — single entry point, no double-stop/double-cooldown risk
- `cleanupTTSAudio()` and/or `stopTTSPlayback()` must null out `ttsAudioElement.onended` and `ttsAudioElement.onerror` — handler nulling must live in `stopTTSPlayback()` so force-stop paths that skip cleanup are still safe
- Server message ordering in `deliverFromCache()` is: `state_change: delivering` → `evaluation_ready` → binary audio → `tts_complete` → `state_change: idle` — all synchronous, no awaits. The client always receives audio before idle on the same WebSocket. The race is between the synchronous WS message handler and async `HTMLAudioElement.play()`, not between message ordering. If the server protocol ever becomes async, the deferral mechanism still handles it correctly because it's keyed on `ttsPlaying` (set before `play()`), not on message arrival order
