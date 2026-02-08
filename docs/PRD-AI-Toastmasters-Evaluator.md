# AI Toastmasters Evaluator — Product Requirements Document

## Vision

Build a multimodal conversational AI that listens to live speeches at Toastmasters meetings, generates evidence-based evaluations grounded in what was actually said, and delivers them aloud — evolving from a manually-controlled audio tool into a fully autonomous, multi-modal speech coaching platform.

## Core Principles

- **Supportive, specific, actionable**: Feedback follows Toastmasters culture — encouraging growth, never punitive
- **Evidence-based only**: Every observation must be grounded in the transcript or observable behavior. No ungrounded claims in delivered evaluations; all items must be evidence-validated
- **Respect Toastmasters structure and timing**: Evaluations fit naturally into meeting flow and time constraints
- **Human-controlled until automation is reliable**: Manual triggers first, automation earned through proven reliability at each phase gate
- **Privacy-first**: Consent confirmed before every recording, minimal data retention, opt-in persistence
- **Supplement, not replacement**: The AI evaluator augments human evaluators — it never replaces them

## Stakeholders

| Role | Description |
|------|-------------|
| Operator | Person controlling the system during a meeting via the web UI |
| Speaker | Club member delivering a speech being evaluated |
| Club Officers | Meeting organizers who schedule and coordinate AI evaluator use |
| Developer | Engineers building and maintaining the system |

---

## Safety and Content Boundaries

These boundaries apply across all phases and are non-negotiable:

- No medical or legal advice
- No sensitive trait inference (health, religion, sexuality, disability, etc.)
- No identifying third parties mentioned in the room. If a third party's name is spoken during the speech, the evaluation must not repeat it — replace with "someone" or "a person" unless referring to the Speaker or Toastmaster roles. Avoid repeating sensitive anecdotes verbatim beyond the ≤15-word evidence quotes
- No "You seem anxious/depressed/nervous" language — never infer psychological or emotional state
- No personal judgments about the speaker as a person (only about the speech)
- Observational language only for all visual signals (Phase 4+): "I observed..." not "You felt..."
- No ungrounded claims: every evaluation item must cite specific evidence from the transcript or observed behavior
- Evidence quote redaction: if an evidence quote contains a third-party name, it must be redacted to "[someone]" in the delivered evaluation and saved outputs. Evidence validation runs against the unredacted transcript; redaction is applied only at the rendering/delivery stage

---

## Adoption and Positioning

### Positioning
The AI evaluator is a **supplement to human evaluators**, not a replacement. Recommended use cases:
- Demo night: showcase the AI as a club innovation
- Evaluator training: compare AI evaluation with human evaluations to help new evaluators learn
- Contested evaluation comparison: use AI as a neutral third perspective
- Backup evaluator: fill in when a human evaluator is absent

### Operator Script (30 seconds)
> "Tonight we're trying something new. Our AI evaluator will listen to [Speaker]'s speech and deliver a spoken evaluation afterward. [Speaker], are you comfortable with that? The AI only listens to audio — no video — and nothing is saved unless you ask. You can opt out at any time."

### Speaker Opt-Out
- Any speaker can decline AI evaluation before their speech — no questions asked
- If a speaker opts out mid-speech, the Operator clicks the dedicated "Speaker Opt-Out" button (distinct from Panic Mute) — all audio chunks, transcripts, and session data are **immediately and irrecoverably purged** from memory. No evaluation is generated. No data can be saved
- Opt-out is the default; the Operator must confirm consent before starting

### Panic Mute vs. Opt-Out (Critical Distinction)
These are two different actions with different data handling:

| Action | Trigger | Audio Chunks | Transcript | Can Resume/Evaluate? |
|--------|---------|-------------|------------|---------------------|
| Panic Mute | Echo/safety emergency | Preserved in memory | Preserved | Yes — Operator can attempt evaluation from captured data |
| Speaker Opt-Out | Speaker withdraws consent | Purged immediately | Purged immediately | No — session is irrecoverably discarded |

