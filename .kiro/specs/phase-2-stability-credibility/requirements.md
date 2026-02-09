# Requirements Document

## Introduction

Phase 2 — Stability & Credibility builds on the existing AI Toastmasters Evaluator MVP (Phase 1) to make the evaluator consistent, evidence-grounded, and safe for regular meeting use. This phase focuses on meeting evaluator credibility: human-like structure commentary, stable tone, minimal ungrounded content. All feedback remains descriptive — no scores, ratings, or numerical assessments. Phase 2 extends the existing codebase with six capability areas: evidence anchoring strengthening, speaker consent capture, tone guardrails, speech structure awareness, delivery metrics improvements, and meeting timing enforcement.

## Glossary

- **Operator**: The person controlling the system during a Toastmasters meeting via the Web_UI
- **Speaker**: The Toastmasters club member delivering a speech being evaluated
- **Session**: A single end-to-end workflow covering one speech, from starting audio capture through delivering the evaluation
- **Transcript**: A timestamped textual representation of the Speaker's speech produced by the Transcription_Engine
- **Delivery_Metrics**: A structured JSON object containing measurements of speech delivery (WPM, filler words, duration, pauses, energy variation, pause classification)
- **Evaluation**: A natural-language assessment of the speech containing commendations and recommendations, all grounded in evidence from the Transcript
- **Web_UI**: The browser-based control interface used by the Operator to manage a Session
- **Evaluation_Generator**: The component that produces the Evaluation from the Transcript and Delivery_Metrics using an LLM
- **TTS_Engine**: The text-to-speech component that converts the Evaluation into spoken audio output
- **Metrics_Extractor**: The component that computes Delivery_Metrics deterministically from the Transcript
- **Evidence_Validator**: The component that validates evidence quotes against the Transcript using contiguous token matching and timestamp locality
- **Tone_Checker**: A new component that validates evaluation text against prohibited content patterns before delivery
- **Structure_Analyzer**: A new logical section within the Evaluation_Generator that detects and comments on speech structure (opening, body, closing)
- **Consent_Record**: A metadata object capturing the Speaker's name and consent status for the current Session
- **Filler_Word**: A word or phrase used as a verbal pause, classified as either a true filler or an intentional discourse marker
- **Intentional_Pause**: A pause used for rhetorical effect (dramatic pause, emphasis), distinguished from a hesitation pause
- **Hesitation_Pause**: A pause caused by uncertainty or loss of thought, distinguished from an intentional pause
- **Speech_Energy**: An RMS-based proxy measurement for vocal variety, capturing loud/soft and fast/slow variation across the speech
- **Time_Limit**: A configurable maximum duration for evaluation delivery, enforced by trimming the evaluation script before TTS synthesis
- **Prohibited_Content**: Content patterns that violate tone policy, including fabricated observations, personal judgments, psychological inferences, and ungrounded claims
- **Structure_Commentary**: Descriptive observations about the speech's opening, body organization, and closing effectiveness

## Requirements

### Requirement 1: Evidence Anchoring Strengthening

**User Story:** As an Operator, I want every commendation and recommendation to cite specific transcript evidence with timestamp references, so that the evaluation is credible and verifiable.

#### Acceptance Criteria

1. THE Evaluation_Generator SHALL include an evidence_quote and evidence_timestamp in every EvaluationItem produced, where evidence_timestamp represents the start time of the first token in the validated contiguous quote from the canonical post-speech Transcript
2. WHEN the Evaluation_Generator produces a StructuredEvaluation, THE Evidence_Validator SHALL validate every evidence_quote against the Transcript before the evaluation is rendered into a script
3. THE Evidence_Validator SHALL perform validation against the canonical post-speech Transcript before any redaction is applied
4. IF an EvaluationItem fails evidence validation, THEN THE Evaluation_Generator SHALL re-prompt the LLM for that specific item with a maximum of 1 retry per item
5. IF dropping failed items would leave fewer than 2 commendations or fewer than 1 recommendation, THEN THE Evaluation_Generator SHALL regenerate the full evaluation with a maximum of 2 total generation attempts
6. WHEN evidence validation completes, THE Evidence_Validator SHALL report the pass rate as the ratio of items that passed on the first LLM attempt to total delivered items in the accepted evaluation
7. THE Evidence_Validator SHALL validate that the absolute difference between evidence_timestamp and the start time of the first matched token is at most 20 seconds (configurable)
8. THE Evidence_Validator SHALL require a contiguous match of at least 6 consecutive normalized tokens (lowercase, punctuation stripped, whitespace collapsed) between evidence_quote and the canonical Transcript text
9. THE Evidence_Validator SHALL enforce that evidence_quote contains at most 15 tokens and SHALL fail validation otherwise

