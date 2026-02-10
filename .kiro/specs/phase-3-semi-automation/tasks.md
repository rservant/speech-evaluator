# Implementation Plan: Phase 3 — Semi-Automation

## Overview

Implement Phase 3 capabilities in order: types/data models first, then VAD monitor (new component), then project awareness (extending existing components), then server/UI wiring, and finally the optional evidence highlight UI. Each task builds on the previous, with property tests placed close to the implementation they validate.

## Tasks

- [x] 1. Extend types and session data model
  - [x] 1.1 Add Phase 3 types to `src/types.ts`
    - Add `ProjectContext` interface with `speechTitle`, `projectType`, `objectives` fields (with JSDoc validation constraints from Req 4.8)
    - Add `SessionVADConfig` interface with `silenceThresholdSeconds` and `enabled` fields (with JSDoc range constraints from Req 3.1)
    - Add `projectContext: ProjectContext | null` and `vadConfig: SessionVADConfig` fields to `Session` interface
    - Add `@deprecated` JSDoc comment to existing `evaluationObjectives?: string[]` field, noting that `projectContext.objectives` supersedes it
    - Extend `EvaluationConfig` with optional `speechTitle` and `projectType` fields
    - NOTE: Do NOT add `set_project_context`/`set_vad_config` to `ClientMessage` or `vad_speech_end`/`vad_status` to `ServerMessage` in this task — those are added in task 5.2 alongside their handlers to avoid exhaustive switch compile errors at checkpoint 2
    - _Requirements: 9.1, 9.2_

  - [x] 1.2 Update `SessionManager.createSession()` to initialize Phase 3 fields
    - Initialize `projectContext: null`
    - Initialize `vadConfig: { silenceThresholdSeconds: 5, enabled: true }`
    - _Requirements: 9.3_

  - [x] 1.3 Add `setProjectContext()` and `setVADConfig()` methods to SessionManager
    - `setProjectContext()`: validate IDLE state, store on session, throw if non-IDLE
    - `setVADConfig()`: validate IDLE state, store on session
    - _Requirements: 4.5, 4.7, 6.2, 6.3, 6.5_

  - [x] 1.4 Write property test for project context immutability
    - **CTX-P2: Project context immutability after recording starts**
    - **Validates: Requirements 4.7, 6.3**

  - [x] 1.5 Update `revokeConsent()` to purge `projectContext`
    - Set `session.projectContext = null` in the purge block
    - _Requirements: 9.4_

  - [x] 1.6 Write property test for project context purge on opt-out
    - **CTX-P4: Project context purged on speaker opt-out**
    - **Validates: Requirements 9.4**

