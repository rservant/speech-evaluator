# Implementation Plan: Eager Evaluation Pipeline

## Overview

Convert the evaluation pipeline from lazy (triggered on Deliver click) to eager (triggered automatically after recording stops). Implementation proceeds bottom-up: types first, then SessionManager core logic (cache validity, eager pipeline, centralized cleanup, invalidation), then server wiring (stop-recording trigger, three-branch delivery, time-limit invalidation), then frontend UI updates (progress indicator, button gating). The existing `generateEvaluation()` pipeline stages are reused inside `runEagerPipeline()` without state transitions.

### Design fixes incorporated

1. **Deferred pattern** with typed `createDeferred<T>()` utility in `src/utils/deferred.ts` (not `src/types.ts` — avoid runtime code in type barrel; not `src/utils.ts` — avoid junk drawer): `runEagerPipeline()` uses explicit deferred so `(eagerPromise, eagerRunId, eagerStatus)` are set atomically before any await, and no synchronous throw can cause rejection
2. **Never-reject covers all surfaces**: `safeProgress()` wraps all `onProgress` calls; deferred eliminates pre-await throw risk; no rethrow in `finally`; `resolve()` always called in `finally`
3. **State precondition guard**: `runEagerPipeline()` returns immediately if `session.state !== "PROCESSING"` — MUST be first check, before any field reads or mutations
4. **Zombie eagerStatus fix**: on RunId mismatch, `finally` resets `eagerStatus` to `"idle"` only if not `"ready"` — prevents stranded `generating`/`synthesizing` with null promise/runId, while avoiding transient `ready → idle` with still-valid cache
5. **`clearEagerState()` vs `cancelEagerGeneration()` split**: `clearEagerState()` is pure field reset; `cancelEagerGeneration()` does `runId++` then `clearEagerState()`. `cancelEagerGeneration()` cancels by invalidating results via epoch bump — does NOT abort in-flight LLM/TTS calls
6. **Branch 2 snapshots both promise AND runId**: `handleDeliverEvaluation()` snapshots `session.eagerPromise` AND `session.runId` into locals before awaiting; after await, verifies runId unchanged before delivering from cache (Hazard 6)
7. **eagerRunId** on Session for explicit single-flight guard; cleared in `finally` alongside `eagerPromise`
8. **Dual-guard finally cleanup**: `finally` block checks `session.eagerRunId === capturedRunId || session.eagerPromise === promise` before touching any fields — resilient to future refactors where one field could be reset early. `resolve()` remains unconditional (outside the guard)
9. **Single-flight strict identity**: Property 14 test checks `p1 === p2`
10. **voiceConfig invalidation**: documented as future requirement if runtime mutation handler is added
11. **Frontend stage ordering**: server guarantees sequential emission; client uses last-writer-wins (Hazard 5)
12. Property 1 test layering: SessionManager tests state invariants; server tests message boundary
13. **`invalidated` PipelineStage**: `handleSetTimeLimit()` sends `pipeline_progress: invalidated` (not `processing_speech` — Hazard 4 preserved) with new runId as UI reset signal. `invalidated` is never emitted by SessionManager — it's a server/UI hint only
14. Property 12 (replay) tested with fake timers against 10-minute auto-purge window
15. `Deferred<T>` type in `src/types.ts`; `createDeferred<T>()` factory in `src/utils/deferred.ts`
16. **`evaluationPublic` required for delivery**: cache validity check includes `cache.evaluationPublic !== null`. The `evaluation_ready` message sends `StructuredEvaluationPublic` to the client, so the eager pipeline must compute it during redaction and include it in the cache

## Tasks