### Requirement 2: Speaker Consent Capture

**User Story:** As an Operator, I want to capture the Speaker's name and verbal consent before recording, so that the system respects speaker privacy and logs consent for each session.

#### Acceptance Criteria

1. WHEN the Operator opens the Web_UI in IDLE state, THE Web_UI SHALL display input fields for the Speaker's name and a consent confirmation checkbox before the "Start Speech" button becomes active
2. WHEN the Operator provides a Speaker name and confirms consent, THE Session SHALL store a Consent_Record containing the Speaker name, consent status, and timestamp
3. WHILE a Session has no confirmed consent, THE Web_UI SHALL keep the "Start Speech" button disabled
4. WHEN recording starts, THE Consent_Record SHALL become immutable for that Session
5. THE Web_UI SHALL display the current consent status (Speaker name and consent confirmed) in the session information area throughout the Session
6. WHEN the Operator clicks "Save Outputs", THE system SHALL include the Consent_Record in the saved session metadata
7. WHEN a Speaker opts out (consent is revoked), THE system SHALL purge all session data immediately and irrecoverably as defined by the privacy retention policy

### Requirement 3: Tone Guardrails

**User Story:** As an Operator, I want automated tone policy checks on the evaluation before delivery, so that the evaluation contains only supportive, growth-oriented feedback without fabricated or inappropriate content.

#### Acceptance Criteria

1. THE Tone_Checker SHALL validate the rendered evaluation script against a set of prohibited content patterns implemented as deterministic regex and rule-based checks (not LLM-based) before TTS synthesis
2. THE Tone_Checker SHALL detect and flag claims of specific events or behaviors that imply facts not derivable from Transcript evidence or deterministic Delivery_Metrics, where transcript support is satisfied only when a claim is backed by either (a) an evidence-validated quote already present in the StructuredEvaluation items, or (b) explicit references to deterministic Delivery_Metrics fields; general coaching language is allowed but must not assert unverifiable facts
3. THE Tone_Checker SHALL detect and flag personal judgments or psychological inferences about the Speaker (e.g., "you seem nervous", "you lack confidence")
4. THE Tone_Checker SHALL detect and flag language that makes claims beyond audio-only observation scope (e.g., references to body language, eye contact, facial expressions)
5. THE Tone_Checker SHALL detect and flag punitive or diagnostic language (e.g., "you failed to", "you struggle with")
6. THE Tone_Checker SHALL detect and flag numerical scores, ratings, or percentage-based assessments
7. IF the Tone_Checker detects prohibited content in the evaluation script, THEN THE Evaluation_Generator SHALL re-prompt the LLM to revise the flagged sections with a maximum of 1 tone-fix retry
8. IF the tone-fix retry still contains prohibited content, THEN THE system SHALL strip the offending sentences from the script and log a warning
9. IF stripping offending sentences would remove all recommendations or all commendations, THEN THE system SHALL regenerate the evaluation using the short-form fallback defined in Requirement 9 instead of stripping
10. WHEN the audio quality warning is present OR the evaluation references structural inference, THE Tone_Checker SHALL append a scope acknowledgment sentence to the evaluation script stating that the evaluation is based on audio content only

### Requirement 4: Speech Structure Awareness

**User Story:** As an Operator, I want the evaluation to include descriptive commentary on the speech's structure (opening, body, closing), so that the Speaker receives feedback on how their speech was organized.

#### Acceptance Criteria

1. WHEN generating an evaluation, THE Evaluation_Generator SHALL analyze the Transcript to identify the speech opening (first 10-15% of content), body (middle 70-80%), and closing (final 10-15%)
2. IF the Transcript contains fewer than 120 words OR segment boundaries are ambiguous, THEN THE Structure_Analyzer SHALL fall back to heuristic markers (e.g., "today I want to", "in conclusion") for segmentation
3. IF no reliable opening or closing markers are detected, THEN THE Structure_Analyzer SHALL omit that section's commentary rather than produce speculative observations
4. THE Evaluation_Generator SHALL produce descriptive commentary on the opening effectiveness, including whether the Speaker used a hook or attention-grabber, identified using heuristic cues
5. THE Evaluation_Generator SHALL produce descriptive commentary on body organization and clarity, including whether the main points were distinguishable
6. THE Evaluation_Generator SHALL produce descriptive commentary on closing strength, including whether the Speaker used a call to action or memorable ending, identified using heuristic cues
7. THE Evaluation_Generator SHALL include a brief assessment of overall message clarity and coherence
8. THE Evaluation_Generator SHALL express all structure commentary in descriptive language without numerical scores or ratings
9. THE StructuredEvaluation interface SHALL include a structure_commentary field containing opening_comment, body_comment, and closing_comment strings

