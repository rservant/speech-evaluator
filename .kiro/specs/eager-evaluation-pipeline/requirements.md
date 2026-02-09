# Requirements Document

## Introduction

This feature changes the evaluation pipeline (LLM generation → tone check → script rendering → TTS synthesis) from a lazy model (triggered by "Deliver Evaluation" click) to an eager model (triggered automatically after recording stops and transcription/metrics complete). The TTS audio is pre-generated and cached in memory so that clicking "Deliver Evaluation" results in immediate playback. The core behavioral boundary — "the system never speaks unprompted" — is preserved: audio is only played when the operator explicitly clicks "Deliver Evaluation".

## Glossary

- **Eager_Pipeline**: The background process that automatically runs evaluation generation and TTS synthesis after recording stops and transcription/metrics complete, without waiting for operator action.
- **Session_Manager**: The server-side component that manages session state, transcription, metrics extraction, evaluation generation, and TTS synthesis.
- **Server**: The WebSocket server that handles client messages and orchestrates Session_Manager operations.
- **UI**: The browser-based frontend that displays session state, controls, and evaluation results.
- **Processing_Indicator**: The UI element that shows progress status while the session is in PROCESSING state.
- **Deliver_Button**: The "Deliver Evaluation" button that the operator clicks to trigger TTS audio playback.
- **RunId**: A monotonic integer on the session, incremented on panic mute or new recording, used to cancel stale async operations.
- **TTS_Audio_Cache**: Deprecated field name. The cached TTS audio is now stored as part of the single `Evaluation_Cache` artifact object on the session.
- **Evaluation_Cache**: A single immutable object stored on the session containing `{ runId, timeLimitSeconds, voiceConfig, evaluation, evaluationScript, ttsAudio }`. This is the sole representation of cached eager pipeline output. The `ttsAudio` field contains the audio in the exact binary payload the server will pass to `ws.send()`, requiring no framing, chunking, or transformation at delivery time.
- **Eager_Status**: A field on the session tracking the current state of the Eager_Pipeline (`idle`, `generating`, `synthesizing`, `ready`, `failed`). This is internal session state used for delivery logic and cache validity.
- **Pipeline_Stage**: The values sent in `pipeline_progress` WebSocket messages to the client (`processing_speech`, `generating_evaluation`, `synthesizing_audio`, `ready`, `failed`). These map to Eager_Status transitions but are a separate concept — `processing_speech` is sent before eager starts (during transcription/metrics), while Eager_Status remains `idle` until the pipeline begins.
- **Cache_Validity**: The condition under which cached evaluation and TTS audio are considered usable — the cached artifact's RunId must match the session RunId and the cached artifact's generation parameters must match current session parameters that affect script or TTS output (at minimum: `timeLimitSeconds`; plus `voiceConfig` if configurable at runtime).

## Requirements

### Requirement 1: Automatic Eager Pipeline Trigger

**User Story:** As an operator, I want the evaluation pipeline to start automatically after recording stops, so that the evaluation is ready by the time I want to deliver it.

#### Acceptance Criteria

1. WHEN recording stops and post-speech transcription and metrics extraction complete successfully, THE Server SHALL automatically start the Eager_Pipeline in the background without waiting for operator action.
2. THE Session_Manager SHALL ensure only one Eager_Pipeline instance runs per RunId at any time.
3. WHEN the Eager_Pipeline starts, THE Session_Manager SHALL execute the full evaluation pipeline (LLM generation, energy profile, script rendering, tone check, timing trim, scope acknowledgment, name redaction, TTS synthesis) using the same logic as the existing `generateEvaluation` method.
4. WHILE the Eager_Pipeline is running, THE Session_Manager SHALL remain in PROCESSING state and SHALL NOT transition to DELIVERING state.
5. WHEN the Eager_Pipeline completes successfully, THE Session_Manager SHALL store the evaluation, script, and fully-synthesized TTS audio in the session as immediately-transmittable cached data stored in memory in a form directly usable for WebSocket transmission without decompression, decoding, transcoding, re-buffering, or reconstruction, without transitioning state or sending audio to the client. Cache publication SHALL be atomic — the cache SHALL be stored as a single immutable Evaluation_Cache object containing `{ runId, timeLimitSeconds, voiceConfig, evaluation, evaluationScript, ttsAudio }` and replaced atomically so that all fields become visible to the delivery path simultaneously only after all are fully generated. The `ttsAudio` field SHALL contain the audio in the exact binary payload the server will pass to `ws.send()`, requiring no framing, chunking, or transformation at delivery time. Before publishing the cached artifact, the Eager_Pipeline SHALL confirm `artifact.runId === session.runId`; otherwise the artifact SHALL be discarded.
6. IF the Eager_Pipeline fails at any stage, THEN THE Session_Manager SHALL log the error, set the Eager_Status to `failed`, discard partial results for that run, and leave the session in PROCESSING state. The session SHALL remain in PROCESSING until the operator retries delivery, a new recording begins, panic mute occurs, or speaker opt-out occurs.