The UI must make these visually distinct (e.g., Panic Mute = red, Opt-Out = separate button with confirmation dialog)

---

## Cost and Rate Limiting

### Per-Session Cost Awareness
- The system shall track and display estimated API cost per session (transcription + LLM + TTS)
- Configurable maximum speech length (default: 25 minutes, enforced by Session Manager)
- Cost estimate displayed to Operator before "Deliver Evaluation" step

### Rate Limiting
- Configurable daily/weekly session limits per deployment
- API retry budgets: max 2 full evaluation regenerations, max 1 retry per evidence item
- Practice mode (Phase 8) priced separately with its own rate limits

---

## Language Scope

- **Phase 1–3**: English only. Transcription, evaluation, and TTS are all English
- **Phase 4–8**: English only unless explicitly scoped otherwise
- **Phase 9**: Multilingual support is a future direction (evaluation in French, Spanish, etc.) but is not committed until Phase 9 scoping

This is stated explicitly to avoid stakeholder confusion in bilingual club environments

---

## Demo Mode (Optional, Recommended for First Use)

A single configuration toggle that optimizes for first-time use and privacy-sensitive environments:

| Setting | Demo Mode ON | Demo Mode OFF (default) |
|---------|-------------|------------------------|
| Saving | Disabled entirely — "Save Outputs" button hidden | Enabled (opt-in) |
| Evaluation mode | Short evaluation (1+1) by default | Full evaluation by default |
| Privacy banner | Persistent "No data is stored" banner displayed | No banner |
| Auto-purge | Immediate on return to IDLE (no 10-minute window) | 10-minute window |

Demo mode reduces operator anxiety during first use and provides a clear privacy posture for skeptical club members. It can be toggled in the settings UI or via a configuration flag

---

## Data Retention Defaults

Session data lifecycle (applies from Phase 1):

| Data | During Session | After Session (IDLE) | After Auto-Purge (10 min) | After "Save Outputs" |
|------|---------------|---------------------|--------------------------|---------------------|
| Audio chunks (in-memory) | Held | Held | **Purged** | Not saved (never persisted to disk) |
| Live transcript (in-memory) | Held | Held | **Purged** | Not saved |
| Final transcript (in-memory) | Held | Held | **Purged** | Saved to `transcript.txt` |
| Metrics (in-memory) | Held | Held | **Purged** | Saved to `metrics.json` |
| Evaluation (in-memory) | Held | Held | **Purged** | Saved to `evaluation.txt` |

- By default, all session data is held in memory only
- Auto-purge countdown (10 minutes) starts when the session transitions to IDLE
- Countdown resets on any active operator action (view transcript, deliver evaluation, save outputs) — passive UI refresh does not reset it
- Closing the browser tab or restarting the server purges all in-memory data immediately
- Starting a new session purges the previous session's in-memory data
- If "Save Outputs" is clicked, only the defined output files are persisted
- Audio is never written to disk by the application. Audio is transmitted only to configured transcription providers (Deepgram, OpenAI) for processing. Provider-side retention will be configured to the minimum available setting; actual retention is subject to provider capabilities and terms
- On Speaker Opt-Out, all data is purged immediately (no 10-minute window)

---

## Phase 1 — MVP (Real Meeting Demo)

### Goal

Deliver a working AI spoken evaluator in a real in-person Toastmasters meeting using audio-only input and manual control.

### Status
**Detailed spec complete** → `.kiro/specs/ai-toastmasters-evaluator/`

### Capabilities

- Record speech audio via USB or boundary microphone
- Live captions during speech (best-effort, for UI display only)
- Final timestamped transcript after speech (canonical, used for metrics and evaluation)
- Deterministic delivery metrics (WPM, filler words, duration, pauses)
- LLM-generated evaluation: 2-3 commendations, 1-2 recommendations, all evidence-grounded
- Spoken evaluation via TTS (warm, conversational voice)
- Opt-in file persistence (transcript, metrics, evaluation)
- Operator confirms consent was obtained (checkbox before Start Speech)

### Functional Requirements

