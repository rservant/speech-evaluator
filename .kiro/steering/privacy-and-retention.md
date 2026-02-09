# Privacy and Retention

This document defines the data handling, retention, and privacy invariants for the AI Toastmasters Evaluator. Treat these as compliance requirements, not feature suggestions.

## Data Classification

| Data Type | Contains PII | Sent to Provider | Retention |
|---|---|---|---|
| Audio chunks (raw PCM) | Yes (voice) | Deepgram (live), OpenAI (post-pass) | In-memory only. Never written to disk. Purged on session end or opt-out. |
| Live transcript segments | Possibly (names) | None (derived from Deepgram response) | In-memory only. Replaced by final transcript after post-pass. |
| Final transcript | Possibly (names) | None (derived from OpenAI response) | In-memory until purge timer or opt-out. Persisted only on explicit "Save Outputs". |
| Delivery metrics JSON | No | None (computed locally) | Same as final transcript. |
| Structured evaluation | Possibly (names in quotes) | None (derived from OpenAI response) | Same as final transcript. |
| Evaluation script (rendered) | Possibly (names in quotes) | OpenAI TTS (voice synthesis) | Same as final transcript. |

## Retention Lifecycle

- Session data lives in server memory only. No database, no temp files.
- After TTS delivery completes (state returns to IDLE), a 10-minute auto-purge timer starts.
- The timer resets if the operator starts a new recording on the same session.
- When the timer fires: all transcript, metrics, evaluation, and audio chunk references are nulled. The session object remains (for UI state) but holds no speech data.
- "Save Outputs" writes transcript.txt, metrics.json, and evaluation.txt to disk. This is the only path to persistence. Once saved, the files are the operator's responsibility.

## Speaker Opt-Out Purge

- When a speaker opts out, all session data is purged immediately and irrecoverably.
- The "Save Outputs" button must be disabled/hidden after an opt-out purge.
- If outputs were already saved to disk before opt-out, the system cannot unsave them. The operator is responsible for deleting saved files.
- Opt-out purge clears: audio chunks, transcript, live transcript, metrics, evaluation, evaluation script.

## Third-Party Name Redaction

- The final transcript may contain names of other club members mentioned by the speaker.
- Evidence quotes in the evaluation must be validated against the raw (unredacted) transcript.
- For delivery (TTS script rendering), third-party names should be replaced with "[a fellow member]" or similar generic phrasing.
- The speaker's own name (if provided via `speakerName`) is not redacted.

## Provider Data Handling

- Audio is sent to Deepgram for live transcription and to OpenAI for post-speech transcription.
- Transcript text and metrics are sent to OpenAI GPT-4o for evaluation generation.
- Evaluation script text is sent to OpenAI TTS for voice synthesis.
- Do not make promises about provider-side retention policies in the UI or documentation. State only what the system controls.

## Implementation Checkpoints

When modifying these components, verify compliance with this document:
- Session manager state transitions and cleanup
- "Save Outputs" button visibility and gating logic
- Evidence quote rendering and redaction pipeline
- Audio chunk lifecycle (allocation, buffering, purge)
- Panic mute and opt-out data handling
