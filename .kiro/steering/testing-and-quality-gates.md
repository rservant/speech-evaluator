---
inclusion: manual
---

# Testing and Quality Gates

This document ties PRD exit criteria to automated checks and defines the quality gates for each phase. Pull this into context with `#testing-and-quality-gates` when working on CI setup, test infrastructure, or release readiness.

## Required Property Tests

| Property | Component | Min Iterations | Validates |
|---|---|---|---|
| 1: Transcript Structural Invariant | Transcription output | 100 | Req 2.2 |
| 2: Duration Computation Correctness | MetricsExtractor | 100 | Req 3.1 |
| 3: WPM Computation Correctness | MetricsExtractor | 100 | Req 3.2 |
| 4: Filler Word Metrics Internal Consistency | MetricsExtractor | 100 | Req 3.3 |
| 5: Pause Detection Correctness | MetricsExtractor | 100 | Req 3.4 |
| 6: Evaluation Script Duration Compliance | TTSEngine + EvalGenerator | 100 | Req 4.5 |
| 7: Evidence Quote Validation | EvaluationGenerator.validate() | 100 | Req 4.3, 4.6 |
| 8: Structured Evaluation Shape Invariant | EvaluationGenerator | 100 | Req 4.1, 4.2 |
| 9: Audio Capture Inactive During Delivery | Audio capture state | 100 | Req 5.3 |
| 10: Session Output File Round-Trip | FilePersistence | 100 | Req 6.1-6.3 |
| 11: Output Directory Naming Convention | FilePersistence | 100 | Req 6.4 |

All property tests use fast-check with Vitest as the runner. Tag format: `Feature: ai-toastmasters-evaluator, Property {N}: {title}`.

## Golden Test Corpus

Maintain a set of sanitized test transcripts covering:
- Normal speech (5-7 minutes, clear audio)
- Short speech (1-2 minutes)
- Long speech (20+ minutes)
- Speech with many filler words
- Speech with long pauses
- Speech mentioning third-party names (for redaction testing)
- Poor audio quality simulation (low confidence scores, missing words)
- Edge case: single-word transcript
- Edge case: empty transcript

Golden transcripts must not contain real PII. Use synthetic names and content.

## Phase 1 Exit Criteria Mapping

| Exit Criterion | Automated Check |
|---|---|
| All property tests pass | `npm test` in CI — all 11 properties green |
| Evidence grounding rate ≥ 90% | Property 7 pass rate across golden corpus |
| Evaluation shape invariant holds | Property 8 — zero failures in 100+ iterations |
| TTS duration within bounds | Property 6 — all generated scripts fit 90-210s |
| File round-trip integrity | Property 10 — save/load produces equivalent data |
| No ungrounded claims | Property 7 + manual spot check on 5 real speeches |

## Manual QA Checklist (Pre-Release)

- [ ] Run system with a real microphone in a quiet room — full lifecycle works
- [ ] Run system with background noise — quality warning triggers appropriately
- [ ] Panic mute from each state — UI resets correctly, no audio leaks
- [ ] Speaker opt-out — all data purged, Save Outputs disabled
- [ ] TTS failure simulation — written evaluation displayed as fallback
- [ ] 25-minute speech — auto-stop triggers with notification
- [ ] Save Outputs — files created with correct format and naming
- [ ] Multiple consecutive sessions — no state leakage between sessions

## No Ungrounded Claims Enforcement

- Automated: Property 7 validates every evidence quote against transcript.
- Automated: Property 8 validates evaluation shape (commendation/recommendation counts).
- Manual: Spot-check 5 evaluations from real speeches for tone, accuracy, and naturalness.
- CI gate: All property tests must pass before merge.

## Implementation Checkpoints

When working on CI or test infrastructure:
- Vitest configuration and test discovery
- fast-check iteration counts (minimum 100)
- Golden corpus file management
- CI pipeline definition
- Release readiness checklist automation