### Requirement 5: Delivery Metrics Improvements

**User Story:** As an Operator, I want improved delivery metrics that distinguish intentional pauses from hesitation pauses, measure vocal variety, and classify filler words more accurately, so that the evaluation is informed by richer speech analysis.

#### Acceptance Criteria

1. WHEN detecting pauses, THE Metrics_Extractor SHALL identify pause candidates with duration at or above a configurable minimum candidate threshold (default 300 milliseconds) and SHALL classify reportable pauses using a configurable reportable threshold (default 1.5 seconds); classification heuristics MAY consider candidates below the reportable threshold, but reported pause counts SHALL use the reportable threshold
2. THE Metrics_Extractor SHALL classify a pause as an Intentional_Pause when the pause follows a complete clause or sentence and precedes a new thought or emphasis
3. THE Metrics_Extractor SHALL classify a pause as a Hesitation_Pause when the pause occurs mid-sentence, is preceded by a filler word, or is followed by a repeated or rephrased word
4. THE Evaluation_Generator SHALL treat pause classification as heuristic and SHALL NOT present pause types as definitive assessments in the evaluation
5. THE Metrics_Extractor SHALL compute Speech_Energy variation as an RMS-based proxy from the audio amplitude data, producing a normalized energy profile across the speech duration
6. THE Metrics_Extractor SHALL normalize the Speech_Energy profile across speech duration so that the measurement is invariant to microphone gain
7. THE Metrics_Extractor SHALL exclude silence segments below the speech energy threshold from the energy variation computation to prevent artificial spikes, where the speech energy threshold is an adaptive percentile-based value computed from the RMS distribution (e.g., median plus a configurable multiple of the median absolute deviation)
8. THE Metrics_Extractor SHALL segment the Speech_Energy profile into fixed time windows of 250 milliseconds (configurable) and compute the coefficient of variation to quantify vocal variety
9. WHEN detecting filler words, THE Metrics_Extractor SHALL classify each detected filler as either a true filler or an intentional discourse marker based on surrounding word context and position
10. THE DeliveryMetrics interface SHALL include fields for intentional pause count, hesitation pause count, energy variation coefficient, and filler classification breakdown
11. THE system SHALL NOT persist raw per-sample amplitude data; the system SHALL retain only the derived energy profile needed for metrics computation, subject to the in-memory purge policy

### Requirement 6: Meeting Timing Enforcement

**User Story:** As an Operator, I want a configurable hard time limit on evaluation delivery with safe stop behavior, so that the evaluation fits within the allotted meeting time.

#### Acceptance Criteria

1. THE TTS_Engine SHALL accept a configurable Time_Limit parameter with a default value of 120 seconds (2 minutes)
2. WHEN the evaluation script is ready for TTS synthesis, THE TTS_Engine SHALL estimate the spoken duration using word count divided by calibrated WPM, including a configurable safety margin (default 8%) to prevent overrun
3. IF the estimated duration exceeds the configured Time_Limit, THEN THE TTS_Engine SHALL trim the evaluation script at a sentence boundary to fit within the Time_Limit
4. WHEN trimming the evaluation script, THE TTS_Engine SHALL preserve the opening and at least one commendation, then append a brief closing sentence
5. IF trimming would remove all recommendations, THEN THE TTS_Engine SHALL preserve the strongest recommendation instead of a second commendation
6. WHEN trimming the evaluation script, THE TTS_Engine SHALL ensure the trimmed script ends with a complete sentence and a natural closing phrase
7. AFTER trimming, THE system SHALL ensure any required scope acknowledgment sentence (appended by the Tone_Checker) remains present, re-appending it if it was removed and re-estimating duration
8. THE Web_UI SHALL display the configured Time_Limit and the estimated evaluation duration before the Operator clicks "Deliver Evaluation"
9. THE Web_UI SHALL allow the Operator to adjust the Time_Limit before delivery through a configuration control

### Requirement 7: Evaluation Consistency and Stability

**User Story:** As an Operator, I want the evaluation to produce stable, consistent results across multiple runs on the same transcript, so that the system is predictable and trustworthy.

#### Acceptance Criteria

