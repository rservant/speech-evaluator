# Implementation Plan: TTS Audio Replay and Save

## Overview

Incremental implementation of TTS audio caching, replay, and file persistence. Each task builds on the previous, starting with the data model changes, then server-side logic, then WebSocket protocol, then UI, and finally file persistence. Tests are co-located with their implementation tasks.

## Tasks

- [ ] 1. Extend Session interface and initialize ttsAudioCache
  - [ ] 1.1 Add `ttsAudioCache: Buffer | null` field to the `Session` interface in `src/types.ts`
    - Add the field with `null` default
    - _Requirements: 1.1_
  - [ ] 1.2 Add `replay_tts` to the `ClientMessage` union type in `src/types.ts`
    - Add `| { type: "replay_tts" }` variant
    - _Requirements: 2.1_
  - [ ] 1.3 Initialize `ttsAudioCache: null` in `SessionManager.createSession()` in `src/session-manager.ts`
    - _Requirements: 1.1_

- [ ] 2. Implement server-side TTS audio caching in SessionManager
  - [ ] 2.1 Store the TTS audio buffer in `session.ttsAudioCache` after successful synthesis in `generateEvaluation()` in `src/session-manager.ts`
    - After `const audioBuffer = await this.deps.ttsEngine.synthesize(trimmedScript)` and the runId check, set `session.ttsAudioCache = audioBuffer`
    - _Requirements: 1.1_
  - [ ] 2.2 Clear `ttsAudioCache` in `startRecording()` in `src/session-manager.ts`
    - Add `session.ttsAudioCache = null` alongside the existing data clearing
    - _Requirements: 1.5_
  - [ ] 2.3 Clear `ttsAudioCache` in `purgeSessionData()` in `src/server.ts`
    - Add `session.ttsAudioCache = null` to the purge function
    - _Requirements: 1.4_
  - [ ] 2.4 Write property tests for TTS audio cache lifecycle (Properties 1–4)
    - **Property 1: TTS audio cache stored after synthesis**
    - **Property 2: Panic mute preserves TTS audio cache**
    - **Property 3: Purge clears TTS audio cache**
    - **Property 4: New recording clears TTS audio cache**
    - **Validates: Requirements 1.1, 1.3, 1.4, 1.5**

- [ ] 3. Implement replayTTS method in SessionManager
  - [ ] 3.1 Add `replayTTS(sessionId: string): Buffer | undefined` method to `SessionManager` in `src/session-manager.ts`
    - Return `undefined` if `ttsAudioCache` is null
    - Assert IDLE → DELIVERING transition
    - Set state to DELIVERING
    - Return the cached buffer
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ] 3.2 Write property test for replay (Property 5)
    - **Property 5: Replay returns cached buffer and transitions state**
    - **Validates: Requirements 2.1, 2.4**
  - [ ] 3.3 Write unit tests for replay edge cases
    - Test replay with no cache returns undefined without state change
    - Test replay in non-IDLE state throws error
    - _Requirements: 2.2, 2.3_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Wire replay_tts into WebSocket handler
  - [ ] 5.1 Add `replay_tts` case to `handleClientMessage()` in `src/server.ts`
    - Call `sessionManager.replayTTS(sessionId)`
    - If buffer returned: send state_change(delivering), tts_audio, tts_complete, completeDelivery(), state_change(idle), start purge timer
    - If undefined returned: send recoverable error "No TTS audio available for replay."
    - Catch state transition errors and send recoverable error
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ] 5.2 Write unit tests for the replay_tts WebSocket handler
    - Test full message sequence on successful replay
    - Test error response when no cache
    - Test error response when in wrong state
    - _Requirements: 2.1, 2.2, 2.3_

- [ ] 6. Add replay button to the UI
  - [ ] 6.1 Add replay button HTML and CSS to `public/index.html`
    - Add `btn-replay` button in the controls section (after btn-deliver, before btn-save)
    - Style consistently with existing buttons (use `btn-primary` or a distinct replay style)
    - Initially hidden
    - _Requirements: 3.1_
  - [ ] 6.2 Implement replay button visibility logic in `updateUI()` in `public/index.html`
    - Track `hasTTSAudio` boolean (set true on `tts_audio` receipt, cleared on new recording start)
    - Show replay button in IDLE state when `hasTTSAudio && hasEvaluationData`
    - Hide during RECORDING, PROCESSING, DELIVERING states
    - Disable during cooldown
    - Clear `hasTTSAudio` on new recording start and opt-out purge
    - _Requirements: 3.1, 3.2, 3.4, 3.5_
  - [ ] 6.3 Implement `onReplayEvaluation()` click handler in `public/index.html`
    - Hard-stop mic (echo prevention)
    - Send `{ type: "replay_tts" }` via WebSocket
    - Optimistic UI update to DELIVERING state
    - _Requirements: 3.3, 3.6_

- [ ] 7. Extend FilePersistence to save TTS audio file
  - [ ] 7.1 Write `evaluation_audio.mp3` in `saveSession()` in `src/file-persistence.ts`
    - After writing the existing three files, check `session.ttsAudioCache`
    - If non-null, write to `evaluation_audio.mp3` in the output directory
    - Wrap in try/catch so failure doesn't block other saves
    - Log warning on audio write failure
    - Include audio path in returned paths array only if write succeeded
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [ ] 7.2 Write property test for audio file persistence (Property 6)
    - **Property 6: Audio file persistence if and only if cache exists**
    - **Validates: Requirements 4.1, 4.2, 4.3**
  - [ ] 7.3 Write unit tests for audio file persistence edge cases
    - Test save with ttsAudioCache present — verify evaluation_audio.mp3 written with correct content
    - Test save with null ttsAudioCache — verify no audio file, other files still saved
    - Test audio write failure — verify other files still saved, audio path not in returned paths
    - _Requirements: 4.1, 4.2, 4.4_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The replay mechanism reuses the existing IDLE → DELIVERING → IDLE state transition, so all echo prevention, panic mute, and cooldown logic applies automatically