#### Consent (Phase 1)
- Before "Start Speech" is enabled, the Operator must check a "Speaker consent confirmed" checkbox
- The UI displays a short consent reminder script
- No audio or data is captured until consent is confirmed
- No consent data is stored — this is an operator attestation only

#### Meeting Controls (Manual)
- Web-based UI with discrete steps: Start Speech → Stop Speech → Deliver Evaluation → Save Outputs
- Live elapsed-time indicator during recording
- "Panic Mute" button available at all times
- "Speaking..." indicator during TTS delivery

#### Processing Progress UX
- After "Stop Speech", display staged progress: "Transcribing → Analyzing → Drafting evaluation → Ready"
- If processing exceeds 30 seconds, show "Taking longer than expected..." with option to cancel
- If evaluation cannot be generated, fall back to displaying transcript + metrics only

#### Short-Form Fallback Mode
When latency threatens meeting flow, the system degrades gracefully through three tiers. All time thresholds are measured from the moment the Operator clicks "Stop Speech."

| Tier | Trigger | Output |
|------|---------|--------|
| Full evaluation | Total processing completes within 45s of Stop Speech | 2-3 commendations + 1-2 recommendations, spoken via TTS |
| Short evaluation | 45s elapsed since Stop Speech and LLM has not returned | 1 commendation + 1 recommendation (both evidence-validated), target ≤ 60s spoken. Uses final transcript if available; otherwise best available partial transcript |
| Metrics-only | 90s elapsed since Stop Speech, or LLM fails | Transcript + delivery metrics + 2 longest high-confidence transcript excerpts (selected by segment length × average word confidence, no LLM), displayed as text for Operator to read aloud |

The Operator can also manually select short evaluation mode before clicking "Deliver Evaluation"

If the final transcript is not ready by 45s, the short evaluation tier uses the best available transcript (final preferred; partial Deepgram segments as fallback, clearly labelled). The metrics-only tier requires at least a partial transcript to produce excerpts

#### Audio Health Monitoring
- Live input level meter displayed in the UI during recording (simple RMS bar)
- Automatic detection and warning for (all measured over a rolling 10-second window):
  - Sustained near-zero amplitude (RMS below threshold for ≥ 5s) → "Microphone may be muted or unplugged"
  - Sustained clipping (samples at max amplitude for ≥ 3s) → "Input level too high — move mic further from speaker"
  - Low effective speech ratio (speech energy vs. background noise, measured over last 10s) → "Room noise may affect transcript quality"
- Warnings are non-blocking — recording continues, but the Operator is informed

#### Transcription
- Two-pass approach: live captions during recording (Deepgram), high-accuracy final transcript after recording (OpenAI gpt-4o-transcribe)
- Live captions are best-effort for UI display — not used for evaluation
- Final transcript is canonical — used for metrics, evidence validation, and evaluation
- Word-level or segment-level timestamps
- Support speeches from 1 minute to 25 minutes

#### Delivery Metrics (Deterministic)
- Words per minute (WPM)
- Filler word detection — dynamic/contextual, not just a fixed list
- Speech duration
- Pause count and total pause duration

#### Evaluation Output
- Free-form natural conversational style (explicitly not CRC sandwich)
- 2-3 commendations, 1-2 recommendations
- All feedback grounded in specific evidence (quotes ≤15 words or cited behavior)
- Spoken duration: 90 seconds to 3 minutes 30 seconds
- Structured JSON intermediate format with evidence validation before rendering

#### Error Handling
- Poor audio quality → best-effort evaluation with explicit caveats
- Mic detection failure → clear error, Start Speech disabled
- Transcription error → quality warning, fallback to available segments
- TTS failure → display written evaluation as fallback for Operator to read aloud

### Non-Goals (Phase 1)
- No speaker diarization
- No automatic start/stop detection
- No video input
- No personalization or project-specific objectives
- No cloud dashboard or user accounts
- No persistent speaker profiles
- No scores or ratings — descriptive feedback only

