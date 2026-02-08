# Requirements Document

## Introduction

The AI Toastmasters Evaluator MVP (Phase 1) is an audio-only, manually-controlled conversational AI system that listens to a live speech at an in-person Toastmasters meeting, generates a Toastmasters-style evaluation, and delivers it out loud via text-to-speech. The system handles a single speech per session, captures audio via USB or boundary microphone, transcribes the speech in real time, computes delivery metrics deterministically, and produces a supportive, evidence-based spoken evaluation. A web-based UI provides manual controls for the meeting operator. The system runs on an internet-connected laptop with a separate speaker for audio output.

## Glossary

- **Operator**: The person controlling the system during a Toastmasters meeting via the web-based UI
- **Speaker**: The Toastmasters club member delivering a speech being evaluated
- **Session**: A single end-to-end workflow covering one speech: from starting audio capture through delivering the evaluation
- **Transcript**: A timestamped textual representation of the Speaker's speech produced by the Transcription_Engine
- **Delivery_Metrics**: A structured JSON object containing deterministic measurements of speech delivery (WPM, filler words, duration, pauses)
- **Evaluation**: A natural-language assessment of the speech containing commendations and recommendations, all grounded in evidence from the Transcript
- **Web_UI**: The browser-based control interface used by the Operator to manage a Session
- **Audio_Capture_Module**: The component responsible for capturing audio from the microphone and routing it to the Transcription_Engine
- **Transcription_Engine**: The component that converts captured audio into a timestamped Transcript in real time
- **Metrics_Extractor**: The component that computes Delivery_Metrics deterministically from the Transcript
- **Evaluation_Generator**: The component that produces the Evaluation from the Transcript and Delivery_Metrics using an LLM
- **TTS_Engine**: The text-to-speech component that converts the Evaluation into spoken audio output
- **Filler_Word**: A word or phrase used as a verbal pause that does not contribute meaning, detected contextually (e.g., "um", "uh", "ah", "like", "you know", "so", "basically")
- **Commendation**: A specific, evidence-based positive observation about the speech
- **Recommendation**: A specific, evidence-based suggestion for improvement
- **Echo_Prevention**: Mechanisms to prevent the TTS audio output from being captured by the microphone

## Requirements

### Requirement 1: Session Lifecycle Management

**User Story:** As an Operator, I want to control the evaluation session through discrete manual steps, so that I can coordinate the AI evaluator with the flow of a live Toastmasters meeting.

#### Acceptance Criteria

1. WHEN the Operator opens the Web_UI, THE Web_UI SHALL display a "Start Speech" button as the only available action
2. WHEN the Operator clicks "Start Speech", THE Audio_Capture_Module SHALL begin capturing audio from the configured microphone and THE Transcription_Engine SHALL begin producing a live Transcript
3. WHILE a Session is recording, THE Web_UI SHALL display a "Stop Speech" button and a live elapsed-time indicator
4. WHEN the Operator clicks "Stop Speech", THE Audio_Capture_Module SHALL stop capturing audio and THE Transcription_Engine SHALL finalize the Transcript
5. WHEN the Transcript is finalized, THE Web_UI SHALL display a "Deliver Evaluation" button
6. WHEN the Operator clicks "Deliver Evaluation", THE Evaluation_Generator SHALL produce the Evaluation and THE TTS_Engine SHALL speak the Evaluation through the configured audio output device
7. WHILE the TTS_Engine is delivering the Evaluation, THE Web_UI SHALL display a "Speaking..." indicator and disable further actions
8. WHEN the TTS_Engine finishes delivering the Evaluation, THE Web_UI SHALL return to the initial state ready for a new Session

### Requirement 2: Audio Capture and Transcription

**User Story:** As an Operator, I want the system to capture and transcribe the Speaker's speech in real time, so that the AI evaluator has an accurate textual record to base its evaluation on.

#### Acceptance Criteria

1. THE Audio_Capture_Module SHALL capture audio from a USB or boundary microphone connected to the laptop
2. THE Transcription_Engine SHALL produce a Transcript with word-level or segment-level timestamps
3. THE Transcription_Engine SHALL support speeches ranging from 1 minute to 25 minutes in duration
4. WHILE a Session is recording, THE Web_UI SHALL display the live Transcript as it is produced
5. THE Audio_Capture_Module SHALL implement Echo_Prevention so that TTS output from the speaker device is not captured by the microphone

### Requirement 3: Delivery Metrics Extraction

**User Story:** As an Operator, I want the system to compute objective delivery metrics from the speech, so that the evaluation includes quantitative evidence about the Speaker's delivery.

#### Acceptance Criteria

