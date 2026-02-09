---
inclusion: fileMatch
fileMatchPattern: "{**/session-manager*,**/server*,**/audio*,**/public/**}"
---

# Meeting Safety Controls

This document defines the safety controls that protect the live Toastmasters meeting environment. These controls must be consistently implemented across all components that touch session state, audio capture, or UI controls.

## Panic Mute vs Speaker Opt-Out

These are two distinct operations with different data handling semantics.

### Panic Mute
- Purpose: Immediately silence the system (stop audio capture, stop TTS playback).
- Available from: Any session state (RECORDING, PROCESSING, DELIVERING). No-op from IDLE.
- State transition: Current state → IDLE.
- Data handling: Audio chunks are preserved. Transcript, metrics, and evaluation are preserved. The operator can still attempt evaluation from captured data.
- RunId: Incremented to cancel any in-flight async operations (post-speech transcription, LLM generation, TTS synthesis).
- Recovery: Operator can start a new recording or attempt evaluation from existing data.
- UI: Always-visible button, visually distinct (red/danger styling). No confirmation dialog — immediate action.

### Speaker Opt-Out
- Purpose: The speaker requests their data be removed.
- Available from: Any state after recording has started.
- Data handling: All session data purged immediately and irrecoverably (audio chunks, transcript, live transcript, metrics, evaluation, evaluation script).
- Recovery: None. "Save Outputs" becomes unavailable.
- UI: Requires confirmation dialog ("This will permanently delete all data from this speech. Continue?").

## Echo Prevention Invariants

These rules prevent the system's TTS output from being captured by the microphone:

1. When session enters DELIVERING state: mic MediaStream tracks must be hard-stopped (not just muted).
2. After TTS completes and session returns to IDLE: a 2-3 second cooldown period before the mic can be re-armed.
3. During cooldown: the "Start Speech" button remains disabled with a brief indicator.
4. The AudioWorklet must not send any audio chunks while in DELIVERING state.
5. The server must reject/ignore any `audio_chunk` messages received while in DELIVERING state.

## Behavioral Boundaries

- The system never speaks unprompted. TTS only fires when the operator clicks "Deliver Evaluation".
- The system never interrupts a speech in progress. Auto-stop only triggers at the 25-minute hard cap, with operator notification.
- In future phases with voice interaction: the system speaks only when directly triggered or addressed.

## Fail-Safe Silent Mode

If any critical error occurs during TTS delivery (audio device failure, WebSocket disconnect):
- TTS playback stops immediately.
- The written evaluation is displayed as fallback.
- The session transitions to IDLE.
- No automatic retry of audio playback.

## Implementation Checkpoints

When modifying these components, verify compliance:
- Session manager: panicMute() and opt-out purge semantics
- WebSocket handler: audio chunk rejection in DELIVERING state
- Server: runId-based cancellation of async operations
- Browser audio capture: hard-stop and cooldown logic
- UI: button visibility, confirmation dialogs, always-available panic mute
