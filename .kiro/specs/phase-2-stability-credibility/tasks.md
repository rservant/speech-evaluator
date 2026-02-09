# Implementation Plan: Phase 2 — Stability & Credibility

## Overview

Phase 2 extends the existing AI Toastmasters Evaluator with consent capture, tone guardrails, speech structure awareness, enhanced delivery metrics, meeting timing enforcement, and pipeline orchestration. All implementation is in TypeScript, extending existing source files. Tasks are ordered so each builds on the previous, with property tests close to their implementation.

## Tasks

- [ ] 1. Extend type definitions and shared utilities
  - [ ] 1.1 Add Phase 2 types to `src/types.ts`
    - Add `ConsentRecord`, `StructureCommentary`, `ClassifiedPause`, `EnergyProfile`, `ClassifiedFillerEntry` interfaces
    - Add `EvaluationItemPublic`, `StructuredEvaluationPublic`, `RedactionInput`, `RedactionOutput` interfaces
    - Add `ToneViolation`, `ToneCheckResult` interfaces
    - Extend `StructuredEvaluation` with `structure_commentary: StructureCommentary`
    - Extend `DeliveryMetrics` with Phase 2 fields (`intentionalPauseCount`, `hesitationPauseCount`, `classifiedPauses`, `energyVariationCoefficient`, `energyProfile`, `classifiedFillers`)
    - Extend `TTSConfig` with `safetyMarginPercent` (default 8)
    - Extend `Session` with `consent`, `timeLimitSeconds` (default 120), `evaluationPassRate`
    - Add new `ClientMessage` variants (`set_consent`, `revoke_consent`, `set_time_limit`)
    - Add new `ServerMessage` variants (`consent_status`, `duration_estimate`, `data_purged`)
    - _Requirements: 2.2, 4.9, 5.10, 6.1, 8.1_

  - [ ] 1.2 Create shared `splitSentences()` utility in `src/utils.ts`
    - Implement deterministic sentence segmentation (split on `.!?` followed by whitespace or end of string)
    - Handle common abbreviations and decimal numbers
    - Export for use by ToneChecker, TTSEngine, and EvaluationGenerator
    - _Requirements: 11.4_

- [ ] 2. Implement ConsentRecord and session consent management
  - [ ] 2.1 Add consent management methods to `src/session-manager.ts`
    - Implement `setConsent(sessionId, speakerName, consentConfirmed)` — creates ConsentRecord, enforces IDLE-only
    - Implement `revokeConsent(sessionId)` — purges all session data per privacy policy
    - Enforce immutability: reject consent changes when `session.state !== IDLE`
    - Wire `consent.speakerName` as the source for `speakerName` (backward compat getter)
    - _Requirements: 2.2, 2.4, 2.7, 8.6, 8.7_

  - [ ]* 2.2 Write property test for consent immutability
    - **Property 2: Consent Record Immutability**
    - **Validates: Requirements 2.4**

  - [ ]* 2.3 Write property test for session data purge completeness
    - **Property 4: Session Data Purge Completeness**
    - **Validates: Requirements 2.7, 8.6, 8.7**

- [ ] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement ToneChecker
  - [ ] 4.1 Create `src/tone-checker.ts` with pattern-based detection
    - Implement `ToneChecker` class with `check()`, `stripViolations()`, `stripMarkers()`, `appendScopeAcknowledgment()`
    - Implement prohibited pattern categories: psychological inference (~30 regex patterns), visual scope (~20 patterns), punitive language (~25 patterns), numerical scores (X/10, X%, etc.)
    - Implement marker-based ungrounded claim detection: parse `[[Q:*]]` and `[[M:*]]` markers, classify assertive sentences using verb stem allowlist/denylist, flag unmarked assertive sentences
    - Implement `stripViolations()` operating on marked script, removing offending sentences while preserving order
    - Implement `stripMarkers()` with regex `\s*\[\[(Q|M):[^\]]+\]\]`, preserving single space at sentence boundaries
    - Implement `appendScopeAcknowledgment()` with idempotent append (only when qualityWarning or hasStructureCommentary)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.10_

  - [ ]* 4.2 Write property test for tone checker detection completeness
    - **Property 5: Tone Checker Detection Completeness**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**

  - [ ]* 4.3 Write property test for tone violation stripping correctness
    - **Property 6: Tone Violation Stripping Correctness**
    - **Validates: Requirements 3.8**

  - [ ]* 4.4 Write property test for scope acknowledgment conditional append
    - **Property 7: Scope Acknowledgment Conditional Append**
    - **Validates: Requirements 3.10, 6.7**

  - [ ]* 4.5 Write property test for marker elimination
    - **Property 20: Marker Elimination After Tone Check**
    - **Validates: Requirements 11.2, 11.5**

