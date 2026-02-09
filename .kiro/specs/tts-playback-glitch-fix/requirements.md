# Requirements Document

## Introduction

This spec addresses a TTS playback glitch in the AI Toastmasters Evaluator. When the server delivers evaluation audio from the eager cache (`deliverFromCache`), the `tts_complete` and `state_change: idle` messages arrive at the client before the browser has started decoding/playing the audio. The premature IDLE transition triggers DOM mutations (hiding the speaking indicator, showing the Replay button, starting cooldown) that cause a brief audio pause/hickup. The Replay button appearing mid-playback confirms the UI is transitioning too early.

The root cause is a race condition: the server sends audio data, `tts_complete`, and `state_change: idle` synchronously with no delay, but `HTMLAudioElement.play()` is asynchronous. The fix is client-side: defer the visual IDLE transition until the audio element's `onended` event fires, while preserving panic mute's ability to force-stop immediately.

The same structural issue exists in the synchronous fallback path of `handleDeliverEvaluation` (Branch 3) and `handleReplayTTS`.

## Glossary

- **Client**: The browser-side JavaScript application in `public/index.html`
- **Server**: The Node.js WebSocket server in `src/server.ts`
- **TTS_Audio_Element**: The `HTMLAudioElement` instance used for TTS playback (`ttsAudioElement`)
- **IDLE_Transition**: The visual UI update that occurs when the session moves to the IDLE state (hiding speaking indicator, showing Replay button, updating status text, starting cooldown)
- **Active_Playback**: TTS_Audio_Element has either begun playback OR playback has been requested via `play()` but the audio element has not yet fired `onended` or `onerror`. This includes the decode/buffer delay window before `onplaying` fires. Checking `.paused === false` alone is insufficient — the `ttsPlaying` flag (set to `true` before `play()` is called) is the authoritative indicator.
- **Deferred_IDLE**: A pending IDLE transition that is held until audio playback completes. Each Deferred_IDLE is bound to a Playback_Instance_Token (not to the audio element identity).
- **Playback_Instance_Token**: An identifier (e.g., a monotonic counter) that associates a Deferred_IDLE with the specific playback that triggered it, preventing stale `onended` events from a previous playback from applying a later Deferred_IDLE.
- **Glitch_Free_Playback**: Audio playback that is continuous with no audible pause, restart, or buffer gap caused by UI state transitions or DOM mutations.
- **Panic_Mute**: The emergency stop control that immediately silences all audio and resets the session
- **Auto_Purge_Timer**: The 10-minute server-side timer that purges session data after delivery completes

## Requirements

### Requirement 1: Defer Visual IDLE Transition During Active Playback

**User Story:** As an operator, I want the speaking indicator to remain visible and the Replay button to stay hidden until TTS audio finishes playing, so that the UI accurately reflects what is happening in the room.

#### Acceptance Criteria

1. WHEN `state_change: idle` arrives from the server while TTS_Audio_Element is in Active_Playback (regardless of the previous client-side state), THE Client SHALL store a Deferred_IDLE bound to the current Playback_Instance_Token and continue displaying the DELIVERING visual state. The deferral condition is keyed on Active_Playback, not on `previousState === DELIVERING`
2. WHEN the TTS_Audio_Element `onended` event fires and the `onended` event's Playback_Instance_Token matches the stored Deferred_IDLE token, THE Client SHALL apply the IDLE_Transition including updating the status indicator, showing the Replay button, and starting the cooldown timer
3. WHEN `state_change: idle` arrives from the server and TTS_Audio_Element is not in Active_Playback, THE Client SHALL apply the IDLE_Transition immediately with no deferral
4. WHILE a Deferred_IDLE is pending, THE Client SHALL keep the speaking indicator visible and the Replay button hidden
5. WHILE a Deferred_IDLE is pending, THE Client SHALL NOT modify the TTS_Audio_Element playback state (no `pause()`, `load()`, or `src` mutation)
6. WHEN additional `state_change: idle` messages arrive while a Deferred_IDLE is already pending, THE Client SHALL treat the Deferred_IDLE as idempotent and not trigger additional transitions
7. WHEN the TTS_Audio_Element `onended` event fires with a Playback_Instance_Token that does not match the stored Deferred_IDLE token, THE Client SHALL ignore the stale event
8. THE Client SHALL achieve Glitch_Free_Playback — audio playback SHALL be continuous with no audible pause, restart, or buffer gap caused by UI state transitions
9. THE `ttsPlaying` flag SHALL be set to `false` on every exit path from Active_Playback: `onended` (directly), `onerror` (via `triggerTTSFailSafe()` → `stopTTSPlayback()`), `play()` rejection (via `triggerTTSFailSafe()` → `stopTTSPlayback()`), `stopTTSPlayback()` (directly), and `triggerTTSFailSafe()` (via `stopTTSPlayback()`). `cancelDeferredIdle()` does NOT clear `ttsPlaying` — it only clears the deferral and bumps the token. Force-stop paths (panic mute, revoke consent, ws close) call `stopTTSPlayback()` alongside `cancelDeferredIdle()` to clear `ttsPlaying`. Failure to clear `ttsPlaying` on any exit path creates a dead deferral where IDLE never applies
10. WHEN `state_change: idle` arrives from the server while the Client is in any non-IDLE state AND `ttsPlaying` is false (i.e., the binary audio frame has not yet been processed by `handleTTSAudio` — due to handler ordering, microtask batching, the binary frame being queued after the JSON frame, reconnect oddities, or missed `state_change: delivering` messages), THE Client SHALL set a `pendingIdleFromServer` latch storing the current `playbackInstanceToken` (idempotent — do not re-latch if already set) and NOT transition to IDLE. This condition uses `currentState !== IDLE` rather than `currentState === DELIVERING` to handle edge cases where the DELIVERING state was missed or corrupted. It does NOT fire on redundant IDLE→IDLE transitions. WHEN `handleTTSAudio` subsequently runs and finds `pendingIdleFromServer` is non-null, it SHALL check token progression: if the latch token + 1 equals the new playback token (expected progression), it SHALL consume the latch and create a `deferredIdleTransition` bound to the new Playback_Instance_Token. If the token does not match (stale latch from an earlier session phase), it SHALL discard the latch without creating a deferral — this prevents a latent latch from attaching to unrelated audio (e.g., replay triggered much later). IF `handleTTSAudio` never runs (e.g., no audio was sent), the latch is cleared by `forceStopTtsAndCancelDeferral()` or `transitionToIdle()` and is harmless