- [x] 2. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implement VADMonitor component
  - [x] 3.1 Create `src/vad-monitor.ts` with `VADMonitor` class
    - Implement `VADConfig`, `VADStatus`, `VADEventCallback` interfaces
    - `VADConfig` must include all named parameters: `silenceThresholdSeconds`, `enabled`, `silenceFactor`, `minSpeechSeconds`, `suppressionSeconds`, `statusIntervalMs`, `speechEnergyWindowChunks` (default 6000), `noiseFloorBootstrapChunks` (default 40 = 2s of audio), `thresholdMultiplier` (default 0.15, alias for `silenceFactor`)
    - Implement `computeChunkRMS()` helper (16-bit PCM RMS computation)
    - Implement `feedChunk()` with rolling speech RMS tracking, adaptive threshold, silence episode tracking, suppression rules, status throttling
    - Implement early-recording behavior: during the first `noiseFloorBootstrapChunks` chunks, use a fixed conservative RMS threshold (e.g., 50 raw RMS units) to avoid misclassifying ambient noise as speech. After bootstrap, the adaptive median-based threshold takes over.
    - IMPORTANT: Use audio-time (`totalChunksProcessed * 0.05` seconds) for silence detection and suppression rules, NOT wall-clock `Date.now()`. Track `silenceStartChunk` (chunk index) instead of `silenceStartTime` (timestamp). Silence duration = `(totalChunksProcessed - silenceStartChunk) * 0.05`. Recording elapsed time = `totalChunksProcessed * 0.05`. Speech accumulated time = `speechChunksProcessed * 0.05`. The `statusIntervalMs` throttling can still use wall-clock `Date.now()` since it's rate-limiting, not correctness.
    - Implement `stopped` flag: `feedChunk()` returns immediately if `stopped` is true. `stop()` sets `stopped = true`. `reset()` sets `stopped = false` (re-arms the monitor).
    - Implement `reset()` and `stop()` methods
    - Export the class and interfaces
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 3.2 Write property test for chunk RMS classification
    - **VAD-P1: Chunk RMS classification matches adaptive threshold**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 3.3 Write property test for speech-end suggestion emission
    - **VAD-P2: Speech-end suggestion emitted on sustained silence**
    - **Validates: Requirements 1.3**

  - [x] 3.4 Write property test for at most one suggestion per silence episode
    - **VAD-P3: At most one suggestion per silence episode**
    - **Validates: Requirements 1.4**

  - [x] 3.5 Write property test for suppression rules
    - **VAD-P4: Suppression rules prevent premature suggestions**
    - **Validates: Requirements 1.5, 1.7**

  - [x] 3.6 Write property test for adaptive threshold computation
    - **VAD-P5: Adaptive threshold tracks median speech energy**
    - **Validates: Requirements 1.6**

  - [x] 3.7 Write property test for VAD status throttling
    - **VAD-P6: VAD status messages throttled to configured interval**
    - **Validates: Requirements 10.2**

  - [x] 3.8 Write unit tests for VADMonitor edge cases
    - Test empty chunks, zero-amplitude audio, single chunk, config boundary values
    - Test reset() clears all state
    - Test stop() prevents further emissions
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 3.9 Ensure VADMonitor never emits after stop
    - After `stop()` or `reset()`, ensure callbacks are no-ops (internal `stopped` flag)
    - Unit test: create monitor, stop it, feed chunks, assert zero events emitted
    - _Requirements: 11.4_

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Integrate VAD into SessionManager and Server
  - [x] 5.1 Add `vadMonitorFactory` to `SessionManagerDeps` and wire VAD into recording lifecycle
    - Add `vadMonitorFactory` to `SessionManagerDeps` interface
    - Add private `vadMonitors: Map<string, VADMonitor>` field to `SessionManager`
    - Add private `vadCallbacksMap: Map<string, VADEventCallback>` field to `SessionManager`
    - Add `registerVADCallbacks(sessionId, callbacks)` method — stores per-session callbacks in `vadCallbacksMap`
    - `startRecording()` signature is UNCHANGED (no `vadCallbacks` parameter). Instead, `startRecording()` looks up callbacks from `this.vadCallbacksMap.get(sessionId)` when creating the VADMonitor
    - In `startRecording()`: create VADMonitor when `vadConfig.enabled` and factory is available, store in `this.vadMonitors`, wire callbacks from `vadCallbacksMap` to monitor events. If no callbacks registered, VAD events are silently discarded.
    - Modify `feedAudio()` to forward chunks to VADMonitor via `this.vadMonitors.get(sessionId)?.feedChunk()`. **HARD GUARD**: only forward when `session.state === 'RECORDING'` AND monitor exists in `this.vadMonitors`. If state is not RECORDING, chunks are silently ignored (no error). This prevents late chunks (network jitter) from reaching a stopped/removed monitor and prevents resurrection of a monitor after stop.
    - Modify `stopRecording()` to stop and remove VADMonitor from `this.vadMonitors`, remove entry from `this.vadCallbacksMap`
    - Modify `panicMute()` to stop and remove VADMonitor from `this.vadMonitors`, remove entry from `this.vadCallbacksMap`
    - Modify `revokeConsent()` to stop and remove VADMonitor from `this.vadMonitors`, remove entry from `this.vadCallbacksMap`
    - _Requirements: 1.1, 2.1, 3.3, 11.1, 11.2, 11.3, 11.4_

  - [x] 5.2 Add new message types and handlers to server
    - Add `set_project_context` and `set_vad_config` to `ClientMessage` union type in `src/types.ts`
    - Add `vad_speech_end` and `vad_status` to `ServerMessage` union type in `src/types.ts`
    - Add `handleSetProjectContext()` and `handleSetVADConfig()` handler functions in `src/server.ts`
    - Add cases to `handleClientMessage()` switch for `set_project_context` and `set_vad_config`
    - Validate IDLE state, call SessionManager methods, send error on invalid state
    - Validate Project_Context input constraints: `speechTitle` ≤ 200 chars, `projectType` ≤ 100 chars, `objectives` ≤ 10 items each ≤ 500 chars (Req 4.8)
    - Validate `set_vad_config` input: `silenceThresholdSeconds` must be a number in range [3, 15], `enabled` must be a boolean. Reject with recoverable error if out of range or wrong type (Req 3.1)
    - _Requirements: 3.1, 4.8, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 5.3 Wire VAD callbacks to WebSocket messages in `handleStartRecording()`
    - Call `sessionManager.registerVADCallbacks(sessionId, callbacks)` BEFORE `sessionManager.startRecording()` to register per-session WebSocket-sending callbacks
    - `onSpeechEnd` callback sends `vad_speech_end` message to client
    - `onStatus` callback sends `vad_status` message to client
    - `startRecording()` is called with its UNCHANGED signature (no `vadCallbacks` parameter) — the SessionManager looks up registered callbacks internally
    - Wire the `vadMonitorFactory` into the `SessionManager` construction in `server.ts` (or wherever `SessionManager` is instantiated for production use), e.g.: `vadMonitorFactory: (config, callbacks) => new VADMonitor(config, callbacks)`. Without this, VAD would silently be disabled in production.
    - _Requirements: 2.1, 10.1_

  - [x] 5.4 Update `purgeSessionData()` in `server.ts` to clear Phase 3 fields and existing omissions
    - Add `session.projectContext = null` to the purge function (Phase 3 addition)
    - Add `session.evaluationPublic = null` to the purge function (existing omission)
    - Add `session.evaluationPassRate = null` to the purge function (existing omission — telemetry data)
    - Add `session.qualityWarning = false` to the purge function (existing omission — should be reset)
    - Note: `session.consent` and `session.outputsSaved` are intentionally NOT cleared — consent is session metadata (not speech data), and `outputsSaved` tracks disk persistence status
    - REQUIRED: After purging, send a `data_purged` message to the client via WebSocket with `reason: "auto_purge"`. This is NOT optional — the UI needs this to clear stale local state (project context form, VAD config, evaluation/transcript display).
    - Add `data_purged` to the `ServerMessage` union type (if not already there) with a `reason` field: `"opt_out" | "auto_purge"`
    - _Requirements: 9.5_

  - [x] 5.5 Write unit tests for server VAD message handling
    - Test `set_vad_config` accepted in IDLE, rejected in RECORDING
    - Test `set_project_context` accepted in IDLE, rejected in non-IDLE states
    - Test `vad_speech_end` message sent when VAD callback fires
    - _Requirements: 2.1, 6.2, 6.3, 6.5_

  - [x] 5.6 Update `.kiro/steering/ws-protocol-and-session-contract.md` with Phase 3 message types
    - Add `set_project_context` and `set_vad_config` to Client → Server Messages section
    - Add `vad_speech_end` and `vad_status` to Server → Client Messages section
    - Add ordering constraints: both `set_project_context` and `set_vad_config` must precede `start_recording` and are only valid in IDLE state
    - _Requirements: 6.1, 6.4, 6.6_

