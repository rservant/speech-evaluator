---
inclusion: fileMatch
fileMatchPattern: "{**/server*,**/public/**,**/*worklet*,**/*websocket*,**/*ws*}"
---

# WebSocket Protocol and Session Contract

This document defines the WebSocket protocol, message schemas, audio streaming contract, and session concurrency rules. Small protocol drift will break client/server integration and tests.

## Message Ordering Requirements

1. The client must send an `audio_format` handshake message before `start_recording`.
2. The server must validate the handshake and respond with `audio_format_error` if invalid, or implicitly accept (no ack message).
3. `audio_chunk` messages are only valid after `start_recording` and before `stop_recording`.
4. `deliver_evaluation` is only valid after `stop_recording` completes (session in PROCESSING state).
5. `save_outputs` is only valid after evaluation delivery completes (session back in IDLE with evaluation data present).
6. `panic_mute` is valid at any time.
7. `set_project_context` is only valid in IDLE state and must precede `start_recording`. The server rejects it with a recoverable error in any other state. Project context becomes immutable once recording starts.
8. `set_vad_config` is only valid in IDLE state and must precede `start_recording`. The server rejects it with a recoverable error in any other state. VAD configuration is locked for the duration of the recording session.
9. `vad_speech_end` is sent by the server during RECORDING state when the VAD monitor detects sustained silence exceeding the configured threshold. It is a suggestion — the operator must confirm via `stop_recording`.
10. `vad_status` is sent by the server periodically (at most 4 per second) during RECORDING state, providing real-time audio energy and speech/silence classification.
11. `data_purged` is sent by the server after session data is purged, either due to speaker opt-out (`reason: "opt_out"`) or auto-purge timeout (`reason: "auto_purge"`). The client must clear stale local state (project context form, VAD config, evaluation/transcript display) upon receipt.

## Client → Server Messages

```typescript
type ClientMessage =
  | { type: "audio_format"; channels: 1; sampleRate: 16000; encoding: "LINEAR16" }
  | { type: "start_recording" }
  | { type: "audio_chunk"; data: ArrayBuffer }
  | { type: "stop_recording" }
  | { type: "deliver_evaluation" }
  | { type: "save_outputs" }
  | { type: "panic_mute" }
  | { type: "set_project_context"; speechTitle: string; projectType: string; objectives: string[] }
  | { type: "set_vad_config"; silenceThresholdSeconds: number; enabled: boolean };
```

## Server → Client Messages

```typescript
type ServerMessage =
  | { type: "state_change"; state: SessionState }
  | { type: "transcript_update"; segments: TranscriptSegment[]; replaceFromIndex: number }
  | { type: "elapsed_time"; seconds: number }
  | { type: "evaluation_ready"; evaluation: StructuredEvaluation; script: string }
  | { type: "tts_audio"; data: ArrayBuffer }
  | { type: "tts_complete" }
  | { type: "outputs_saved"; paths: string[] }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "audio_format_error"; message: string }
  | { type: "vad_speech_end"; silenceDurationSeconds: number }
  | { type: "vad_status"; energy: number; isSpeech: boolean }
  | { type: "data_purged"; reason: "opt_out" | "auto_purge" };
```

## Audio Chunk Contract

- Chunk duration: 50ms (800 samples at 16kHz × 2 bytes = 1,600 bytes per chunk, mono).
- Each chunk's byte length must be a multiple of 2 (16-bit alignment).
- Max acceptable jitter: 100ms between chunks before a warning is logged.
- Max speech duration: 1,500 seconds (25 minutes). Server auto-stops with notification.

## Server Validation

The server validates incoming audio:
1. Handshake declares mono, LINEAR16, 16kHz.
2. Each chunk byte length is a multiple of 2.
3. Chunk arrival rate is within expected bounds.

On validation failure: emit `audio_format_error` and stop accepting audio for the session.

## Transcript Update Semantics

- Each `transcript_update` includes a `replaceFromIndex` field.
- The `segments` array contains only the replacement suffix, not the full transcript.
- The client maintains a local segment array and splices from `replaceFromIndex` onward.
- This handles Deepgram's interim→final replacement without flicker or duplication.

## Error Taxonomy

- `recoverable: true` — The operator can retry the action (e.g., LLM timeout, TTS failure). UI should show error with retry option.
- `recoverable: false` — The session is in an unrecoverable state (e.g., audio format mismatch). UI should show error and guide operator to restart.

## Session Concurrency

- One active session per WebSocket connection.
- One WebSocket connection per browser tab.
- If a new connection arrives while a session is active, the server creates a fresh session (the old one is abandoned).
- No multi-operator support in Phase 1.

## Implementation Checkpoints

When modifying these components, verify compliance:
- Server WebSocket handler: message validation, ordering enforcement
- Browser WebSocket client: message construction, transcript splicing
- AudioWorklet: chunk size, format, timing
- Error handling: recoverable vs non-recoverable classification
