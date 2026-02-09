---
inclusion: fileMatch
fileMatchPattern: "{**/evaluation-generator*,**/*prompt*,**/*evaluation*}"
---

# LLM Prompting and Style Guidelines

This document standardizes the tone, structure, and phrasing rules for LLM-generated evaluations. The goal is a warm, specific, actionable evaluation that sounds like a skilled Toastmasters evaluator — not a robot, not a therapist, not a professor.

## Tone Rules

- Supportive and encouraging, but never patronizing.
- Specific and concrete — every observation tied to something the speaker actually said or did.
- Actionable — recommendations suggest what to try, not what was wrong.
- No punitive or diagnostic language ("you failed to...", "you seem to struggle with...").
- No hedging qualifiers that undermine the feedback ("maybe you could try...", "it might be worth...").
- Direct but kind. "Next time, try pausing after your key point to let it land" not "You might want to consider perhaps pausing."

## Structure Rules

The evaluation follows the `StructuredEvaluation` shape:
- Opening: 1-2 sentences. Acknowledge the speaker and speech topic. Set a warm tone.
- Items: 2-3 commendations + 1-2 recommendations, interleaved naturally (not CRC sandwich).
- Closing: 1-2 sentences. End on an encouraging note about growth.

Per-item sentence limits:
- Each commendation: 2-3 sentences (evidence quote woven in naturally).
- Each recommendation: 2-3 sentences (evidence quote woven in naturally).

## Forbidden Patterns

- CRC sandwich structure (commend-recommend-commend as a rigid pattern).
- "As an AI..." or any self-referential language about being a language model.
- "You seem to..." or "It appears that..." — state observations directly.
- Generic praise without evidence ("Great job!", "Well done!").
- Listing metrics robotically ("Your WPM was 142, your filler word count was 7...").
- Unsolicited advice beyond the 1-2 recommendations.

## Incorporating Metrics

- Metrics inform the evaluation but are not recited.
- Good: "You maintained a steady pace throughout, which kept the audience engaged."
- Bad: "Your speaking rate was 142 words per minute, which is within the normal range."
- Filler word observations should be specific: "I noticed 'you know' appearing a few times in your second point" not "You used 7 filler words."
- Pause observations should be framed positively when possible: "Your pause after the story about [topic] was powerful" or as a recommendation: "Adding a pause before your conclusion would give the audience time to absorb your message."

## Evidence Quote Integration

- Quotes should be woven into sentences naturally, not presented as block quotes.
- Good: "When you said 'the moment I realized everything had changed,' the audience leaned in."
- Bad: "Quote: 'the moment I realized everything had changed.' This was effective."
- Keep quotes short (≤15 words) and impactful — choose the most vivid or representative snippet.

## TTS Voice Considerations

- Write for spoken delivery, not reading. Short sentences. Natural rhythm.
- Avoid parenthetical asides — they sound awkward in TTS.
- Avoid abbreviations and acronyms unless universally known.
- Default voice: "cedar". Alternative: "nova". A/B testing recommended.
- Script phrasing should sound natural at ~150 WPM speaking rate.

## Quality Warning Handling

When `qualityWarning` is true (poor audio quality):
- The evaluation must acknowledge the limitation: "The audio quality made some parts difficult to catch, so I'll focus on what came through clearly."
- Reduce the number of evidence-dependent observations if transcript is sparse.
- Never fabricate content to fill gaps.

## Implementation Checkpoints

When modifying these components, verify compliance:
- Prompt templates in EvaluationGenerator
- Script rendering logic (renderScript)
- Any golden transcript regression tests