1. WHEN generating an evaluation, THE Evaluation_Generator SHALL use a fixed LLM temperature setting that balances variety with consistency
2. THE Evaluation_Generator SHALL produce evaluations that maintain a stable structure of 2-3 commendations and 1-2 recommendations across repeated runs on the same Transcript
3. THE Evaluation_Generator SHALL produce evaluations where the thematic content of commendations and recommendations overlaps by at least 70% across repeated runs on the same Transcript, measured using cosine similarity between normalized summary embeddings with a threshold of 0.75 or an equivalent deterministic method; consistency scoring is a monitoring metric measured in background telemetry and SHALL NOT block evaluation delivery in Phase 2
4. THE system prompt for the Evaluation_Generator SHALL include explicit instructions for consistent structure and evidence selection behavior
5. THE consistency measurement SHALL use a fixed embedding model specified as a configured constant and deterministic normalization to ensure reproducible similarity scoring

### Requirement 8: Privacy and Data Handling

**User Story:** As an Operator, I want the system to handle speaker data according to strict privacy rules, so that third-party names are redacted and session data is purged appropriately.

#### Acceptance Criteria

1. WHEN rendering the evaluation script for TTS delivery, THE Evaluation_Generator SHALL redact third-party names and replace each occurrence with a generic phrase such as "a fellow member", where a third-party name is defined as any named private individual other than the Speaker, including first names, full names, and identifiable nicknames, but excluding public places, organizations, books, and brands unless explicitly configured
2. THE Evaluation_Generator SHALL preserve the Speaker's own name (from the Consent_Record) without redaction in the rendered script
3. THE Evidence_Validator SHALL validate evidence quotes against the raw unredacted Transcript, and THE Evaluation_Generator SHALL apply name redaction only after validation passes, ensuring that redaction does not invalidate previously validated evidence quotes
4. Redaction SHALL apply to all user-visible outputs including the TTS script, fallback display text, and saved evaluation text; redaction MAY modify evidence quotes for delivery, but the system SHALL preserve the quote's word-count cap intent and SHALL NOT introduce new words other than generic replacements
5. Redaction SHALL be conservative: if an entity cannot be confidently classified as a private individual name, the system SHALL NOT redact it
6. WHEN a Session completes TTS delivery and returns to IDLE state, THE system SHALL start a 10-minute auto-purge timer for all session data held in memory
7. WHEN the auto-purge timer fires, THE system SHALL null all transcript, metrics, evaluation, audio chunk references, and cancel any pending async processing from the Session while preserving the Session object for UI state
8. IF the Operator starts a new recording on the same Session before the purge timer fires, THEN THE system SHALL reset the purge timer


### Requirement 9: Evaluation Shape Enforcement

**User Story:** As an Operator, I want the system to guarantee a consistent evaluation shape after all retries and validation, so that every delivered evaluation has meaningful content.

#### Acceptance Criteria

1. THE system SHALL guarantee that every delivered evaluation contains 2-3 commendations and 1-2 recommendations after all evidence validation retries complete
2. IF the system cannot meet the shape invariant after exhausting all retry and regeneration attempts, THEN THE system SHALL deliver a short-form fallback evaluation containing at least 1 commendation and 1 recommendation with a logged warning
3. THE short-form fallback evaluation SHALL still satisfy evidence validation requirements for all included items

### Requirement 10: Quality Warning Propagation

**User Story:** As an Operator, I want the evaluation to clearly communicate when transcript quality is degraded, so that the Speaker understands the evaluation may be incomplete.

#### Acceptance Criteria

1. WHEN the Transcript quality is degraded (fewer than 10 words per minute of recording OR average word confidence below 0.5, computed over transcript tokens excluding silence and non-speech markers), THE Evaluation_Generator SHALL include an uncertainty qualifier in the evaluation opening
2. WHEN the quality warning is active, THE Evaluation_Generator SHALL reduce claim strength by limiting evidence-dependent observations to only high-confidence Transcript segments, where a high-confidence segment has a mean word confidence of 0.7 or above (configurable)
3. THE Evaluation_Generator SHALL NOT fabricate content to compensate for gaps in a degraded Transcript

### Requirement 11: Processing Pipeline Ordering

**User Story:** As a developer, I want a deterministic processing pipeline order, so that evidence validation, tone checking, and redaction occur in the correct sequence.

#### Acceptance Criteria

1. THE system SHALL execute item-level evidence retry before full evaluation regeneration
2. THE system SHALL execute tone-fix retry only after evidence validation succeeds
3. THE system SHALL apply name redaction only after both evidence validation and tone checking complete
4. THE system SHALL execute meeting timing trimming as the final step before TTS synthesis, and trimming SHALL preserve sentence boundaries to ensure tone compliance is maintained without requiring a second tone check
5. THE complete pipeline order SHALL be: evidence validation and retry, tone checking and retry, script rendering, meeting timing trim at sentence boundaries, name redaction, TTS synthesis