- [x] 6. Implement project-aware evaluation
  - [x] 6.1 Extend `EvaluationGenerator` prompt construction for project context
    - Modify `buildUserPrompt()` to add `## Project-Specific Evaluation` section when `config.projectType` is provided (includes speech title, project type, objectives, and instructions)
    - When `config.projectType` is provided, the new `## Project-Specific Evaluation` section REPLACES the existing `## Evaluation Objectives` section to avoid duplicate objectives listings
    - When `config.projectType` is absent but `config.objectives` is present (edge case), preserve the existing `## Evaluation Objectives` rendering unchanged
    - `buildSystemPrompt()` is NOT modified — all project context goes in the user prompt
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 6.2 Wire project context from Session to EvaluationConfig in SessionManager
    - In BOTH `generateEvaluation()` AND `runEagerPipeline()`, build `EvaluationConfig` from `session.projectContext`
    - Pass `speechTitle`, `projectType`, and `objectives` to `evaluationGenerator.generate()`
    - CRITICAL: `runEagerPipeline()` currently calls `generate()` without config — this must be fixed as it is the primary evaluation path
    - CRITICAL: After the `generate()` call in `runEagerPipeline()`, also set `session.evaluationPassRate = generateResult.passRate` to mirror what `generateEvaluation()` does (line 524). Without this, `evaluationPassRate` telemetry will be `null` for all eager-pipeline-delivered evaluations.
    - _Requirements: 4.5, 5.1, 5.5_

  - [x] 6.3 Write property test for project context in prompt
    - **CTX-P3: Project context included in prompt when provided**
    - Test that `buildUserPrompt()` contains project type, speech title, and objectives
    - Note: `buildSystemPrompt()` is NOT modified — only test `buildUserPrompt()`
    - Access private method via `(generator as any).buildUserPrompt(...)` (standard TypeScript testing pattern)
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [x] 6.4 Write property test for absent project context
    - **CTX-P1: Absent project context produces no project prompt sections**
    - Access private method via `(generator as any).buildUserPrompt(...)` (standard TypeScript testing pattern)
    - **Validates: Requirements 4.6, 5.3**

