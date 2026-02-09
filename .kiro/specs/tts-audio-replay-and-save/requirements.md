# Requirements Document

## Introduction

This feature adds TTS audio replay capability and audio file persistence to the AI Toastmasters Evaluator. Currently, the TTS evaluation audio is synthesized and streamed to the client in a single pass — once playback finishes, the audio is gone. This feature caches the synthesized audio buffer server-side in the session, exposes a replay mechanism so the operator can listen again without re-calling OpenAI, and includes the TTS audio file alongside existing outputs when "Save Outputs" is clicked.

## Glossary

- **Session_Manager**: The server-side component that manages session state, coordinates the pipeline, and stores session data in memory.
- **TTS_Audio_Cache**: The in-memory buffer on the server that stores the synthesized TTS audio for the duration of the session lifecycle.
- **Replay_Handler**: The server-side handler that responds to replay requests by sending the cached TTS audio buffer to the client.
- **File_Persistence**: The component responsible for writing session outputs to disk when the operator clicks "Save Outputs".
- **Operator**: The person controlling the evaluator application during a Toastmasters meeting.
- **Client_UI**: The browser-based user interface that the operator interacts with.

## Requirements

### Requirement 1: Server-Side TTS Audio Caching

**User Story:** As an operator, I want the synthesized TTS audio to be cached in the session after synthesis, so that replay does not require a new OpenAI TTS API call.

#### Acceptance Criteria

1. WHEN the TTS_Engine synthesizes evaluation audio, THE Session_Manager SHALL store the resulting audio buffer in the session object as the TTS_Audio_Cache.
2. WHILE the session holds a TTS_Audio_Cache, THE Session_Manager SHALL retain the cached audio buffer in memory following the same retention lifecycle as other session data (auto-purge after 10 minutes, purge on opt-out).
3. WHEN a panic mute occurs, THE Session_Manager SHALL preserve the TTS_Audio_Cache alongside other session data (consistent with existing panic mute behavior that preserves audio chunks).
4. WHEN an auto-purge timer fires or a speaker opt-out purge occurs, THE Session_Manager SHALL clear the TTS_Audio_Cache along with all other session data.
5. WHEN a new recording is started on the same session, THE Session_Manager SHALL clear the previous TTS_Audio_Cache.

### Requirement 2: TTS Audio Replay via WebSocket

**User Story:** As an operator, I want to replay the TTS evaluation audio without re-calling OpenAI, so that I can listen to the evaluation again during the meeting.

#### Acceptance Criteria

1. WHEN the Client_UI sends a replay_tts message and a TTS_Audio_Cache exists in the session, THE Replay_Handler SHALL send the cached audio buffer to the client using the existing tts_audio and tts_complete message sequence.
2. WHEN the Client_UI sends a replay_tts message and no TTS_Audio_Cache exists in the session, THE Replay_Handler SHALL respond with a recoverable error message indicating no audio is available for replay.
3. WHILE the session is in DELIVERING state, THE Replay_Handler SHALL reject replay_tts requests with a recoverable error message.
4. WHEN a replay_tts message is received, THE Session_Manager SHALL transition the session to DELIVERING state before streaming audio, and transition back to IDLE after streaming completes.

### Requirement 3: Replay Button in the UI

**User Story:** As an operator, I want a visible replay button after evaluation delivery, so that I can trigger audio replay with a single click.

#### Acceptance Criteria

1. WHEN the session returns to IDLE state after evaluation delivery and a TTS audio was successfully played, THE Client_UI SHALL display a replay button.
2. WHILE the session is in DELIVERING state, THE Client_UI SHALL disable the replay button.
3. WHEN the operator clicks the replay button, THE Client_UI SHALL send a replay_tts message to the server and initiate TTS audio playback using the same playback mechanism as the initial delivery.
4. WHEN a new recording is started, THE Client_UI SHALL hide the replay button.
5. WHEN a speaker opt-out purge occurs, THE Client_UI SHALL hide the replay button.
6. WHEN the replay button is clicked, THE Client_UI SHALL apply the same echo prevention controls as the initial delivery (hard-stop mic, cooldown after playback).

### Requirement 4: TTS Audio File Persistence

**User Story:** As an operator, I want the TTS audio file included when I click "Save Outputs", so that I have a complete record of the evaluation including the spoken audio.

#### Acceptance Criteria

1. WHEN the operator clicks "Save Outputs" and a TTS_Audio_Cache exists in the session, THE File_Persistence SHALL write the audio buffer to an evaluation_audio.mp3 file in the output directory alongside transcript.txt, metrics.json, and evaluation.txt.
2. WHEN the operator clicks "Save Outputs" and no TTS_Audio_Cache exists in the session, THE File_Persistence SHALL save the other output files without the audio file and include the audio file path only if it was written.
3. WHEN the audio file is saved, THE File_Persistence SHALL include the audio file path in the outputs_saved response paths array.
4. IF the audio file write fails, THEN THE File_Persistence SHALL log the error, continue saving the remaining output files, and include an error indication in the response.