### Requirement 2: Eager Status Tracking

**User Story:** As a developer, I want the session to track the eager pipeline's progress, so that the server and UI can make correct decisions about button gating and delivery behavior.

#### Acceptance Criteria

1. THE Session_Manager SHALL maintain an Eager_Status field on the session with values: `idle`, `generating`, `synthesizing`, `ready`, `failed`.
2. WHEN the Eager_Pipeline transitions between stages, THE Session_Manager SHALL update the Eager_Status field accordingly: on LLM generation start Eager_Status becomes `generating`, on TTS synthesis start Eager_Status becomes `synthesizing`, on success Eager_Status becomes `ready`, on failure Eager_Status becomes `failed`. Eager_Status transitions reflect internal eager pipeline phases and do not include `processing_speech` (which is a Pipeline_Stage only).
3. WHEN the Eager_Pipeline completes successfully, THE Session_Manager SHALL set Eager_Status to `ready`.
4. WHEN the Eager_Pipeline fails, THE Session_Manager SHALL set Eager_Status to `failed`.
5. WHEN a new recording starts, THE Session_Manager SHALL reset Eager_Status to `idle`.

### Requirement 3: UI Progress Feedback

**User Story:** As an operator, I want to see what the system is doing after I stop recording, so that I know when the evaluation is ready.

#### Acceptance Criteria

1. WHEN the session enters PROCESSING state and the Eager_Pipeline has not yet started (Eager_Status is `idle`, Pipeline_Stage is `processing_speech`), THE UI SHALL display "Speech processed — preparing evaluation..." in the Processing_Indicator.
2. WHEN the Eager_Pipeline begins LLM evaluation generation, THE Server SHALL send a progress message to the client, and THE UI SHALL update the Processing_Indicator to "Generating evaluation...".
3. WHEN the Eager_Pipeline begins TTS synthesis, THE Server SHALL send a progress message to the client, and THE UI SHALL update the Processing_Indicator to "Synthesizing audio...".
4. WHEN the Eager_Pipeline completes successfully, THE Server SHALL send a progress message to the client, and THE UI SHALL update the Processing_Indicator to "Evaluation ready — click Deliver Evaluation".
5. WHEN the Eager_Pipeline fails, THE Server SHALL send a progress message with a `failed` stage to the client, and THE UI SHALL update the Processing_Indicator to "Evaluation generation failed — click Deliver Evaluation to retry".

### Requirement 4: Deliver Button Gating

**User Story:** As an operator, I want the Deliver Evaluation button to reflect whether the evaluation is ready, so that I can deliver immediately when it is or wait if it is still generating.

#### Acceptance Criteria