1. WHEN the Transcript is finalized, THE Metrics_Extractor SHALL compute the speech duration in minutes and seconds from the Transcript timestamps
2. WHEN the Transcript is finalized, THE Metrics_Extractor SHALL compute the words-per-minute rate from the total word count and speech duration
3. WHEN the Transcript is finalized, THE Metrics_Extractor SHALL detect Filler_Words contextually and compute a filler word count and frequency
4. WHEN the Transcript is finalized, THE Metrics_Extractor SHALL estimate pause count and total pause duration from gaps in the Transcript timestamps
5. WHEN the Transcript is finalized, THE Metrics_Extractor SHALL output the Delivery_Metrics as a structured JSON object
6. THE Metrics_Extractor SHALL detect Filler_Words dynamically using contextual analysis rather than relying solely on a fixed word list

### Requirement 4: Evaluation Generation

**User Story:** As an Operator, I want the system to generate a supportive, evidence-based evaluation in a natural conversational style, so that the evaluation sounds like a skilled Toastmasters evaluator.

#### Acceptance Criteria

1. THE Evaluation_Generator SHALL produce an Evaluation containing 2 to 3 Commendations
2. THE Evaluation_Generator SHALL produce an Evaluation containing 1 to 2 Recommendations
3. THE Evaluation_Generator SHALL ground every Commendation and Recommendation in specific evidence from the Transcript by quoting or citing the Speaker's words or observed behavior
4. THE Evaluation_Generator SHALL produce the Evaluation in a free-form natural conversational style without using the CRC (Commend-Recommend-Commend) sandwich pattern
5. THE Evaluation_Generator SHALL produce an Evaluation that, when spoken by the TTS_Engine, lasts between 90 seconds and 3 minutes 30 seconds
6. THE Evaluation_Generator SHALL use only information present in the Transcript and Delivery_Metrics and SHALL NOT fabricate or hallucinate content

### Requirement 5: Text-to-Speech Delivery

**User Story:** As an Operator, I want the evaluation to be spoken aloud in a warm, conversational voice, so that the evaluation delivery feels natural in a Toastmasters meeting setting.

#### Acceptance Criteria

1. WHEN the Evaluation is ready, THE TTS_Engine SHALL convert the Evaluation text into spoken audio and play it through the configured output device
2. THE TTS_Engine SHALL use a warm, conversational voice suitable for a Toastmasters meeting
3. WHILE the TTS_Engine is speaking, THE Audio_Capture_Module SHALL remain inactive to prevent audio feedback loops

### Requirement 6: Output Persistence

**User Story:** As an Operator, I want the transcript, metrics, and evaluation saved to files after the session, so that the Speaker and club have a written record.

#### Acceptance Criteria

1. WHEN a Session completes, THE Web_UI SHALL display a "Save Outputs" button
2. WHEN the Operator clicks "Save Outputs", THE system SHALL save the full Transcript to a text file
3. WHEN the Operator clicks "Save Outputs", THE system SHALL save the Delivery_Metrics JSON to a file
4. WHEN the Operator clicks "Save Outputs", THE system SHALL save the written Evaluation to a text file
5. THE system SHALL organize output files by session with a timestamp-based naming convention

### Requirement 7: Error Handling and Resilience

**User Story:** As an Operator, I want the system to handle poor audio quality gracefully, so that the meeting is not disrupted even when conditions are imperfect.

#### Acceptance Criteria

1. IF the Transcript quality is poor or incomplete, THEN THE Evaluation_Generator SHALL produce a best-effort Evaluation with explicit caveats noting the audio quality limitations
2. IF the Audio_Capture_Module fails to detect a microphone, THEN THE Web_UI SHALL display a clear error message identifying the issue
3. IF the Transcription_Engine encounters an error during transcription, THEN THE Web_UI SHALL display the error and allow the Operator to stop the Session gracefully
4. IF the TTS_Engine fails to produce audio output, THEN THE Web_UI SHALL display the written Evaluation as a fallback

### Requirement 8: Extensibility Architecture

**User Story:** As a developer, I want the system architecture to support future enhancements, so that features like configurable TTS voices, project-specific objectives, and multi-speaker sessions can be added without major refactoring.

#### Acceptance Criteria

1. THE system SHALL separate audio capture, transcription, metrics extraction, evaluation generation, and TTS delivery into distinct components with defined interfaces
2. THE Evaluation_Generator SHALL accept an optional evaluation objectives parameter that is unused in Phase 1 but allows project-specific criteria in future phases
3. THE TTS_Engine SHALL accept a voice configuration parameter that defaults to a single voice in Phase 1 but allows voice selection in future phases
4. THE system SHALL structure the Session model to support extension to multiple speakers per session in future phases
