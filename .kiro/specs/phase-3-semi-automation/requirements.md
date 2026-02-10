# Requirements Document

## Introduction

Phase 3 — Semi-Automation builds on the existing AI Toastmasters Evaluator (Phase 1 MVP + Phase 2 Stability & Credibility + Eager Evaluation Pipeline) to reduce manual operator workload while preserving reliability and human oversight. This phase introduces three capability areas: Voice Activity Detection (VAD) for speech end detection with operator confirmation, project awareness for tailored evaluations, and an optional evidence highlight UI for transcript navigation. The core behavioral boundary — "the system never speaks unprompted" and "human confirmation still required" — is preserved throughout.

## Glossary

- **Operator**: The person controlling the system during a Toastmasters meeting via the Web_UI
- **Speaker**: The Toastmasters club member delivering a speech being evaluated
- **Session**: A single end-to-end workflow covering one speech, from starting audio capture through delivering the evaluation
- **Web_UI**: The browser-based control interface used by the Operator to manage a Session
- **Session_Manager**: The server-side component that manages session state, transcription, metrics extraction, evaluation generation, and TTS synthesis
- **Evaluation_Generator**: The component that produces the Evaluation from the Transcript and Delivery_Metrics using an LLM
- **Transcript**: A timestamped textual representation of the Speaker's speech produced by the Transcription_Engine
- **Delivery_Metrics**: A structured JSON object containing measurements of speech delivery (WPM, filler words, duration, pauses, energy variation, pause classification)
- **VAD**: Voice Activity Detection — a component that monitors audio energy levels during recording to detect when the Speaker has likely stopped speaking
- **VAD_Monitor**: The server-side component that analyzes audio chunks in real time to detect sustained silence, producing speech-end suggestions for the Operator
- **Silence_Threshold**: The configurable duration of continuous silence (default 5 seconds) after which the VAD_Monitor suggests the speech has ended
- **Speech_End_Suggestion**: A server-to-client notification indicating the VAD_Monitor has detected sustained silence, prompting the Operator to confirm whether to stop recording
- **Project_Context**: Pre-speech metadata provided by the Operator including speech title, Toastmasters project type, and project-specific objectives
- **Project_Type**: A Toastmasters Pathways project category (e.g., Ice Breaker, Vocal Variety, Persuasive Speaking) that defines specific evaluation objectives
- **Evidence_Highlight**: An optional UI feature that links evaluation evidence quotes to their corresponding positions in the transcript with clickable navigation
- **Consent_Record**: A metadata object capturing the Speaker's name and consent status for the current Session
- **Eager_Pipeline**: The background process that automatically runs evaluation generation and TTS synthesis after recording stops
- **Evaluation_Cache**: A single immutable object stored on the session containing cached eager pipeline output
- **TTS_Engine**: The text-to-speech component that converts the Evaluation into spoken audio output

## Requirements

### Requirement 1: Voice Activity Detection — Silence Monitoring

**User Story:** As an Operator, I want the system to detect when the Speaker has likely finished speaking, so that I receive a prompt to stop recording without having to watch for the speech ending manually.

#### Acceptance Criteria

1. WHILE the Session is in RECORDING state, THE VAD_Monitor SHALL analyze incoming audio chunks to compute a rolling RMS energy level and detect periods of sustained silence
2. THE VAD_Monitor SHALL classify an audio chunk as silence when its RMS energy falls below an adaptive silence threshold computed from the session's speech energy baseline
3. WHEN the VAD_Monitor detects continuous silence lasting at or above the configured Silence_Threshold (default 5 seconds), THE VAD_Monitor SHALL emit a Speech_End_Suggestion to the Server
4. THE VAD_Monitor SHALL emit at most one Speech_End_Suggestion per silence episode; a new suggestion SHALL only be emitted after speech activity resumes and a subsequent silence episode meets the threshold
5. THE VAD_Monitor SHALL NOT emit a Speech_End_Suggestion during the first 10 seconds of recording to avoid false positives from pre-speech silence or microphone setup
6. THE VAD_Monitor SHALL compute the adaptive silence threshold using the median RMS energy of speech-active chunks observed so far, scaled by a configurable factor (default 0.15 of median speech energy)
7. THE VAD_Monitor SHALL require a minimum of 3 seconds of speech activity before the silence detection becomes active, to establish a reliable speech energy baseline

### Requirement 2: Voice Activity Detection — Operator Notification

**User Story:** As an Operator, I want to see a clear notification when the system detects the speech has likely ended, so that I can confirm whether to stop recording.

#### Acceptance Criteria