- [x] 7. Extend file persistence for project context
  - [x] 7.1 Update `FilePersistence.saveSession()` to include project context
    - Write `project-context.json` when `session.projectContext` is non-null
    - Include speech title, project type, and objectives
    - Also check `session.evaluationCache?.ttsAudio` as a fallback source for `evaluation_audio.mp3` in `saveSession()` when `session.ttsAudioCache` is null (fixes eager-cache-hit delivery path where audio is stored in `evaluationCache.ttsAudio` rather than `ttsAudioCache`)
    - _Requirements: 5.4_

  - [x] 7.2 Write unit test for project context persistence
    - Test that `project-context.json` is written when context is present
    - Test that no file is written when context is null
    - _Requirements: 5.4_

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement frontend VAD UI
  - [x] 9.1 Add VAD configuration controls to the IDLE state UI
    - Add silence threshold slider (3-15s, default 5) and enable/disable toggle
    - Wire `onchange` to send `set_vad_config` message
    - Hide controls during RECORDING/PROCESSING/DELIVERING states
    - NOTE: The UI must handle incoming `data_purged` messages (with `reason: "opt_out"` or `"auto_purge"`) by clearing the VAD config controls back to defaults, clearing the project context form, and clearing any stale evaluation/transcript display.
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x] 9.2 Add VAD notification banner for speech-end detection
    - Add banner HTML with "Speech likely ended — confirm stop?" text, "Confirm Stop" and "Dismiss" buttons
    - Handle `vad_speech_end` message to show banner
    - If a second `vad_speech_end` arrives while banner is visible, replace the existing banner (reset state) rather than showing a second one (Req 2.8)
    - "Confirm Stop" sends `stop_recording`, "Dismiss" hides banner
    - Dismiss banner on state change away from RECORDING
    - Ensure banner does not obscure Stop Speech or Panic Mute buttons
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 9.3 Handle `vad_status` messages to drive audio level meter
    - Update `updateAudioLevel()` to accept VAD energy data
    - Use server-side energy when available, fall back to client-side AudioWorklet
    - If no `vad_status` received for 2+ seconds during RECORDING, fall back to AudioWorklet (Req 10.4)
    - NOTE: When VAD is disabled (`vadEnabled === false`), the client should use the AudioWorklet path from the start — no 2-second timeout needed. The `vadEnabled` client state should gate whether to expect `vad_status` messages at all.
    - _Requirements: 10.1, 10.3, 10.4_

- [x] 10. Implement frontend project context UI
  - [x] 10.1 Add project context form to the IDLE state UI
    - Add speech title input, project type dropdown, objectives textarea
    - Populate `PROJECT_TYPES` lookup table with predefined Toastmasters project types and objectives
    - Auto-populate objectives on project type selection
    - Wire form changes to send `set_project_context` message
    - Hide/disable form during RECORDING/PROCESSING/DELIVERING states
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 11. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Implement evidence highlight UI (Optional)
  - [x] 12.1 Implement client-side evidence quote matching and rendering
    - Add `normalizeForMatch()` function matching server-side normalization
    - Add `findTranscriptMatch()` function to locate quotes in transcript segments
    - Modify evaluation rendering to wrap evidence quotes in clickable `<span>` elements
    - Add click handler to scroll transcript panel and highlight matching segment
    - Add 3-second auto-dismiss for highlights
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 12.2 Write property test for evidence normalization consistency
    - **UI-P1: Evidence quote normalization is consistent with EvidenceValidator**
    - **Validates: Requirements 7.3**

  - [-] 12.3 Implement metrics summary dashboard
    - Add metrics summary panel below evaluation panel
    - Display duration, WPM, filler count, pause counts, energy variation
    - Use compact badge/inline layout
    - Show panel when metrics are available, persist until purge
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [~] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Evidence Highlight UI (tasks 12.x) is marked as optional in the PRD
- The VADMonitor is a new standalone component with no external API dependencies — it processes raw PCM buffers only