- [ ] 1. Add types and session field extensions
  - [ ] 1.1 Add `EagerStatus`, `PipelineStage`, `EvaluationCache`, and `Deferred<T>` types to `src/types.ts`; add `createDeferred<T>()` factory to `src/utils/deferred.ts`
    - In `src/types.ts`: define `EagerStatus` union type: `"idle" | "generating" | "synthesizing" | "ready" | "failed"`
    - In `src/types.ts`: define `PipelineStage` union type: `"processing_speech" | "generating_evaluation" | "synthesizing_audio" | "ready" | "failed" | "invalidated"`. Note: `invalidated` is never emitted by SessionManager — it's a server/UI hint only, sent from server-layer handlers
    - In `src/types.ts`: define `EvaluationCache` interface with fields: `runId: number`, `timeLimitSeconds: number`, `voiceConfig: string`, `evaluation: StructuredEvaluation`, `evaluationScript: string`, `ttsAudio: Buffer`, `evaluationPublic: StructuredEvaluationPublic | null` (nullable in type but required non-null for cache validity — delivery path sends `evaluationPublic` as the `evaluation_ready` message payload)
    - In `src/types.ts`: define `Deferred<T>` interface: `{ promise: Promise<T>; resolve: (value: T) => void }`
    - In `src/utils/deferred.ts`: implement `createDeferred<T>()` factory function that returns a `Deferred<T>`. Own module — keeps runtime code out of the type barrel and avoids bloating `src/utils.ts`. Reusable in `runEagerPipeline()` and tests
    - _Requirements: 2.1, 9.1_
  - [ ] 1.2 Add `eagerStatus`, `eagerRunId`, `eagerPromise`, and `evaluationCache` fields to `Session` interface in `src/types.ts`
    - Add `eagerStatus: EagerStatus` defaulting to `"idle"`
    - Add `eagerRunId: number | null` defaulting to `null` — runId captured at eager pipeline start; used by single-flight guard; cleared in `finally` alongside `eagerPromise`
    - Add `eagerPromise: Promise<void> | null` defaulting to `null`
    - Add `evaluationCache: EvaluationCache | null` defaulting to `null`
    - _Requirements: 2.1_
  - [ ] 1.3 Add `pipeline_progress` variant to `ServerMessage` union type in `src/types.ts`
    - Add `{ type: "pipeline_progress"; stage: PipelineStage; runId: number; message?: string }`
    - _Requirements: 9.1_
  - [ ] 1.4 Initialize new session fields in `SessionManager.createSession()` in `src/session-manager.ts`
    - Set `eagerStatus: "idle"`, `eagerRunId: null`, `eagerPromise: null`, `evaluationCache: null` in the session object literal
    - _Requirements: 2.1_