1. WHEN the Server receives a Speech_End_Suggestion from the VAD_Monitor, THE Server SHALL send a `vad_speech_end` message to the connected client
2. WHEN the Web_UI receives a `vad_speech_end` message, THE Web_UI SHALL display a non-blocking notification banner reading "Speech likely ended — confirm stop?" with a "Confirm Stop" button and a "Dismiss" button
3. WHEN the Operator clicks "Confirm Stop" on the VAD notification, THE Web_UI SHALL send a `stop_recording` message to the Server, following the existing stop recording flow
4. WHEN the Operator clicks "Dismiss" on the VAD notification, THE Web_UI SHALL hide the notification and continue recording without interruption
5. IF the Operator manually clicks the "Stop Speech" button while a VAD notification is visible, THEN THE Web_UI SHALL dismiss the VAD notification and proceed with the normal stop recording flow
6. WHEN the Session leaves RECORDING state for any reason (stop, panic mute, opt-out), THE Web_UI SHALL dismiss any visible VAD notification
7. THE VAD notification SHALL NOT block or obscure the existing recording controls (Stop Speech, Panic Mute)
8. IF a second `vad_speech_end` message arrives while a VAD notification banner is already visible, THE Web_UI SHALL replace the existing banner (resetting its state) rather than displaying a second banner

### Requirement 3: Voice Activity Detection — Configuration

**User Story:** As an Operator, I want to configure the silence detection threshold, so that I can adjust sensitivity based on the meeting environment and speaker style.

#### Acceptance Criteria

1. THE Web_UI SHALL display a silence threshold configuration control in the IDLE state, allowing the Operator to set the Silence_Threshold between 3 and 15 seconds with a default of 5 seconds
2. WHEN the Operator changes the Silence_Threshold, THE Web_UI SHALL send a `set_vad_config` message to the Server with the updated threshold value
3. THE Session_Manager SHALL store the configured Silence_Threshold on the Session and pass the value to the VAD_Monitor when recording starts
4. WHILE the Session is in RECORDING state, THE Web_UI SHALL prevent modification of the Silence_Threshold
5. THE Web_UI SHALL provide a toggle to enable or disable VAD entirely, defaulting to enabled

### Requirement 4: Project Awareness — Context Input

**User Story:** As an Operator, I want to input the speech title, Toastmasters project type, and project-specific objectives before recording, so that the evaluation is tailored to the project goals.

#### Acceptance Criteria

1. WHEN the Session is in IDLE state, THE Web_UI SHALL display input fields for speech title (free text), project type (dropdown selection), and project-specific objectives (multi-line text area)
2. THE Web_UI SHALL provide a predefined list of common Toastmasters Pathways project types including but not limited to: Ice Breaker, Evaluation and Feedback, Researching and Presenting, Introduction to Vocal Variety, Connect with Storytelling, Persuasive Speaking, and a "Custom / Other" option
3. WHEN the Operator selects a predefined project type, THE Web_UI SHALL auto-populate the objectives field with the standard objectives for that project type, which the Operator can edit
4. WHEN the Operator provides Project_Context, THE Web_UI SHALL send a `set_project_context` message to the Server containing the speech title, project type, and objectives
5. THE Session_Manager SHALL store the Project_Context on the Session and make the context available to the Evaluation_Generator
6. THE Project_Context fields SHALL be optional; the system SHALL function without project context, producing a general evaluation as in Phase 2
7. WHEN recording starts, THE Project_Context SHALL become immutable for that Session, consistent with the Consent_Record immutability rule
8. THE Server SHALL validate Project_Context input: `speechTitle` SHALL be at most 200 characters, `projectType` SHALL be at most 100 characters, and `objectives` SHALL contain at most 10 items each at most 500 characters. Messages exceeding these limits SHALL be rejected with a recoverable error

### Requirement 5: Project Awareness — Tailored Evaluation

**User Story:** As an Operator, I want the evaluation to reference the project objectives alongside general feedback, so that the Speaker receives feedback relevant to their specific project goals.

#### Acceptance Criteria

1. WHEN Project_Context is provided, THE Evaluation_Generator SHALL include the project type and objectives in the LLM prompt so that the evaluation addresses project-specific goals
2. WHEN Project_Context is provided, THE Evaluation_Generator SHALL instruct the LLM to mention the speech title and project type in the evaluation opening
3. WHEN Project_Context is not provided, THE Evaluation_Generator SHALL produce a general evaluation identical to Phase 2 behavior
4. WHEN the evaluation is saved via "Save Outputs", THE system SHALL include the Project_Context in the saved session metadata alongside the Consent_Record
5. WHEN Project_Context is provided, THE Evaluation_Generator SHALL include the project context in both the `generateEvaluation()` and `runEagerPipeline()` code paths, ensuring project-aware evaluations regardless of which pipeline produces the final output

**Design Principles** (not machine-testable — enforced via LLM prompt instructions):

- The LLM prompt SHALL instruct the model to include at least one commendation or recommendation that directly references a project objective
- Project objectives SHALL supplement rather than replace evidence-based feedback; the LLM prompt SHALL instruct the model to balance project-specific feedback with general Toastmasters evaluation criteria

### Requirement 6: Project Awareness — WebSocket Protocol Extension

**User Story:** As a developer, I want new client-to-server message types for project context, so that the UI can communicate project metadata to the server.

#### Acceptance Criteria