### Hardware
- Internet-connected laptop
- USB or boundary microphone
- Separate speaker (echo prevention via mic hard-stop, not DSP)

### Exit Criteria

| Metric | Target | Definition |
|--------|--------|------------|
| End-to-end latency p50 (Stop Speech → TTS starts) | ≤ 20 seconds | "TTS starts" = first audio chunk delivered to browser WebSocket |
| End-to-end latency p90 | ≤ 30 seconds | Same measurement point |
| End-to-end latency max | ≤ 45 seconds | Beyond 45s, short-form fallback activates automatically |
| Evidence validity rate | 100% of delivered items pass evidence validation | Contiguous token match + timestamp locality |
| Operator steps for full session | ≤ 4 primary clicks (consent + Start + Stop + Deliver) | Excludes optional Save Outputs |
| TTS duration compliance | 100% of evaluations under 3m30s actual audio duration | Measured as elapsed time from first TTS audio chunk delivered to client to `tts_complete` event (or by counting PCM samples if audio is buffered before playback) |
| Evaluation shape compliance | 100% contain 2-3 commendations + 1-2 recommendations | After evidence validation and retries |
| Unrecoverable meeting disruption incidents | 0 | Panic mute or graceful degradation handles all failures without stopping meeting flow |
| Successful real meeting demo | ≥ 1 complete evaluation delivered in a live club meeting | Full pipeline: record → transcribe → evaluate → speak |

---

## Phase 2 — Stability & Credibility

### Goal

Make the AI evaluator consistent, evidence-grounded, and safe for regular meeting use. Phase 2 is about **meeting evaluator credibility** — human-like structure commentary, stable tone, minimal ungrounded content. No scores; descriptive feedback only.

### Capabilities

#### Evidence Anchoring
- Every commendation and recommendation must cite specific transcript evidence with timestamp references
- Evidence quotes validated against transcript before delivery (contiguous token matching + timestamp locality)
- Reject or regenerate items that fail evidence validation

#### Consent (Phase 2)
- Built-in consent capture: speaker name + verbal consent logged in session metadata
- Consent log stored locally (no audio stored without explicit opt-in)
- Consent status visible in session UI

#### Tone Guardrails
- No invented content or fabricated observations
- No personal judgments or psychological inferences
- Scope awareness: explicitly acknowledge audio-only limitations
- Language review: ensure supportive, growth-oriented phrasing
- Automated tone policy checks against prohibited content patterns

#### Speech Structure Awareness
- Detect and comment on opening effectiveness (hook, attention-grabber)
- Assess body organization and clarity
- Evaluate closing strength (call to action, memorable ending)
- Assess overall message clarity and coherence
- All structure commentary is descriptive, not scored

#### Delivery Metrics Improvements
- Improved pause analysis: distinguish intentional dramatic pauses from hesitation pauses
- Speech energy variation: RMS-based proxy for vocal variety (loud/soft, fast/slow)
- Filler word classification: distinguish true fillers from discourse markers used intentionally

#### Meeting Timing
- Hard time limit on evaluation delivery (configurable, default 2 minutes)
- Safe stop if time exceeded — trim at sentence boundary, deliver closing
- Pre-TTS duration estimation and text trimming

### Non-Goals (Phase 2)
- No video input
- No autonomous speech detection
- No scores, ratings, or numerical assessments — descriptive feedback only
- No longitudinal tracking or speaker profiles
- No practice mode

### Exit Criteria

| Metric | Target |
|--------|--------|
| Tone policy compliance | 0 prohibited content instances across ≥ 20 consecutive test runs |
| Evaluation consistency | Same transcript → stable structure (2-3 / 1-2) across 10 runs; ≥ 70% thematic overlap in item summaries (at least 2 of 3 commendations address the same themes). Thematic overlap measured by: normalized token overlap between item `summary` fields across runs (Phase 2 gate), upgradeable to embedding cosine similarity ≥ 0.7 when available. Manual review is an acceptable alternative gate method |
| Evidence quote specificity | ≤15-word quote + timestamp; ≥ 95% match on first LLM attempt |
| Ungrounded claims in delivered evaluation | 0 across ≥ 20 consecutive sessions |
| Structure commentary coverage | Opening, body, and closing addressed in ≥ 90% of evaluations |
| Meeting timing compliance | 100% of evaluations within configured time limit |

