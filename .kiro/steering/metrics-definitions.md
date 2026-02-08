---
inclusion: fileMatch
fileMatchPattern: "{**/metrics-extractor*,**/metrics*}"
---

# Metrics Definitions

This document provides the single source of truth for how delivery metrics are computed. Deterministic metrics are easy to implement inconsistently. These definitions are final.

## Duration

- Definition: `lastSegment.endTime - firstSegment.startTime` (in seconds).
- Uses segment-level boundaries, not word-level.
- For an empty transcript (no segments): duration is 0.
- Formatted as `M:SS` (e.g., "5:30" for 330 seconds).

## Words Per Minute (WPM)

- Definition: `totalWords / (durationSeconds / 60)`.
- `totalWords` is the count of all whitespace-separated tokens across all segment `text` fields, after trimming.
- If duration is 0 (empty transcript): WPM is 0.
- No rounding — store as a floating-point number. Round only for display.

## Filler Word Detection

### Known Filler List
Base set: "um", "uh", "ah", "like", "you know", "so", "basically", "right", "actually", "literally".

### Contextual Heuristics
Words from the known list are only counted as fillers when they appear in filler-like positions:

- "um", "uh", "ah": Always counted as fillers (no contextual override).
- "like": Counted as filler only when it appears mid-sentence and is NOT preceded by a verb or followed by a noun/adjective that it modifies. Simple heuristic: if the previous word is a pronoun, article, or another filler, count it. If the previous word is a verb (common verbs: "is", "was", "feel", "look", "sound", "seem", "taste", "smell"), do not count it.
- "so": Counted as filler only when it appears at the start of a sentence or after a pause. When used as a conjunction mid-sentence ("so that", "so much"), do not count it.
- "you know": Always counted as filler when appearing as a bigram.
- "basically", "right", "actually", "literally": Counted as filler when appearing mid-sentence as discourse markers. Not counted when they are the semantic core of the clause (e.g., "that's basically correct" — still count; "turn right at the corner" — do not count, but this is unlikely in a speech context).

### Filler Metrics
- `fillerWordCount`: Sum of all individual `FillerWordEntry.count` values.
- `fillerWordFrequency`: `fillerWordCount / (durationSeconds / 60)` (fillers per minute).
- Each `FillerWordEntry` tracks the word, its count, and timestamps of each occurrence.

## Pause Detection

- A pause is a gap between consecutive words (or segments, in fallback mode) exceeding the configured threshold.
- Default threshold: 1.5 seconds.
- Word-level detection: gap between `word[i].endTime` and `word[i+1].startTime` within the same segment, and between `lastWordOfSegment[i].endTime` and `firstWordOfSegment[i+1].startTime` across segments.
- Segment-level fallback: when word-level timestamps are unavailable, use `segment[i].endTime` to `segment[i+1].startTime`.
- `pauseCount`: Number of detected pauses.
- `totalPauseDurationSeconds`: Sum of all pause durations.
- `averagePauseDurationSeconds`: `totalPauseDurationSeconds / pauseCount` (0 if no pauses).

## Quality Warning Thresholds

- Flag `qualityWarning` if total word count < 10 words per minute of recording duration.
- Flag `qualityWarning` if average word confidence score < 0.5.
- These flags are additive (either condition triggers the warning).

## Implementation Checkpoints

When modifying the MetricsExtractor, verify:
- Duration uses segment boundaries (first start to last end)
- WPM handles zero-duration edge case
- Filler detection applies contextual heuristics, not just list matching
- Pause detection works at both word-level and segment-level
- All property tests (Properties 2-5) still pass