### Requirement 2: Panic Mute Overrides Deferred Transition

**User Story:** As an operator, I want panic mute to immediately silence audio and reset the UI regardless of any deferred state, so that I can always regain control of the meeting environment instantly.

#### Acceptance Criteria

1. WHEN the operator triggers Panic_Mute while a Deferred_IDLE is pending, THE Client SHALL cancel the Deferred_IDLE, invalidate the current Playback_Instance_Token (monotonic bump), stop TTS playback immediately, and transition the UI to IDLE without waiting for `onended`
2. WHEN the operator triggers Panic_Mute while TTS audio is playing with no Deferred_IDLE, THE Client SHALL stop TTS playback immediately, invalidate the current Playback_Instance_Token, and transition the UI to IDLE
3. AFTER any cancellation (Panic_Mute, revoke consent, error, or disconnect), a late `onended` event from the previous Playback_Instance_Token SHALL NOT apply any IDLE transition or trigger any state change

### Requirement 3: Auto-Purge Timer Alignment

**User Story:** As a system operator, I want the auto-purge retention timer to start after audio playback actually finishes on the client, so that the 10-minute window reflects when the audience last heard the evaluation.

#### Acceptance Criteria

1. THE Server SHALL continue starting the Auto_Purge_Timer immediately after sending `state_change: idle` (no server-side change)
2. WHEN the Deferred_IDLE is applied on the client after `onended`, THE Client SHALL treat the moment of IDLE_Transition as the effective delivery-complete time for UI purposes only
3. THE Client deferral logic SHALL NOT alter server-side purge timing or replay eligibility

### Requirement 4: TTS Error During Deferred State

**User Story:** As an operator, I want the system to gracefully handle audio errors that occur while the IDLE transition is deferred, so that I always see the written evaluation as a fallback.

#### Acceptance Criteria

1. IF the TTS_Audio_Element emits an `onerror` event while a Deferred_IDLE is pending, THEN THE Client SHALL cancel the Deferred_IDLE, invalidate the Playback_Instance_Token, stop TTS playback, ensure the written evaluation panel is visible, and apply the IDLE_Transition immediately
2. IF the WebSocket connection drops while TTS audio is in Active_Playback OR a Deferred_IDLE is pending, THEN THE Client SHALL cancel the Deferred_IDLE, invalidate the Playback_Instance_Token, stop TTS playback, ensure the written evaluation panel is visible, and apply the IDLE_Transition immediately. The condition is keyed on `ttsPlaying` too — the WebSocket can drop mid-playback before `state_change: idle` arrives
3. IF the `play()` Promise rejects while a Deferred_IDLE is pending, THEN THE Client SHALL cancel the Deferred_IDLE, invalidate the Playback_Instance_Token, stop TTS playback, ensure the written evaluation panel is visible, and apply the IDLE_Transition immediately. Note: browsers can reject `play()` without firing `onerror`, so this must be handled separately in the `.catch()` handler

### Requirement 5: Replay Path Consistency

**User Story:** As an operator, I want the Replay Evaluation flow to have the same glitch-free behavior as the initial delivery, so that playback is smooth regardless of which path triggered it.

#### Acceptance Criteria

1. WHEN `state_change: idle` arrives during a replay-initiated TTS playback, THE Client SHALL defer the IDLE_Transition using the same mechanism as the initial delivery path
2. THE Client SHALL apply identical deferral logic for all code paths that result in TTS audio playback followed by a server-initiated IDLE transition