---

## Phase 3 — Semi-Automation (Still Human Controlled)

### Goal

Reduce manual operator workload while preserving reliability and human oversight.

### Capabilities

#### Speech End Detection
- Voice Activity Detection (VAD) to detect when the speaker has likely finished
- UI notification: "Speech likely ended — confirm stop?"
- Human confirmation still required before stopping recording
- Configurable silence threshold (default: 5 seconds of silence after speech activity)

#### Project Awareness
- Operator can input before the speech:
  - Speech title
  - Toastmasters project type (e.g., Ice Breaker, Vocal Variety, Persuasive Speaking)
  - Project-specific objectives
- AI tailors evaluation to project objectives
- Evaluation references project goals alongside general feedback

#### Evidence Highlight UI (Optional)
- Clickable transcript with timestamp navigation
- Highlighted evidence quotes linked to evaluation items
- Metrics summary dashboard

### Non-Goals (Phase 3)
- No video input
- No autonomous participation (AI does not speak unless triggered)
- No speaker diarization
- No scores or longitudinal tracking

### Exit Criteria

| Metric | Target |
|--------|--------|
| VAD suggestion accuracy | "Speech ended" prompt within 10 seconds of true end |
| VAD false positive rate | < 5% (false "speech ended" during active speech) |
| Project-aware evaluation relevance | Project objectives referenced in ≥ 80% of evaluations when provided |
| Operator actions per session | Reduced by ≥ 1 step compared to Phase 2 |

---

## Phase 4 — Multimodal (Video / Delivery Coaching)

### Goal

Add visual observation of speaker delivery for richer, more human-like evaluations.

### Capabilities

#### Video Capture
- Camera input (webcam or external camera)
- Video processing pipeline parallel to audio pipeline
- Frame sampling for efficiency (not continuous video analysis)
- Explicit speaker consent for video capture (separate from audio consent)

#### Video-Based Signals
- Eye-line / face orientation as eye contact proxy
- Gesture frequency and variety
- Body movement stability vs. pacing/swaying
- Stage presence and movement patterns
- Facial expression energy (not emotion inference)

#### Usage Rules (Critical)
- All visual observations are **observational, not judgmental**
- Never infer psychology, emotion, or intent from visual signals
- Always qualify with "I observed..." language
- Visual feedback is supplementary to audio-based evaluation, never primary

#### Evaluation Additions
- Non-verbal communication feedback section
- Gesture effectiveness observations
- Visual engagement assessment
- Stage presence commentary

### Non-Goals (Phase 4)
- No emotion detection or sentiment analysis from video
- No speaker identification from video
- No recording or storage of video (process in real-time, discard frames)

### Exit Criteria

Visual observations must be **binary-verifiable statements** with defined thresholds. Examples of valid claims:
- "Speaker looked down at notes for more than 30% of the speech" (threshold-based)
- "Speaker moved from one side of the stage to the other more than 5 times" (count-based)
- "Speaker used hand gestures during fewer than 20% of sentences" (frequency-based)

Avoid subjective claims like "great eye contact" unless backed by a quantitative threshold.

| Metric | Target |
|--------|--------|
| Visual observation accuracy | Manual review confirms ≥ 80% of binary-verifiable observations are factually correct |
| Prohibited inference rate | 0 instances of emotion/psychology inference across test runs |
| Evaluation quality improvement | Speakers rate multimodal evaluations more useful (qualitative survey) |
| Video consent compliance | 100% of video sessions have explicit video consent logged |

### Hardware Additions
- Camera (webcam or external, positioned to capture speaker)
- Sufficient lighting for reliable face/body detection

---

## Phase 5 — Real-Time Conversational AI Evaluator

### Goal

Transform the AI from a batch processor into a meeting participant that can interact conversationally.