1. WHILE the Eager_Pipeline is in progress (Eager_Status is `generating` or `synthesizing`), THE UI SHALL show the Deliver_Button in a disabled state.
2. WHEN the Eager_Pipeline completes successfully (Eager_Status is `ready`), THE UI SHALL enable the Deliver_Button.
3. IF the Eager_Pipeline fails (Eager_Status is `failed`), THEN THE UI SHALL enable the Deliver_Button so the operator can trigger a synchronous retry. This applies even while the session state remains PROCESSING.
4. THE UI SHALL only enable the Deliver_Button when the latest server-reported Pipeline_Stage indicates readiness (`ready` or `failed`). THE Server remains authoritative — regardless of UI state, the Server SHALL handle any `deliver_evaluation` message by delivering cached audio, awaiting in-flight eager, or running synchronous fallback as defined in Requirement 5.
5. WHEN the UI enables the Deliver_Button based on Eager_Status being `ready`, THE Server SHALL guarantee that the cached artifact exists, is non-null, and contains non-empty `ttsAudio`, `evaluation`, and `evaluationScript`, and that Cache_Validity holds (RunId and generation parameters match). IF any of these conditions become false while Eager_Status is `ready`, THE Session_Manager SHALL revert Eager_Status to `idle`.

### Requirement 5: Immediate Playback from Cache

**User Story:** As an operator, I want clicking "Deliver Evaluation" to start audio playback immediately when the evaluation is already cached, so that there is no delay in the meeting.

#### Acceptance Criteria

1. WHEN the operator clicks the Deliver_Button and valid cached TTS audio exists (Eager_Status is `ready` and Cache_Validity holds), THE Server SHALL skip evaluation generation, transition to DELIVERING state, and begin transmitting the cached audio to the client with no evaluation generation, TTS synthesis, decoding, or buffering on the delivery path. "Begin transmitting" means the Server has invoked `ws.send()` with the cached `ttsAudio` payload without performing any blocking work beforehand. Under normal conditions this SHALL occur within 50ms of receiving the `deliver_evaluation` message; under worst-case server load, within 250ms. These bounds apply to server-side processing only, measured from receipt of `deliver_evaluation` on the server event loop to invocation of `ws.send()`, and do not include network transport time, client scheduling, or playback buffering.
2. EVEN IF the UI disables the Deliver_Button during eager generation, THE Server SHALL handle a `deliver_evaluation` message correctly if received while the Eager_Pipeline is in progress (e.g., due to race conditions, stale clients, or manual WebSocket messages). THE Server SHALL wait for the in-flight Eager_Pipeline to complete under the current RunId and then deliver the result. IF the Eager_Pipeline completes successfully during the wait, THE Server SHALL deliver the cached audio. IF the Eager_Pipeline fails during the wait, THE Server SHALL fall through to the synchronous fallback path.
3. WHEN the operator clicks the Deliver_Button and the Eager_Pipeline has failed or has not started or the cache is invalid, THE Server SHALL run the full evaluation pipeline synchronously as a fallback. THE Session_Manager SHALL remain in PROCESSING state during synchronous fallback execution and SHALL transition to DELIVERING only when audio transmission begins. IF the synchronous fallback succeeds, THE Server SHALL update the cache and deliver the audio. IF the synchronous fallback fails, THE Server SHALL surface the error, leave the cache empty, and leave the session in PROCESSING state.
4. WHEN delivering cached or freshly-generated audio, THE Server SHALL send the `evaluation_ready` message with the structured evaluation and script immediately before sending the TTS audio binary frame on every delivery attempt, even if the client previously received `evaluation_ready`, preserving the existing delivery message sequence.
5. WHEN the operator clicks the Deliver_Button, THE Server SHALL use only results matching the current RunId for delivery; any in-flight or completed Eager_Pipeline results from a previous RunId SHALL be ignored and SHALL NOT modify cache or session state.
6. IF a `deliver_evaluation` message is received while the session is already in DELIVERING state, THE Server SHALL ignore the request without regenerating evaluation, restarting audio transmission, or modifying cache.
7. AFTER delivery completes (audio transmission done and session transitions out of DELIVERING), cached audio SHALL remain available for replay via the existing `replay_tts` mechanism without regeneration, regardless of the session state the system transitions to.

### Requirement 6: Cache Validity and Lifecycle

**User Story:** As a developer, I want cached evaluation data to be invalidated when session parameters change, so that stale or incorrect evaluations are never delivered.

#### Acceptance Criteria

