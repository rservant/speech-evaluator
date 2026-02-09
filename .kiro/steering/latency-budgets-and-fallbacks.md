---
inclusion: manual
---

# Latency Budgets and Fallbacks

This document defines the timing budgets for each pipeline stage and the fallback ladder when stages exceed their budgets. Pull this into context with `#latency-budgets-and-fallbacks` when working on integration wiring, orchestration, or performance.

## Pipeline Stages and Timing Anchors

| Stage | Starts At | Ends At | Budget (p50) | Budget (p90) | Hard Max |
|---|---|---|---|---|---|
| Post-speech transcription | Operator clicks "Stop Speech" | Final transcript ready | 5s | 15s | 30s |
| Metrics extraction | Final transcript ready | Metrics computed | <100ms | <200ms | 500ms |
| Evaluation generation | Metrics ready | Structured evaluation validated | 8s | 20s | 45s |
| TTS synthesis | Evaluation script ready | First audio chunk sent to client | 3s | 8s | 15s |
| Total (Stop → first audio) | Operator clicks "Stop Speech" | First TTS audio chunk plays | 16s | 43s | 90s |

## Fallback Ladder

When the evaluation generation stage exceeds its budget:

### Tier 1: Full Evaluation (default)
- Full structured evaluation with commendations, recommendations, evidence quotes.
- Target: completes within 45s of metrics ready.

### Tier 2: Short Evaluation (45s timeout)
- If Tier 1 exceeds 45s: cancel and re-prompt with a simplified prompt requesting fewer items (1 commendation, 1 recommendation) and shorter explanations.
- Target: completes within 30s of re-prompt.

### Tier 3: Metrics-Only Summary (90s total timeout)
- If Tier 2 also fails or total time from "Stop Speech" exceeds 90s: skip LLM entirely.
- Generate a scripted summary from metrics alone: duration, WPM, filler word highlights, pause observations.
- This is deterministic and instant.

## Progress UI Messaging

| Time Elapsed | UI Message |
|---|---|
| 0-5s after Stop | "Finalizing transcript..." |
| 5-15s | "Analyzing your speech..." |
| 15-30s | "Generating evaluation..." |
| 30-45s | "Taking a bit longer than usual..." |
| 45-60s | "Simplifying evaluation..." (Tier 2 triggered) |
| 60-90s | "Almost there..." |
| >90s | "Preparing summary from metrics..." (Tier 3 triggered) |

## Cancellation Rules

- Panic mute cancels all in-flight operations (transcription, LLM, TTS) via runId check.
- Fallback tier transitions cancel the previous tier's request.
- Completed data from earlier stages is preserved (e.g., if transcription succeeded but LLM timed out, the transcript is still available).

## Implementation Checkpoints

When working on orchestration or integration:
- Session manager pipeline wiring (Task 12.1)
- Timeout and AbortController logic
- UI progress state management
- Fallback tier selection logic