### Phase Gate (Required Before Starting Phase 5)
Phase 5 introduces significant social risk in a Toastmasters setting. Before beginning Phase 5 development:
- Phase 2 exit criteria must be met for **≥ 10 consecutive real meetings**
- A "meeting etiquette test suite" must be developed and passing, covering:
  - Never interrupts a speaker mid-speech
  - Always waits to be explicitly addressed before speaking
  - Hard stop enforced on all responses
  - Graceful handling of unexpected or off-topic questions
  - Appropriate response when asked to do something outside its role

### Capabilities

#### Conversational Speech Interface
- Real-time speech-to-speech capability (not just TTS playback)
- Can respond when addressed by the Toastmaster or General Evaluator
- Natural conversational voice with appropriate meeting etiquette

#### Optional Interactive Features
- Can answer clarifying questions about its evaluation
- Can participate in Q&A segments if invited by the Toastmaster
- Can deliver impromptu Table Topics responses (demonstration/entertainment)

#### Behavioral Controls (Critical)
- Never interrupt a speaker mid-speech
- Respect meeting agenda and role boundaries
- Speak only when explicitly triggered or addressed
- Time-limited speaking with hard cutoff (configurable, default 30s for conversational responses)
- Graceful handling of unexpected questions or off-topic requests
- Operator kill switch always available

### Non-Goals (Phase 5)
- No autonomous operation (still requires operator oversight)
- No speaker detection or automatic triggering
- No multi-turn extended conversations (single response per interaction)

### Exit Criteria

| Metric | Target |
|--------|--------|
| Meeting etiquette test suite | 100% pass rate |
| Interruption incidents | 0 across all test sessions |
| Response time (addressed → speaking) | ≤ 3 seconds |
| Response time compliance | 100% of responses within configured time limit |
| Conversational naturalness | Rated "natural" by ≥ 70% of attendees surveyed |

---

## Phase 6 — Fully Automated Operation

### Goal

Minimize human intervention — the AI operates independently within the meeting flow.

### Capabilities

#### Automation
- Detect speaker via **meeting role assignment** (operator pre-assigns or agenda ingestion identifies who speaks next) — this is the primary detection method
- Detect speech start and stop without operator input (VAD-based, graduated from Phase 3)
- Auto-generate evaluation after speech ends
- Auto-speak evaluation at the correct agenda moment

#### Speaker Identification (Privacy-Gated)
- Voice-based speaker identification is **optional** and requires:
  - Explicit per-speaker consent for voice profile creation
  - Clear data retention policy for voice profiles
  - Privacy review before deployment
- Meeting role assignment is always preferred over voice identification
- Voice ID is not required for Phase 6 — it enables convenience features (longitudinal tracking) but is not a prerequisite

#### Optional Integrations
- Timer integration: track speech timing against project requirements (green/yellow/red)
- Meeting agenda ingestion: understand meeting structure and when to speak
- Speaker recognition: identify returning speakers for longitudinal tracking (requires voice ID consent)

### Exit Criteria

| Metric | Target |
|--------|--------|
| Correct speech detection rate | ≥ 95% of speeches correctly identified and evaluated |
| False start rate | < 2% (incorrectly starting evaluation for non-speech audio) |
| Correct agenda timing | Evaluation delivered at correct meeting moment ≥ 90% of the time |
| Graceful fallback rate | 100% of automation failures fall back to manual mode without disruption |

---

## Phase 7 — Production-Ready System

### Goal

Harden the system for reliable, scalable, safe deployment across multiple clubs.

### Capabilities

#### Reliability
- Robust noise handling (background chatter, applause, laughter)
- Speaker diarization for multi-speaker scenarios
- Fault tolerance: automatic recovery from API failures, network drops
- Graceful degradation at every pipeline stage

#### Privacy & Compliance
- Full compliance-grade consent workflow: per-speaker opt-in with audit trail
- Configurable data retention policies (auto-delete after N days)
- Speaker opt-out mechanism with data deletion
- Secure processing: encrypted audio in transit, no persistent storage by default
- GDPR/privacy regulation awareness (configurable per jurisdiction)
- Consent audit log exportable for club records