- [ ] 5. Enhance MetricsExtractor with pause classification, energy variation, and filler classification
  - [ ] 5.1 Add pause classification to `src/metrics-extractor.ts`
    - Extend `detectPauses()` to return `ClassifiedPause[]` with type and reason
    - Implement candidate threshold (300ms) vs reportable threshold (1.5s)
    - Implement classification heuristics: sentence-ending punctuation → intentional, mid-sentence/filler-preceded/repetition → hesitation
    - Implement punctuation fallback heuristic for unreliable punctuation
    - Implement hesitation-wins precedence rule for conflicting signals
    - Compute `intentionalPauseCount` and `hesitationPauseCount`
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 5.2 Write property test for pause classification correctness
    - **Property 9: Pause Classification Correctness**
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [ ] 5.3 Add speech energy variation computation to `src/metrics-extractor.ts`
    - Implement `computeEnergyProfile(audioChunks: Buffer[])` method
    - Segment audio into 250ms windows (4000 samples at 16kHz)
    - Compute RMS per window, normalize by max RMS (gain invariance)
    - Compute adaptive silence threshold: median + k * MAD
    - Exclude silence windows, compute coefficient of variation
    - Store only derived `EnergyProfile`, not raw samples
    - _Requirements: 5.5, 5.6, 5.7, 5.8, 5.11_

  - [ ]* 5.4 Write property test for energy profile computation correctness
    - **Property 10: Energy Profile Computation Correctness**
    - **Validates: Requirements 5.5, 5.7, 5.8**

  - [ ]* 5.5 Write property test for energy gain invariance
    - **Property 11: Energy Gain Invariance**
    - **Validates: Requirements 5.6**

  - [ ] 5.6 Enhance filler word classification in `src/metrics-extractor.ts`
    - Extend filler detection to produce `ClassifiedFillerEntry[]` with `classification` field
    - "um", "uh", "ah" → always `true_filler`; contextual words in filler position → `true_filler`; contextual words in non-filler position → `discourse_marker`
    - Ensure `fillerWordCount` equals sum of `true_filler` counts (backward compat)
    - _Requirements: 5.9_

  - [ ]* 5.7 Write property test for filler word classification consistency
    - **Property 12: Filler Word Classification Consistency**
    - **Validates: Requirements 5.9**

- [ ] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Enhance TTSEngine with structured trimming and configurable time limits
  - [ ] 7.1 Update `src/tts-engine.ts` with safety margin and structured trimming
    - Update `estimateDuration()` to accept and apply `safetyMarginPercent` parameter
    - Update `trimToFit()` with structured awareness: parse script into labeled sections (opening, items, structure commentary, closing)
    - Implement trimming priority: structure commentary → recommendation explanations → extra commendations → extra recommendations
    - Preserve opening + ≥1 commendation + strongest recommendation + closing
    - Implement hard-minimum fallback: cap opening/closing to 1 sentence, shorten explanations to summaries
    - Ensure trimming is purely subtractive (no appending)
    - Use shared `splitSentences()` for sentence boundary detection
    - Update `TTSConfig` default `maxDurationSeconds` to 120
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 7.2 Write property test for duration estimation with safety margin
    - **Property 13: Duration Estimation with Safety Margin**
    - **Validates: Requirements 6.2**

  - [ ]* 7.3 Write property test for structured trimming correctness
    - **Property 14: Structured Trimming Correctness**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

- [ ] 8. Enhance EvaluationGenerator with structure commentary, markers, and pass-rate reporting
  - [ ] 8.1 Update LLM prompt in `src/evaluation-generator.ts` for structure commentary
    - Extend system prompt to request `structure_commentary` in JSON output (opening_comment, body_comment, closing_comment)
    - Add instructions for percentage-based segmentation (10-15% opening, 70-80% body, 10-15% closing)
    - Add heuristic fallback instructions for transcripts <120 words
    - Add instruction to return null for sections with no reliable markers
    - Add explicit "no scores, no ratings" instruction for structure commentary
    - Add quality warning propagation: uncertainty qualifier + high-confidence-only observations (≥0.7 mean word confidence)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 10.1, 10.2, 10.3_

  - [ ] 8.2 Update `renderScript()` in `src/evaluation-generator.ts` with marker emission
    - Emit `[[Q:item-N]]` markers after sentences derived from evidence quotes
    - Emit `[[M:fieldName]]` markers after sentences referencing metrics fields
    - Place markers after terminal punctuation, before following whitespace
    - Integrate structure commentary into rendered script (between opening and first item)
    - Omit structure commentary sections where the field is null
    - _Requirements: 4.3, 3.2, 11.5_

  - [ ]* 8.3 Write property test for null structure commentary omission
    - **Property 8: Null Structure Commentary Omission**
    - **Validates: Requirements 4.3**

  - [ ] 8.4 Add pass-rate reporting and short-form fallback to `src/evaluation-generator.ts`
    - Track first-attempt pass/fail per item during evidence validation
    - Compute pass rate: `passedOnFirstAttempt / totalDeliveredItems`
    - Implement short-form fallback: if shape invariant fails after all retries, produce ≥1 commendation + ≥1 recommendation
    - _Requirements: 1.6, 9.1, 9.2, 9.3_

  - [ ]* 8.5 Write property test for evidence pass rate computation
    - **Property 18: Evidence Pass Rate Computation**
    - **Validates: Requirements 1.6**

  - [ ]* 8.6 Write property test for extended structural shape invariant
    - **Property 1: Extended Structural Shape Invariant**
    - **Validates: Requirements 1.1, 4.9, 5.10**

  - [ ]* 8.7 Write property test for short-form fallback shape and evidence
    - **Property 16: Short-Form Fallback Shape and Evidence**
    - **Validates: Requirements 9.2, 9.3**