- [ ] 2. Implement SessionManager cache validity, eager pipeline core, and centralized cleanup
  - [ ] 2.1 Add `isEagerCacheValid()` method to `SessionManager` in `src/session-manager.ts`
    - Return `true` only when ALL conditions hold: `evaluationCache !== null`, `eagerStatus === "ready"`, `cache.runId === session.runId`, `cache.timeLimitSeconds === session.timeLimitSeconds`, `cache.voiceConfig === (session.voiceConfig ?? "nova")`, `cache.ttsAudio.length > 0`, `cache.evaluation !== null`, `cache.evaluationScript !== null`, `cache.evaluationPublic !== null`
    - Per Implementation Hazard 3: compare against the resolved voiceConfig, not raw `undefined`
    - `evaluationPublic` is required because the delivery path sends it as the `evaluation_ready` message payload (`StructuredEvaluationPublic`)
    - _Requirements: 6.1, 4.5_
  - [ ]* 2.2 Write property test for cache validity invariant in `src/session-manager.property.test.ts`
    - **Property 4: Cache validity invariant**
    - Include `evaluationPublic !== null` in the validity assertion
    - **Validates: Requirements 6.1**
  - [ ] 2.3 Add `clearEagerState()` and `cancelEagerGeneration()` methods to `SessionManager` in `src/session-manager.ts`
    - `clearEagerState(sessionId)`: pure field reset — sets `eagerStatus = "idle"`, `eagerRunId = null`, `eagerPromise = null`, `evaluationCache = null`. Does NOT increment `runId`. Safe for cleanup-only paths (e.g., `purgeSessionData`)
    - `cancelEagerGeneration(sessionId)`: cancellation primitive — calls `session.runId++` then `this.clearEagerState(sessionId)`. Add comment: "Cancels by invalidating results via epoch bump; does NOT abort in-flight LLM/TTS calls. The in-flight pipeline will detect the runId mismatch at its next checkpoint and discard results."
    - This separation prevents a future refactor from calling `clearEagerState()` alone when cancellation was intended, leaving a stale pipeline able to commit results
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.7_
  - [ ] 2.4 Implement `runEagerPipeline()` method on `SessionManager` in `src/session-manager.ts`
    - Signature: `runEagerPipeline(sessionId: string, onProgress?: (stage: PipelineStage) => void): Promise<void>` — note: NOT `async`, returns deferred promise
    - **State precondition guard** (MUST be first — before any field reads or mutations): if `session.state !== "PROCESSING"`, return `Promise.resolve()` immediately
    - **Single-flight guard** using `eagerRunId`: if `session.eagerRunId === session.runId` and `eagerStatus` is `generating` or `synthesizing`, return existing `session.eagerPromise` (same reference, not a wrapper)
    - Capture `runId`, `timeLimitSeconds`, resolved `voiceConfig` (`session.voiceConfig ?? "nova"`) — only after guards pass
    - **Deferred pattern** (per Hazard 1): `const { promise, resolve } = createDeferred<void>()` (imported from `src/utils/deferred.ts`), then set `session.eagerPromise = promise`, `session.eagerRunId = capturedRunId`, `session.eagerStatus = "generating"` — all synchronous, before any async work
    - **safeProgress helper**: `const safeProgress = (stage) => { try { onProgress?.(stage); } catch {} }` — wraps all `onProgress` calls so callback throws cannot reject the promise. Note: `safeProgress` only emits pipeline stages (`generating_evaluation`, `synthesizing_audio`, `ready`, `failed`) — never `invalidated` (that's server-only)
    - Launch async IIFE: `(async () => { try { ... } catch { ... } finally { ... } })()`
    - Inside try: call `safeProgress("generating_evaluation")`, run same pipeline stages as `generateEvaluation()` (LLM → energy → script → tone → trim → scope → redact → TTS), set `eagerStatus = "synthesizing"` before TTS + `safeProgress("synthesizing_audio")`, on success build `EvaluationCache` atomically (including `evaluationPublic` from redaction output), confirm `artifact.runId === session.runId`, publish to `session.evaluationCache`, set `eagerStatus = "ready"`, `safeProgress("ready")`
    - Inside catch: if `capturedRunId === session.runId` then set `eagerStatus = "failed"`, `evaluationCache = null`, `safeProgress("failed")`. Never rethrow
    - On RunId mismatch at any checkpoint: return early from try block without modifying `evaluationCache` or `session.state`
    - **Dual-guard finally**: `const isOwner = session.eagerRunId === capturedRunId || session.eagerPromise === promise` — check BOTH eagerRunId and promise identity for ownership. Inside the guard: if `capturedRunId !== session.runId && session.eagerStatus !== "ready"` then set `eagerStatus = "idle"` (restore coherence — prevent zombie generating/synthesizing; skip if `ready` because cache was published and cancellation path handles full reset); set `session.eagerPromise = null`, `session.eagerRunId = null`. Outside the guard (always, unconditionally): call `resolve()` — promise can only resolve, never reject
    - Return the deferred `promise`
    - Evidence validation runs against raw (unredacted) transcript; redaction applied after validation per evidence-grounding-and-validation steering rule
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.2, 8.1, 8.2_
  - [ ]* 2.5 Write property test for state invariants during eager execution in `src/session-manager.property.test.ts`
    - **Property 1: State and behavioral boundary during eager execution (SessionManager layer)**
    - Assert: `session.state` remains PROCESSING throughout, `runEagerPipeline()` never calls `assertTransition()` or delivery-side methods, `evaluationCache` is null until atomic publish
    - Note: message boundary tests (no `evaluation_ready`/TTS audio sent) belong in `src/server.property.test.ts`, not here — SessionManager doesn't own message sending
    - **Validates: Requirements 1.4, 8.1, 8.2**
  - [ ]* 2.6 Write property test for eager status transition sequence in `src/session-manager.property.test.ts`
    - **Property 2: Eager status transition sequence with atomic cache publication**
    - Verify valid sequences: `idle→generating→synthesizing→ready`, `idle→generating→failed`, `idle→generating→synthesizing→failed`
    - Verify `ready` implies non-null cache with matching `runId` and non-null `evaluationPublic`, and both `eagerPromise` and `eagerRunId` are `null` on terminal states
    - Verify `invalidated` is never emitted by SessionManager's `onProgress` callback
    - **Validates: Requirements 2.2, 2.3, 2.4, 1.5, 9.2, 9.3**
  - [ ]* 2.7 Write property test for failure handling in `src/session-manager.property.test.ts`
    - **Property 3: Failure handling clears partial results**
    - Verify `eagerStatus === "failed"`, `session.state === PROCESSING`, `evaluationCache === null`, `eagerPromise === null`, `eagerRunId === null` after pipeline failure
    - Verify the promise resolved (did not reject) — test by checking `await promise` does not throw
    - Also verify: inject a throwing `onProgress` callback and confirm the promise still resolves (safeProgress coverage)
    - **Validates: Requirements 1.6**
  - [ ]* 2.8 Write property test for RunId staleness in `src/session-manager.property.test.ts`
    - **Property 9: RunId staleness — stale eager results are discarded**
    - Verify that if `runId` changes mid-pipeline: no `EvaluationCache` is published, `session.state` is not modified
    - Verify dual-guard cleanup: `eagerStatus` is reset to `"idle"` only if not `"ready"` (if pipeline published cache before runId changed, status stays `"ready"`), `eagerPromise` and `eagerRunId` are cleared to `null`
    - Verify old run's finally cannot clobber new run: start run A (runId=5), increment runId to 6, start run B (runId=6), let run A's finally fire — assert run B's `eagerPromise`/`eagerRunId`/`eagerStatus` are untouched (neither guard matches for run A since run B owns both fields)
    - **Validates: Requirements 5.5, 7.3**
  - [ ]* 2.9 Write property test for single-flight per RunId in `src/session-manager.property.test.ts`
    - **Property 14: Single-flight per RunId**
    - Call `runEagerPipeline()` twice with same `runId` — verify second call returns the exact same promise reference (`p1 === p2`, strict identity check, not deep equality or "both resolve")
    - Verify only one pipeline execution occurs (e.g., mock pipeline stages and assert call count)
    - Guard uses `eagerRunId === session.runId` check
    - **Validates: Requirements 1.2**
  - [ ]* 2.10 Write property test for state precondition guard in `src/session-manager.property.test.ts`
    - Verify `runEagerPipeline()` returns resolved promise and does not modify any eager fields when `session.state !== "PROCESSING"` (e.g., IDLE, DELIVERING, RECORDING)
    - _Requirements: 1.4_

- [ ] 3. Implement cache invalidation and lifecycle methods
  - [ ] 3.1 Add `invalidateEagerCache()` method to `SessionManager` in `src/session-manager.ts`
    - Call `this.cancelEagerGeneration(sessionId)` — increments `runId` and clears all eager fields
    - _Requirements: 6.2_
  - [ ] 3.2 Modify `startRecording()` in `src/session-manager.ts` to reset eager state
    - Call `this.clearEagerState(sessionId)` in the existing reset block (after existing `session.runId++`)
    - Note: `startRecording()` already increments `runId` — use `clearEagerState()` (pure reset), not `cancelEagerGeneration()`
    - _Requirements: 2.5, 6.3_
  - [ ] 3.3 Modify `panicMute()` in `src/session-manager.ts` to clear eager state and cache
    - Call `this.clearEagerState(sessionId)` in existing cleanup (after existing `session.runId++`)
    - Note: `panicMute()` already increments `runId` — use `clearEagerState()` (pure reset), not `cancelEagerGeneration()`
    - _Requirements: 6.4, 7.1_
  - [ ] 3.4 Modify `revokeConsent()` in `src/session-manager.ts` to clear eager state and cache
    - Call `this.clearEagerState(sessionId)` in existing purge block (after existing `session.runId++`)
    - Note: `revokeConsent()` already increments `runId` — use `clearEagerState()` (pure reset)
    - Per privacy-and-retention steering rule: opt-out purges all session data immediately and irrecoverably
    - _Requirements: 6.5, 7.2_
  - [ ] 3.5 Modify `purgeSessionData()` to clear eager state and cache via SessionManager
    - Call `this.clearEagerState(sessionId)` — pure reset only, no `runId++` needed (purge happens after delivery, no in-flight work to cancel)
    - If `purgeSessionData` currently lives in `src/server.ts`, move the eager-relevant cleanup into a SessionManager method that the server calls
    - _Requirements: 6.7_
  - [ ]* 3.6 Write property tests for cache invalidation and lifecycle in `src/session-manager.property.test.ts`
    - **Property 5: Cache invalidation on generation parameter change** — Validates: Requirements 6.2
    - **Property 6: Reset on new recording** — Validates: Requirements 2.5, 6.3
    - **Property 7: Panic mute cancellation and cleanup** — Validates: Requirements 6.4, 7.1
    - **Property 8: Opt-out cancellation and full purge** — Validates: Requirements 6.5, 7.2
    - **Property 13: Auto-purge clears cache** — Validates: Requirements 6.7
    - Include a coverage test: verify every `runId` mutation path uses the correct method (`clearEagerState` when runId already incremented, `cancelEagerGeneration` when it needs incrementing)

- [ ] 4. Checkpoint - Ensure all SessionManager tests pass
  - Run `vitest --run` for session-manager test files
  - Ensure all tests pass, ask the user if questions arise

- [ ] 5. Modify server delivery and stop-recording handlers
  - [ ] 5.1 Modify `handleStopRecording()` in `src/server.ts` to kick off eager pipeline
    - After existing `stopRecording()` call, transcript update, and quality warning messages, send `pipeline_progress: { stage: "processing_speech", runId: session.runId }`
    - Capture `runId` at this point for progress callback closure
    - Call `sessionManager.runEagerPipeline(connState.sessionId, (stage) => sendMessage(ws, { type: "pipeline_progress", stage, runId: capturedRunId }))` — fire-and-forget, do not await
    - Note: `processing_speech` is sent from `handleStopRecording`, not from the eager pipeline, to indicate transcription/metrics are complete (per Hazard 4). Server guarantees sequential stage emission — no regressive stages for same runId (Hazard 5)
    - Note: `eagerPromise` is owned by `SessionManager.runEagerPipeline()` — server only reads it, never assigns it
    - _Requirements: 1.1, 3.1, 9.2_
  - [ ] 5.2 Rewrite `handleDeliverEvaluation()` in `src/server.ts` with three-branch delivery logic
    - Re-entrancy guard: if `session.state === DELIVERING`, ignore the request (Req 5.6)
    - **Snapshot both promise AND runId** (Hazard 6): `const eagerP = session.eagerPromise; const snapshotRunId = session.runId;` — read into locals before any async work. The promise may be nulled by the pipeline's `finally` block; the runId detects invalidation during await
    - Branch 1 (cache hit): if `isEagerCacheValid()` returns true, skip all generation, transition to DELIVERING, send `state_change: DELIVERING`, send `evaluation_ready` with `cache.evaluationPublic` and `cache.evaluationScript`, call `ws.send(cache.ttsAudio)` directly (no blocking work), send `tts_complete`, call `completeDelivery()`, send `state_change: IDLE`, start purge timer
    - Branch 2 (await eager): if `eagerP !== null` and `eagerStatus` is `generating` or `synthesizing`, `await eagerP` (guaranteed to resolve per never-reject contract — no try/catch needed around await), then check `session.runId !== snapshotRunId` — if changed, fall through to Branch 3 (runId was invalidated during await). Otherwise re-check `isEagerCacheValid()` — if valid deliver from cache (same as Branch 1), else fall through to Branch 3
    - Branch 3 (synchronous fallback): run existing `generateEvaluation()` pipeline, deliver result using existing logic. Session stays PROCESSING during fallback execution, transitions to DELIVERING only when audio transmission begins
    - On every delivery attempt: send `evaluation_ready` before TTS audio binary frame (Req 5.4)
    - Only use results matching current `runId` (Req 5.5)
    - After delivery completes: `evaluationCache` remains available for `replay_tts` until auto-purge fires (Req 5.7)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - [ ] 5.3 Modify `handleSetTimeLimit()` in `src/server.ts` to invalidate eager cache and send UI reset
    - After updating `session.timeLimitSeconds`, check if session is in PROCESSING state and eager data exists or is in-flight
    - If so, call `sessionManager.invalidateEagerCache(connState.sessionId)` (which calls `cancelEagerGeneration` internally — increments `runId`)
    - Send `pipeline_progress: invalidated` (NOT `processing_speech` — that stage means "transcription complete" per Hazard 4 and would be a semantic lie here): `sendMessage(ws, { type: "pipeline_progress", stage: "invalidated", runId: session.runId })` using the *new* runId (post-increment). UI maps this to "Settings changed — evaluation will regenerate on delivery"
    - The client's stale-runId filter accepts this because the new runId is higher than the old one
    - If eager is re-triggered after invalidation, the new pipeline's progress messages naturally supersede this reset
    - _Requirements: 6.2_
  - [ ]* 5.4 Write property test for cache-hit delivery skips generation in `src/server.property.test.ts`
    - **Property 10: Cache-hit delivery skips generation**
    - Verify that when `isEagerCacheValid()` is true, `generateEvaluation()` is never called and cached `ttsAudio` is sent via `ws.send()` directly
    - Verify `evaluation_ready` message contains `cache.evaluationPublic` (not raw `evaluation`)
    - **Validates: Requirements 5.1**
  - [ ]* 5.5 Write property test for fallback delivery in `src/server.property.test.ts`
    - **Property 11: Fallback delivery on failure or missing cache**
    - Verify that when `eagerStatus` is `failed`/`idle` or cache is invalid, the full synchronous pipeline runs and session stays PROCESSING during execution
    - **Validates: Requirements 5.3**
  - [ ]* 5.6 Write property test for behavioral boundary at server layer in `src/server.property.test.ts`
    - **Property 1: State and behavioral boundary during eager execution (server layer)**
    - Instrument `sendMessage()`/`ws.send()` and assert that the eager kickoff path produces only `pipeline_progress` messages — no `evaluation_ready`, TTS audio frames, or `tts_complete` until `deliver_evaluation` is received
    - **Validates: Requirements 8.1, 8.2**
  - [ ]* 5.7 Write unit tests for delivery and invalidation edge cases in `src/server.test.ts`
    - Test await-then-deliver flow: deliver_evaluation received while eager is in-flight, server awaits snapshotted promise then delivers from cache (Req 5.2). Verify await does not throw (never-reject contract). Verify runId snapshot: if runId changes during await, falls through to synchronous fallback
    - Test re-entrancy guard: deliver_evaluation during DELIVERING is ignored (Req 5.6)
    - Test message ordering: `evaluation_ready` sent before TTS audio binary frame on every delivery (Req 5.4)
    - Test replay availability with fake timers: after delivery completes, `evaluationCache` remains for `replay_tts` until auto-purge fires at 10 minutes (Property 12, Req 5.7). Assert: (a) cache non-null immediately after delivery, (b) cache non-null before purge timer, (c) cache null after purge timer fires
    - **Test `invalidated` gating**: set time limit in PROCESSING while eager is in-flight → server sends `pipeline_progress: invalidated` with incremented runId → deliver click after invalidation goes to Branch 3 (fallback) unless a new eager run has completed. Verify `invalidated` stage is sent (not `processing_speech`), and delivery falls through to synchronous fallback
    - _Requirements: 5.2, 5.4, 5.6, 5.7, 6.2_

- [ ] 6. Checkpoint - Ensure all server tests pass
  - Run `vitest --run` for server test files
  - Ensure all tests pass, ask the user if questions arise

- [ ] 7. Update frontend UI for eager pipeline
  - [ ] 7.1 Add `pipeline_progress` message handler and client state in `public/index.html`
    - Add `pipelineStage` and `pipelineRunId` client-side state variables (default `"idle"` and `0`)
    - Add `pipeline_progress` case to `handleServerMessage()` with stale-runId filtering: ignore messages where `message.runId < pipelineRunId`
    - Per Hazard 2: reset `pipelineRunId = 0` on WebSocket reconnect to prevent stale filtering after reconnection
    - Per Hazard 5: client uses last-writer-wins for stage updates within same runId; server guarantees sequential emission so no client-side stage ordering guard needed
    - Handle `invalidated` stage: when `pipeline_progress: invalidated` arrives with a higher runId (sent by `handleSetTimeLimit` after invalidation), the client updates its display to "Settings changed — evaluation will regenerate on delivery" via the existing stage→text mapping and enables the Deliver button
    - _Requirements: 9.1, 3.1_
  - [ ] 7.2 Implement `updateProcessingIndicator()` function with stage-specific text in `public/index.html`
    - Map stages: `processing_speech` → "Speech processed — preparing evaluation...", `generating_evaluation` → "Generating evaluation...", `synthesizing_audio` → "Synthesizing audio...", `ready` → "✓ Evaluation ready — click Deliver Evaluation", `failed` → "⚠ Evaluation generation failed — click Deliver Evaluation to retry", `invalidated` → "Settings changed — evaluation will regenerate on delivery"
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [ ] 7.3 Update Deliver button gating logic in PROCESSING state in `public/index.html`
    - Disable Deliver button when `pipelineStage` is `processing_speech`, `generating_evaluation`, or `synthesizing_audio`
    - Enable Deliver button when `pipelineStage` is `ready`, `failed`, or `invalidated`
    - Server remains authoritative — UI gating is advisory only (Req 4.4)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [ ] 7.4 Reset pipeline client state on new recording and session transitions in `public/index.html`
    - Reset `pipelineStage = "idle"` and `pipelineRunId = 0` when starting a new speech
    - Handle `data_purged` message to reset pipeline state
    - Handle panic mute to reset pipeline state
    - _Requirements: 2.5, 6.3_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Run `vitest --run` for all test files
  - Ensure all tests pass, ask the user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check` with `vitest` (minimum 100 iterations per property)
- Unit tests validate specific examples and edge cases
- `runEagerPipeline()` reuses the same pipeline stages as `generateEvaluation()` but without state transitions or `assertTransition` calls
- Evidence validation runs against raw (unredacted) transcript; redaction applied after validation passes
- Session data is in-memory only; `evaluationCache` follows the same retention lifecycle as other session data
- The deferred pattern with typed `createDeferred<T>()` is the key implementation detail — it ensures `(eagerPromise, eagerRunId, eagerStatus)` are set atomically before any await, the promise can never reject, and `safeProgress` swallows callback errors
- `Deferred<T>` type lives in `src/types.ts`; `createDeferred<T>()` factory lives in `src/utils/deferred.ts` — own module, keeps runtime code out of the type barrel and avoids bloating `src/utils.ts`
- `clearEagerState()` is pure field reset; `cancelEagerGeneration()` is the cancellation primitive (`runId++` + clear). `cancelEagerGeneration()` cancels by invalidating results via epoch bump — does NOT abort in-flight LLM/TTS calls. Use the right one: cancellation paths that already increment `runId` (panicMute, revokeConsent, startRecording) call `clearEagerState()`; `invalidateEagerCache()` calls `cancelEagerGeneration()`; `purgeSessionData()` calls `clearEagerState()`
- Dual-guard finally: `session.eagerRunId === capturedRunId || session.eagerPromise === promise` — checks both fields for ownership. Resilient to future refactors where one field could be reset early while the other still identifies ownership. `resolve()` remains unconditional (outside the guard)
- On RunId mismatch (when still owner per dual-guard), `finally` resets `eagerStatus` to `"idle"` only if not `"ready"` — if the pipeline published cache before runId changed, status stays `"ready"` and the cancellation path's `clearEagerState`/`cancelEagerGeneration` handles the full reset. This prevents transient `ready → idle` with a still-valid cache object
- `handleDeliverEvaluation()` Branch 2 snapshots both `session.eagerPromise` AND `session.runId` into locals before awaiting; after await, verifies runId unchanged before delivering from cache (Hazard 6)
- `handleSetTimeLimit()` sends `pipeline_progress: invalidated` (not `processing_speech` — Hazard 4 preserved) with new runId after invalidation as UI reset signal. `invalidated` is never emitted by SessionManager — it's a server/UI hint only. UI maps to "Settings changed — evaluation will regenerate on delivery". Deliver button enabled so operator can trigger synchronous fallback
- `evaluationPublic` is required for cache validity (`cache.evaluationPublic !== null`). The delivery path sends it as the `evaluation_ready` message payload. The eager pipeline computes it during the redaction step and includes it in the `EvaluationCache`
- `voiceConfig` has no runtime mutation handler currently; if `handleSetVoiceConfig()` is added, it MUST wire `invalidateEagerCache()` and send the same `invalidated` UI reset signal per the design doc