#### Observability
- Evaluation quality logs and confidence indicators
- Error monitoring and alerting
- Performance metrics (latency, API costs, success rates)

#### Usability
- Simple, polished meeting UI (one-click operation)
- Setup wizard for new clubs
- Fail-safe fallback to silent mode
- Mobile-responsive UI for tablet operation

### Exit Criteria

| Metric | Target |
|--------|--------|
| Uptime during meetings | ≥ 99% |
| Setup time for new meeting | < 5 minutes |
| Privacy incidents | 0 |
| Multi-club deployment | Successfully running in ≥ 3 clubs |
| Mean time to recovery (API failure) | < 10 seconds |

---

## Phase 8 — Advanced Coaching & Analytics

### Goal

Transform from a meeting evaluator into a comprehensive speech **coaching product**. This is where the system moves beyond descriptive feedback into scores, tracking, and personalized improvement plans.

### Capabilities

#### Advanced Metrics (Scored)
- Speech structure scoring (introduction, body, conclusion quality)
- Storytelling detection and effectiveness assessment
- Persuasion strength analysis
- Message clarity scoring
- Vocabulary richness and variety

#### Longitudinal Coaching
- Track individual speaker progress across multiple speeches
- Personalized improvement plans based on historical patterns
- Habit detection: recurring issues with pace, fillers, structure
- Progress visualization: improvement trends over time
- Goal setting and tracking

#### Optional Features
- Practice mode: rehearse outside meetings with instant feedback (separate rate limits)
- Real-time coaching: subtle cues during practice (not during live meetings)
- Comparative analytics: anonymous benchmarking against club averages (opt-in)

### Exit Criteria

| Metric | Target |
|--------|--------|
| Score consistency | Same speech scored within ±5% across 10 runs |
| Longitudinal tracking | Progress trends visible after ≥ 3 tracked speeches per speaker |
| Speaker-reported value | ≥ 70% of tracked speakers report coaching as "useful" or "very useful" |
| Practice mode latency | Real-time feedback within 5 seconds during practice |

---

## Phase 9 — Expansion (Future Directions)

### Potential Capabilities

- **Virtual meeting integration**: Zoom, Webex, Google Meet, Teams
- **AI General Evaluator**: Evaluate the entire meeting (timing, transitions, role performance)
- **AI Table Topics Master**: Generate and deliver Table Topics questions
- **Multi-speaker analytics**: Compare delivery patterns across speakers in a session
- **Club performance insights**: Aggregate analytics for club officers
- **Training mode for new evaluators**: Compare human vs. AI evaluations
- **Multi-language support**: Evaluate speeches in languages other than English
- **Custom evaluation frameworks**: Club-specific or district-specific criteria

---

## Technical Architecture (High Level)

### Capture Layer
- Microphone (primary, all phases)
- Camera (Phase 4+)
- Echo cancellation / feedback prevention
- Virtual meeting audio capture (Phase 9)

### Processing Layer
- Real-time audio streaming pipeline
- Parallel transcription: live captions (best-effort) + post-speech final transcript (canonical)
- Delivery metrics extraction (deterministic)
- Video frame analysis (Phase 4+)
- Speaker diarization (Phase 7+)

### Intelligence Layer
- Structured evaluation generation (LLM with JSON output)
- Evidence validation pipeline (contiguous token matching + timestamp locality)
- Tone and content guardrails + safety boundary enforcement
- Speech structure analysis (Phase 2+, descriptive only)
- Project-aware evaluation (Phase 3+)
- Scoring and longitudinal pattern detection (Phase 8+)

### Delivery Layer
- Text-to-speech with warm conversational voice
- Real-time conversational speech (Phase 5+)
- Written evaluation output
- Evidence and metrics UI
- Processing progress indicators

### Data Layer
- Session storage (in-memory for MVP, persistent for Phase 7+)
- Consent logs (Phase 2+)
- Speaker profiles and history (Phase 8+)
- Club-level analytics (Phase 9)
- Cost tracking per session (all phases)