1. THE system SHALL define a new `set_project_context` ClientMessage type with fields: `speechTitle` (string), `projectType` (string), and `objectives` (string array)
2. WHEN the Server receives a `set_project_context` message while the Session is in IDLE state, THE Session_Manager SHALL store the Project_Context on the Session
3. IF the Server receives a `set_project_context` message while the Session is not in IDLE state, THEN THE Server SHALL reject the message with a recoverable error
4. THE system SHALL define a new `set_vad_config` ClientMessage type with fields: `silenceThresholdSeconds` (number) and `enabled` (boolean)
5. WHEN the Server receives a `set_vad_config` message while the Session is in IDLE state, THE Session_Manager SHALL store the VAD configuration on the Session
6. THE system SHALL define a new `vad_speech_end` ServerMessage type with a `silenceDurationSeconds` field indicating the duration of detected silence

### Requirement 7: Evidence Highlight UI — Transcript Navigation (Optional)

**User Story:** As an Operator, I want to click on evidence quotes in the evaluation to navigate to the corresponding position in the transcript, so that I can verify the evaluation's evidence.

#### Acceptance Criteria

1. WHEN the evaluation is displayed, THE Web_UI SHALL render each evidence quote as a clickable element visually distinguished from surrounding text
2. WHEN the Operator clicks an evidence quote in the evaluation panel, THE Web_UI SHALL scroll the transcript panel to the segment containing the quoted text and highlight the matching passage
3. THE Web_UI SHALL match evidence quotes to transcript segments using the same normalization rules as the Evidence_Validator (lowercase, strip punctuation, collapse whitespace)
4. IF an evidence quote cannot be matched to a transcript segment, THEN THE Web_UI SHALL display the quote without clickable navigation and without visual error indication
5. WHEN the Operator clicks a highlighted transcript passage, THE Web_UI SHALL remove the highlight after 3 seconds or when another evidence quote is clicked

### Requirement 8: Evidence Highlight UI — Metrics Dashboard (Optional)

**User Story:** As an Operator, I want to see a summary of delivery metrics alongside the evaluation, so that I can quickly review the Speaker's delivery statistics.

#### Acceptance Criteria

1. WHEN the Session has delivery metrics available, THE Web_UI SHALL display a metrics summary panel showing: speech duration, words per minute, filler word count, pause count (intentional vs hesitation), and energy variation coefficient
2. THE metrics summary panel SHALL be displayed below the evaluation panel and above the transcript panel
3. THE metrics summary panel SHALL use compact visual formatting (inline badges or a single-row layout) to avoid consuming excessive vertical space
4. WHEN the Session returns to IDLE state after delivery, THE metrics summary panel SHALL remain visible alongside the evaluation and transcript until data is purged

### Requirement 9: Session Data Extension

**User Story:** As a developer, I want the Session type to include VAD configuration and project context fields, so that all Phase 3 state is managed consistently with existing session data.

#### Acceptance Criteria

1. THE Session interface SHALL include a `projectContext` field containing `speechTitle` (string or null), `projectType` (string or null), and `objectives` (string array)
2. THE Session interface SHALL include a `vadConfig` field containing `silenceThresholdSeconds` (number, default 5) and `enabled` (boolean, default true)
3. WHEN a new Session is created, THE Session_Manager SHALL initialize `projectContext` with null values and `vadConfig` with default values
4. WHEN speaker opt-out occurs, THE Session_Manager SHALL purge `projectContext` as part of the full session data purge, consistent with the privacy retention policy
5. WHEN session auto-purge fires, THE Session_Manager SHALL clear `projectContext` and `evaluationPublic` alongside other session data

### Requirement 10: VAD — WebSocket Protocol for Audio Energy

**User Story:** As a developer, I want the server to send real-time audio energy levels to the client during recording, so that the UI can display a more accurate audio level meter driven by VAD computations.

#### Acceptance Criteria

1. WHILE the Session is in RECORDING state, THE Server SHALL send periodic `vad_status` messages to the client containing the current RMS energy level and whether the VAD_Monitor classifies the current audio as speech or silence
2. THE Server SHALL send `vad_status` messages at a rate of no more than 4 per second to avoid flooding the WebSocket connection
3. THE Web_UI SHALL use the `vad_status` energy level to drive the existing audio level meter, preferring over the client-side AudioWorklet-based level computation when VAD data is available
4. IF the Web_UI does not receive a `vad_status` message for more than 2 seconds during RECORDING state, THE Web_UI SHALL fall back to the client-side AudioWorklet-based level computation until `vad_status` messages resume

### Requirement 11: VAD — Lifecycle Integration with Safety Controls

**User Story:** As a developer, I want the VAD_Monitor to be properly stopped during panic mute and speaker opt-out, so that no stale VAD events are emitted after the session leaves RECORDING state.

#### Acceptance Criteria for Requirement 11

1. WHEN `panicMute()` is called, THE Session_Manager SHALL stop the active VAD_Monitor (if any) before transitioning to IDLE state
2. WHEN `revokeConsent()` is called, THE Session_Manager SHALL stop the active VAD_Monitor (if any) as part of the data purge
3. WHEN `stopRecording()` is called, THE Session_Manager SHALL stop the active VAD_Monitor before proceeding with post-speech processing
4. AFTER the VAD_Monitor is stopped, it SHALL NOT emit any further `onSpeechEnd` or `onStatus` callbacks
