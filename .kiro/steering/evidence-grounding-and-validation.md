# Evidence Grounding and Validation

This document defines the contract that all LLM-generated evaluation content must satisfy. "Evidence-based only" is the product's core invariant. Every commendation and recommendation must be traceable to the speaker's actual words.

## Evidence Contract

Every `EvaluationItem` must include:
- `evidence_quote`: A verbatim snippet from the final transcript, at most 15 words.
- `evidence_timestamp`: The start time (seconds since speech start) of the first word in the quoted passage.

## Transcript Normalization

Before matching, both the evidence quote and transcript text are normalized:
1. Lowercase all characters.
2. Strip all punctuation (keep only alphanumeric and whitespace).
3. Collapse consecutive whitespace to a single space.
4. Trim leading/trailing whitespace.

A "token" is a contiguous sequence of non-whitespace characters after normalization.

## Validation Algorithm

For each `evidence_quote` in a `StructuredEvaluation`:

1. Normalize the quote and the full transcript text.
2. Tokenize both into arrays of tokens.
3. Check contiguous match: the quote's tokens must appear as a contiguous subsequence in the transcript's tokens, with at least 6 consecutive matching tokens.
4. Check timestamp locality:
   - If word-level timestamps are available: `abs(evidence_timestamp - start_time_of_first_matched_word) <= 20` seconds.
   - If only segment-level timestamps are available: the matched tokens must appear within a segment whose time range overlaps with `[evidence_timestamp - 20, evidence_timestamp + 20]`.
5. Check length: the quote must contain at most 15 tokens.

An item passes validation only if all three checks succeed.

## Failure Modes and Retry Budget

- If an item fails validation: re-prompt the LLM for that specific item (max 1 retry per item).
- If the retry also fails: drop the item from the evaluation.
- If dropping items would leave fewer than 2 commendations or fewer than 1 recommendation: regenerate the full evaluation (max 2 total generation attempts).
- After exhausting retries: proceed with a best-effort result and log a warning.

## Segment-Level Fallback

When the post-speech transcription returns only segment-level timestamps (no word-level):
- Timestamp locality operates at segment resolution: the matched tokens must appear within a segment whose `[startTime, endTime]` overlaps with `[evidence_timestamp - 20, evidence_timestamp + 20]`.
- WPM and duration still computed from segment boundaries.
- A note is added to metrics indicating reduced timing precision.

## Redaction Interaction

- Evidence validation runs against the raw (unredacted) transcript.
- After validation passes, the rendered script for TTS delivery applies name redaction.
- This ordering is critical: validate first, redact second. Never validate against redacted text.

## Implementation Checkpoints

When modifying these components, verify compliance with this document:
- `EvaluationGenerator.generate()` — structured output must include evidence fields
- `EvaluationGenerator.validate()` — must implement the exact algorithm above
- `EvaluationGenerator.renderScript()` — must apply redaction after validation
- Evidence-related property tests (Property 7, Property 8)
- Retry and regeneration logic