1. THE Session_Manager SHALL consider cached evaluation and TTS audio valid only when the cached artifact's RunId matches the session RunId and the cached artifact's generation parameters match current session parameters that affect script or TTS output (at minimum: `timeLimitSeconds`; plus `voiceConfig` if configurable at runtime).
2. WHEN the operator changes the time limit while a cached artifact exists or while the Eager_Pipeline is in progress, THE Session_Manager SHALL invalidate the cache by resetting Eager_Status to `idle`, clearing the Evaluation_Cache, and cancelling any in-flight Eager_Pipeline immediately. The same invalidation SHALL apply if any other generation parameter included in Cache_Validity (e.g., `voiceConfig`) changes at runtime.
3. WHEN a new recording starts, THE Session_Manager SHALL clear the Evaluation_Cache and reset Eager_Status to `idle`.
4. WHEN panic mute occurs, THE Session_Manager SHALL clear the Evaluation_Cache and reset Eager_Status to `idle`.
5. WHEN speaker opt-out occurs, THE Session_Manager SHALL clear the Evaluation_Cache as part of the full session data purge.
6. IF the Evaluation_Cache is cleared due to memory pressure or any other non-operator-initiated reason, THEN THE Session_Manager SHALL revert Eager_Status to `idle`, and THE UI SHALL disable the Deliver_Button until the cache is regenerated.
7. WHEN session auto-purge clears evaluation data, THE Session_Manager SHALL clear the Evaluation_Cache and revert Eager_Status to `idle`.

### Requirement 7: Cancellation on Panic Mute and Opt-Out

**User Story:** As an operator, I want panic mute and speaker opt-out to cancel any in-flight eager generation, so that the system stops all processing immediately.

#### Acceptance Criteria

1. WHEN the operator triggers panic mute while the Eager_Pipeline is running, THE Session_Manager SHALL cancel the in-flight pipeline via the RunId mechanism and transition to IDLE.
2. WHEN the speaker opts out while the Eager_Pipeline is running, THE Session_Manager SHALL cancel the in-flight pipeline via the RunId mechanism and purge all session data immediately.
3. WHEN a new recording starts while the Eager_Pipeline from a previous recording is still running, THE Session_Manager SHALL cancel the stale pipeline via the RunId mechanism.

### Requirement 8: Behavioral Boundary Preservation

**User Story:** As a meeting organizer, I want the system to never speak unprompted, so that TTS audio only plays when I explicitly choose to deliver the evaluation.

#### Acceptance Criteria

1. THE Server SHALL generate and cache TTS audio eagerly but SHALL NOT send TTS audio to the client until the operator clicks the Deliver_Button.
2. THE Eager_Pipeline SHALL NEVER transition the session to DELIVERING state, trigger audio playback, send `evaluation_ready` messages, or send TTS audio frames; the DELIVERING transition and audio transmission SHALL only occur when the operator clicks the Deliver_Button.
3. IF panic mute or speaker opt-out occurs during DELIVERING state (after Deliver_Button was clicked), THEN THE Server SHALL immediately stop audio transmission, THE client SHALL stop playback, and THE session SHALL transition to IDLE or purged state.

### Requirement 9: WebSocket Protocol Extension

**User Story:** As a developer, I want a new server-to-client message type for pipeline progress, so that the UI can display granular status updates during eager generation.

#### Acceptance Criteria

1. THE Server SHALL define a new `pipeline_progress` ServerMessage type with a `stage` field indicating the current pipeline stage (values: `processing_speech`, `generating_evaluation`, `synthesizing_audio`, `ready`, `failed`) and a `runId` field so the client can ignore stale progress from cancelled pipelines. The message MAY include an optional `message` field for human-readable detail on failure.
2. WHEN the Eager_Pipeline transitions between stages, THE Server SHALL send a `pipeline_progress` message to the connected client.
3. WHEN the Eager_Pipeline completes or fails, THE Server SHALL send a `pipeline_progress` message with a terminal stage value (`ready` or `failed`). The Server SHALL guarantee that `pipeline_progress: ready` is sent only after Eager_Status has been set to `ready` and the Evaluation_Cache has been published, and `pipeline_progress: failed` is sent only after Eager_Status has been set to `failed`.