### Technology Stack (Phase 1)
- Runtime: Node.js with TypeScript
- Web Framework: Express.js + raw WebSocket (ws)
- Frontend: Vanilla HTML/CSS/JS
- Live Transcription: Deepgram API
- Post-Speech Transcription: OpenAI gpt-4o-transcribe
- LLM: OpenAI GPT-4o (structured output)
- TTS: OpenAI TTS API
- Testing: Vitest + fast-check

---

## Key Risks

### Technical
| Risk | Mitigation |
|------|------------|
| Audio quality / echo in meeting rooms | Separate mic + speaker, hard mic-stop during TTS, panic mute |
| Noisy room (applause, chatter) | Quality warning system, best-effort evaluation with caveats |
| Speech detection reliability | Manual control first, VAD only as suggestion with human confirmation |
| API latency affecting meeting flow | Progress UI with stages, configurable timeout, text-only fallback |
| Transcription accuracy | Two-pass approach (live captions + post-speech canonical), quality assessment |
| API costs for long speeches | Per-session cost tracking, configurable max speech length, rate limits |

### Behavioral
| Risk | Mitigation |
|------|------------|
| Ungrounded feedback | Evidence validation pipeline, structured JSON with quote verification |
| Tone mismatch | Prompt engineering, tone guardrails, automated tone policy checks, no CRC pattern |
| Over-automation too early | Phase-gated automation, human confirmation at each step, reliability gates |
| Inappropriate visual observations | Strict observational language rules, no emotion/psychology inference |
| Safety boundary violations | Explicit content boundaries (no medical/legal, no trait inference), automated checks |

### Social / Adoption
| Risk | Mitigation |
|------|------------|
| Speaker consent concerns | Operator-confirmed consent (Phase 1), built-in consent capture (Phase 2), full audit trail (Phase 7) |
| Trust in AI feedback | Evidence grounding, transparent metrics, gradual introduction, supplement positioning |
| Meeting disruption | Panic mute, fail-safe silent mode, operator control, progress indicators |
| Resistance from traditional evaluators | Supplement not replacement, evaluator training mode, recommended use cases |

---

## Success Criteria Summary

### MVP (Phase 1)
- Accurate final transcript of a real speech in a real meeting
- Clear, natural-sounding spoken evaluation within 90s–3m30s
- All feedback points grounded in specific evidence
- No unrecoverable meeting disruption from technical failures
- End-to-end latency: p50 ≤ 20s, p90 ≤ 30s, max ≤ 45s
- Short-form fallback activates automatically if latency exceeds threshold

### Credible Evaluator (Phase 2)
- No ungrounded claims across 20+ consecutive sessions
- Consistent evaluation structure and tone
- Speech structure commentary in 90%+ of evaluations

### Mature System (Phase 7+)
- ≥ 99% uptime during meetings
- Zero privacy incidents
- Deployable across multiple clubs with < 5 minute setup

### Coaching Platform (Phase 8+)
- Measurable speaker improvement over time
- Personalized recommendations that evolve with speaker history
- Speakers report coaching as valuable

---

## Phase Dependency Map

```
Phase 1 (MVP) ──→ Phase 2 (Stability) ──→ Phase 3 (Semi-Auto)
                                              │
                                              ├──→ Phase 4 (Video) ─────────┐
                                              │                              │
                                              └──→ Phase 5 (Conversational)* ┤
                                                       │                     │
                                                       ▼                     │
                                                 Phase 6 (Full Auto) ◄───────┘
                                                       │
                                                       ▼
                                                 Phase 7 (Production)
                                                       │
                                                       ▼
                                                 Phase 8 (Coaching)
                                                       │
                                                       ▼
                                                 Phase 9 (Expansion)
```

*Phase 5 has a reliability gate: Phase 2 exit criteria must be met for ≥ 10 consecutive real meetings before Phase 5 development begins.

Phases 4 and 5 can be developed in parallel after Phase 3. All other phases are sequential.