- [ ] 9. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement name redaction with public evaluation types
  - [ ] 10.1 Update redaction in `src/evaluation-generator.ts`
    - Implement `redact(input: RedactionInput): RedactionOutput` method
    - Redact third-party private individual names → fixed literal "a fellow member"
    - Preserve speaker's own name (from ConsentRecord)
    - Conservative redaction: do not redact uncertain entities (places, orgs, brands)
    - Produce both `scriptRedacted` and `evaluationPublic` (StructuredEvaluationPublic)
    - Ensure replacement phrase is identical across script and public evidence quotes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 10.2 Write property test for redaction correctness
    - **Property 15: Redaction Correctness**
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5**

  - [ ]* 10.3 Write property test for public output redaction completeness
    - **Property 21: Public Output Redaction Completeness**
    - **Validates: Requirements 8.1, 8.4, 8.5**

- [ ] 11. Wire the full Phase 2 pipeline in SessionManager
  - [ ] 11.1 Update `generateEvaluation()` in `src/session-manager.ts` to orchestrate the Phase 2 pipeline
    - Wire stages in order: LLM generation → evidence validation + retry → shape check / fallback → script rendering (with markers) → tone check + fix → strip markers → timing trim → scope ack check → redaction → TTS synthesis
    - Pass audio chunks to MetricsExtractor for energy computation
    - Store pass rate on session (`evaluationPassRate`)
    - Send `StructuredEvaluationPublic` (not internal) in `evaluation_ready` message
    - Enforce runId checks at every async boundary
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ] 11.2 Add consent WebSocket handlers to `src/server.ts`
    - Handle `set_consent` message: call `sessionManager.setConsent()`, send `consent_status` response
    - Handle `revoke_consent` message: call `sessionManager.revokeConsent()`, send `data_purged` response
    - Handle `set_time_limit` message: update `session.timeLimitSeconds`, send `duration_estimate` response
    - Gate `start_recording` on consent confirmation
    - _Requirements: 2.1, 2.3, 2.7, 6.8_

  - [ ] 11.3 Update `saveOutputs()` in `src/session-manager.ts` and `src/file-persistence.ts`
    - Include ConsentRecord in saved metadata
    - Save redacted evaluation (StructuredEvaluationPublic), not internal
    - _Requirements: 2.6, 8.4_

  - [ ]* 11.4 Write property test for consent round-trip in saved outputs
    - **Property 3: Consent Round-Trip in Saved Outputs**
    - **Validates: Requirements 2.6**

- [ ] 12. Update Web UI for consent, time limit, and duration display
  - [ ] 12.1 Update `public/index.html` with consent form and time limit controls
    - Add speaker name input field and consent confirmation checkbox in IDLE state
    - Disable "Start Speech" button until consent is confirmed
    - Display consent status (speaker name + confirmed) in session info area
    - Add time limit configuration control (number input, default 120s)
    - Display estimated evaluation duration and configured time limit before "Deliver Evaluation"
    - Handle `consent_status`, `duration_estimate`, and `data_purged` WebSocket messages
    - Add "Revoke Consent" button with confirmation dialog
    - Disable "Save Outputs" after opt-out purge
    - _Requirements: 2.1, 2.3, 2.5, 6.7, 6.8_

- [ ] 13. Implement quality warning propagation and consistency monitoring
  - [ ] 13.1 Update quality warning logic in `src/session-manager.ts` and `src/evaluation-generator.ts`
    - Update quality assessment to exclude silence/non-speech markers from confidence computation
    - Ensure quality warning triggers at <10 WPM or avg confidence <0.5
    - Pass quality warning to LLM prompt for uncertainty qualifier and reduced claim strength
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ]* 13.2 Write property test for quality warning threshold correctness
    - **Property 17: Quality Warning Threshold Correctness**
    - **Validates: Requirements 10.1**

  - [ ] 13.3 Add consistency monitoring telemetry (background, non-blocking)
    - Implement cosine similarity computation for summary embeddings
    - Log similarity scores asynchronously after evaluation delivery
    - Use fixed embedding model specified as configured constant
    - _Requirements: 7.1, 7.3, 7.4, 7.5_

  - [ ]* 13.4 Write property test for cosine similarity computation
    - **Property 19: Cosine Similarity Computation Correctness**
    - **Validates: Requirements 7.3**

- [ ] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1-21)
- Unit tests validate specific examples and edge cases
- The existing Phase 1 test suite must continue to pass throughout — backward compatibility is required
- All pipeline stages use the shared `splitSentences()` utility for consistent sentence segmentation
