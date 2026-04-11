/**
 * WebSocket connection, message handler dispatch, TTS audio, state transitions.
 * Extracted from app.js for ES module pattern (#110).
 */
import { S, dom, videoDom } from "./state.js";
import { SessionState } from "./constants.js";
import { show, hide, enable, disable } from "./utils.js";
import {
  updateUI, updateAudioLevel, handleVADStatus, updateElapsedTime,
  updateConsentStatusDisplay, updateDurationEstimateDisplay,
  updateProcessingIndicator, updateDeliverButtonState, showError, dismissError,
  showSavedConfirmation, showInterruptionBanner, showNotification,
  resetVadEnergyState, showCoachingCue,
} from "./ui.js";
import { clearFormState, hideVideoConsentError, resetProjectContextForm, handleVADSpeechEnd } from "./consent.js";
import { completeActiveSlot } from "./meeting.js";
import { updateTranscript, showEvaluation, displayRoleResults, renderTranscript, clearEvidenceHighlight } from "./transcript.js";
import { stopAudioCapture, hardStopMic, startCooldown, clearCooldown } from "./audio.js";
import { stopVideoCapture, stopVisionCapture, releaseCamera, handleVideoStatus } from "./video.js";

// ─── WebSocket Connection ─────────────────────────────────────────

// Reconnect state
let reconnectDelay = 1000; // Start at 1s, exponential backoff up to 30s
const RECONNECT_DELAY_MAX = 30000;
const RECONNECT_DELAY_INITIAL = 1000;
let reconnectTimer = null;
const btnReconnect = document.getElementById("btn-reconnect");

/**
 * Establishes a WebSocket connection to the server.
 * Handles connection lifecycle, auto-reconnection with exponential backoff,
 * and message routing.
 */
// Track whether a live session is active (for reconnect decisions)

export function connectWebSocket() {
  if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) {
    return; // Already connected or connecting
  }

  // Clear any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = protocol + "//" + window.location.host;

  dom.connectionStatus.textContent = "Connecting…";
  dom.connectionStatus.style.color = "var(--text-muted)";
  btnReconnect.style.display = "none";

  S.ws = new WebSocket(url);
  S.audioFormatSent = false;
  // Per Hazard 2: reset S.pipelineRunId on reconnect to prevent stale filtering
  S.pipelineRunId = 0;

  S.ws.binaryType = "arraybuffer"; // For receiving TTS audio

  S.ws.onopen = function () {
    dom.connectionStatus.textContent = "Connected";
    dom.connectionStatus.style.color = "var(--color-success)";
    btnReconnect.style.display = "none";
    // Reset backoff on successful connection
    reconnectDelay = RECONNECT_DELAY_INITIAL;
    // Send audio format handshake immediately on connection
    sendAudioFormatHandshake();
    // Re-send all client-side session config (#165)
    resyncSessionState();
  };

  S.ws.onmessage = function (event) {
    if (event.data instanceof ArrayBuffer) {
      // Binary message — TTS audio chunk
      console.log("[WS] Received binary frame:", event.data.byteLength, "bytes");
      handleTTSAudio(event.data);
      return;
    }
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (err) {
      console.error("Failed to parse server message:", err);
    }
  };

  S.ws.onclose = function () {
    // Fail-safe: if WS drops during playback, deferred state, pending latch,
    // or any non-IDLE state, stop everything.
    if (S.ttsPlaying || S.deferredIdleTransition !== null || S.pendingIdleFromServer !== null || S.currentState !== SessionState.IDLE) {
      triggerTTSFailSafe();
    }

    S.ws = null;
    S.audioFormatSent = false;

    // Only auto-reconnect during active live sessions — not idle page views
    if (S.liveSessionActive) {
      const delaySec = (reconnectDelay / 1000).toFixed(0);
      dom.connectionStatus.textContent = `Reconnecting in ${delaySec}s…`;
      dom.connectionStatus.style.color = "var(--color-warning, #e6a817)";
      btnReconnect.style.display = "inline-block";

      console.log(`[WS] Disconnected during session. Auto-reconnecting in ${delaySec}s…`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, reconnectDelay);

      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_MAX);
    } else {
      dom.connectionStatus.textContent = "Disconnected";
      dom.connectionStatus.style.color = "var(--text-muted)";
      console.log("[WS] Disconnected (no active session — not auto-reconnecting)");
    }
  };

  S.ws.onerror = function (err) {
    console.error("WebSocket error:", err);
    dom.connectionStatus.textContent = "Connection Error";
    dom.connectionStatus.style.color = "var(--color-danger)";
  };
}

/**
 * Connects the WebSocket and returns a promise that resolves when
 * the connection is open. Used by onStartSpeech() for on-demand connection.
 * Rejects after 10 seconds if the connection cannot be established.
 */
export function connectWebSocketAndWait() {
  return new Promise((resolve, reject) => {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    connectWebSocket();
    const timeout = setTimeout(() => {
      reject(new Error("WebSocket connection timeout"));
    }, 10000);
    const checkInterval = setInterval(() => {
      if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve();
      } else if (!S.ws || S.ws.readyState === WebSocket.CLOSED) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        reject(new Error("WebSocket connection failed"));
      }
    }, 50);
  });
}

/**
 * Manually trigger reconnection (e.g., from the Reconnect button).
 * Resets backoff delay for immediate retry.
 */
export function manualReconnect() {
  reconnectDelay = RECONNECT_DELAY_INITIAL;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connectWebSocket();
}
// Expose for the onclick handler on the button
window.__reconnectWS = manualReconnect;

/**
 * Sends a JSON message to the server via WebSocket.
 * @param {Object} message - The message object to send
 */
export function wsSend(message) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(message));
  } else {
    showError("Not connected to server. Reconnecting…", false);
    dom.connectionStatus.textContent = "Disconnected";
    dom.connectionStatus.style.color = "var(--text-muted)";
    manualReconnect();
  }
}

/**
 * Sends the audio_format handshake message.
 * Must be sent before start_recording per the protocol contract.
 */
export function sendAudioFormatHandshake() {
  wsSend({
    type: "audio_format",
    channels: 1,
    sampleRate: 16000,
    encoding: "LINEAR16",
  });
  S.audioFormatSent = true;
}

/**
 * Re-sends all client-side session config to the server after a WebSocket
 * reconnect. The server creates a fresh session on each new WS connection,
 * so any consent, video, project context, analysis tier, evaluation style,
 * VAD config, time limit, and operator notes must be replayed. (#165)
 *
 * This is safe to call on first connect too — the server handles idempotent
 * config messages gracefully (they overwrite defaults).
 */
function resyncSessionState() {
  // 1. Consent (the critical one — blocks start_recording)
  if (S.consentSpeakerName || S.consentConfirmed) {
    wsSend({
      type: "set_consent",
      speakerName: S.consentSpeakerName,
      consentConfirmed: S.consentConfirmed,
    });
  }

  // 2. Video consent
  if (S.videoConsentEnabled) {
    wsSend({
      type: "set_video_consent",
      consentGranted: true,
      timestamp: new Date().toISOString(),
    });
    // Re-send video stream ready if camera is active
    if (S.videoStream) {
      const readyMsg = { type: "video_stream_ready", width: 0, height: 0 };
      const tracks = S.videoStream.getVideoTracks();
      if (tracks.length > 0) {
        const settings = tracks[0].getSettings();
        readyMsg.width = settings.width || 0;
        readyMsg.height = settings.height || 0;
        if (tracks[0].label) readyMsg.deviceLabel = tracks[0].label;
      }
      wsSend(readyMsg);
    }
  }

  // 3. Video FPS config (if not default)
  if (S.videoFpsConfig && S.videoFpsConfig !== 2) {
    wsSend({ type: "set_video_config", frameRate: S.videoFpsConfig });
  }

  // 4. Time limit (if not default)
  if (S.configuredTimeLimit && S.configuredTimeLimit !== 180) {
    wsSend({ type: "set_time_limit", seconds: S.configuredTimeLimit });
  }

  // 5. VAD config (if changed from defaults: enabled=true, threshold=5)
  if (!S.vadEnabled || S.vadSilenceThreshold !== 5) {
    wsSend({
      type: "set_vad_config",
      silenceThresholdSeconds: S.vadSilenceThreshold,
      enabled: S.vadEnabled,
    });
  }

  // 6. Project context
  if (S.projectContext && (S.projectContext.speechTitle || S.projectContext.projectType)) {
    wsSend({
      type: "set_project_context",
      speechTitle: S.projectContext.speechTitle,
      projectType: S.projectContext.projectType,
      objectives: S.projectContext.objectives,
    });
  }

  // 7. Analysis tier (if not default)
  if (S.analysisTier && S.analysisTier !== "standard") {
    wsSend({ type: "set_analysis_tier", tier: S.analysisTier });
  }

  // 8. Evaluation style (if not default)
  if (S.evaluationStyle && S.evaluationStyle !== "classic") {
    wsSend({ type: "set_evaluation_style", style: S.evaluationStyle });
  }

  // 9. Operator notes (#164)
  const notesTextarea = document.getElementById("operator-notes");
  if (notesTextarea && notesTextarea.value.trim().length > 0) {
    wsSend({ type: "set_notes", notes: notesTextarea.value });
  }

  // 10. Meeting context (#174)
  if (S.meetingMode && S.meetingAgenda && S.meetingActiveSlotId) {
    wsSend({
      type: "set_meeting_context",
      meetingId: S.meetingAgenda.meetingId,
      slotId: S.meetingActiveSlotId,
      clubName: S.meetingAgenda.clubName || undefined,
    });
  }

  console.log("[WS] Session state resynced after reconnect (#165)");
}

// ─── Stop Speech ──────────────────────────────────────────────────

/**
 * Stops the current speech recording session.
 * Moved here from app.js to eliminate circular import (consent.js → app.js).
 */
export function onStopSpeech() {
  // Stop the AudioWorklet but keep MediaStream alive for potential restart
  stopAudioCapture();

  // Phase 4: Stop video frame capture (camera stays alive for potential restart)
  stopVideoCapture();
  // Sprint C2: Stop Vision capture (#128)
  stopVisionCapture();

  // Send stop_recording command to server
  wsSend({ type: "stop_recording" });

  // Optimistic UI update
  updateUI(SessionState.PROCESSING);
}

// ─── Server Message Handler ───────────────────────────────────────

/**
 * Routes incoming server messages to the appropriate handler.
 * @param {Object} message - Parsed ServerMessage
 */
export function handleServerMessage(message) {
  switch (message.type) {
    case "state_change":
      handleStateChange(message.state);
      break;
    case "transcript_update":
      updateTranscript(message.segments, message.replaceFromIndex);
      break;
    case "elapsed_time":
      updateElapsedTime(message.seconds);
      break;
    case "evaluation_ready":
      S.lastEvaluationScript = message.script || "";
      S.lastEvaluationData = message.evaluation || null;
      showEvaluation(message.script);
      break;
    case "role_results":
      displayRoleResults(message.results);
      break;
    case "tts_complete":
      handleTTSComplete();
      break;
    case "outputs_saved":
      showSavedConfirmation(message.paths, message.files);
      break;
    case "error":
      // Fail-safe silent mode: if error occurs during TTS delivery,
      // stop playback and show written evaluation as fallback (Req 7.4)
      if (S.currentState === SessionState.DELIVERING) {
        triggerTTSFailSafe();
      } else {
        showError(message.message, message.recoverable);
      }
      break;
    case "audio_format_error":
      // Audio format errors are always non-recoverable; stop capture
      if (S.currentState === SessionState.DELIVERING) {
        triggerTTSFailSafe();
      } else {
        showError("Audio format error: " + message.message, false);
        stopAudioCapture();
      }
      break;
    case "consent_status":
      handleConsentStatus(message.consent);
      break;
    case "duration_estimate":
      handleDurationEstimate(message.estimatedSeconds, message.timeLimitSeconds);
      break;
    case "data_purged":
      handleDataPurged(message.reason);
      break;
    case "pipeline_progress":
      // Ignore stale progress from cancelled pipelines (Hazard 2, Hazard 5)
      if (message.runId < S.pipelineRunId) break;
      S.pipelineRunId = message.runId;
      S.pipelineStage = message.stage;
      updateProcessingIndicator(message.stage);
      updateDeliverButtonState(message.stage);
      break;
    case "vad_speech_end":
      handleVADSpeechEnd(message);
      break;
    case "vad_status":
      handleVADStatus(message);
      break;
    case "video_status":
      // Phase 4: Handle video processing status updates (Req 10.8)
      handleVideoStatus(message);
      break;
    case "transcription_status":
      // Sprint C7: Deepgram reconnection status indicator (#139)
      if (message.status === "reconnecting") {
        showNotification("Live transcription reconnecting…", "warning");
      } else if (message.status === "reconnected") {
        showNotification("Live transcription reconnected", "success");
      } else if (message.status === "failed") {
        showNotification("Live transcription connection lost — evaluation will use post-speech transcript", "warning");
      }
      break;
    case "coaching_cue":
      // Sprint C14: Real-time coaching cues during practice mode (#155)
      showCoachingCue(message);
      break;
    default:
      console.warn("Unknown server message type:", message.type);
  }
}

/**
 * Handles state_change messages from the server.
 * Updates UI and manages audio capture lifecycle based on state transitions.
 * @param {string} newState - The new SessionState
 */
export function handleStateChange(newState) {
  const previousState = S.currentState;

  // Phase 4: Stop video frame capture when leaving RECORDING state (Req 2.1, 2.2)
  // This handles server-initiated transitions (auto-stop, errors) in addition to
  // the explicit stopVideoCapture() calls in onStopSpeech() and onPanicMute().
  if (previousState === SessionState.RECORDING && newState !== SessionState.RECORDING) {
    stopVideoCapture();
    stopVisionCapture();
  }

  // Echo prevention: hard-stop mic when entering DELIVERING state
  if (newState === SessionState.DELIVERING) {
    hardStopMic();
  }

  // If leaving DELIVERING due to panic mute (going to IDLE without tts_complete),
  // force-stop playback. But if S.ttsDeliveryComplete is true, let audio play naturally.
  if (previousState === SessionState.DELIVERING && newState !== SessionState.DELIVERING) {
    if (!S.ttsDeliveryComplete) {
      // Panic mute or error — force stop
      console.log("[TTS] Forced stop: leaving DELIVERING without tts_complete");
      forceStopTtsAndCancelDeferral(); // Clears deferral, bumps token, stops audio, clears S.ttsPlaying
    }
    // If S.ttsDeliveryComplete is true, audio is playing or finished — don't interrupt
  }

  // ── IDLE transition decision chain (explicit else-if to prevent reorder mistakes) ──
  // Branch A: S.ttsPlaying is true → defer
  if (newState === SessionState.IDLE && S.ttsPlaying) {
    if (!S.ttsAudioElement || !S.ttsAudioElement.src) {
      console.warn("[TTS] S.ttsPlaying is true but audio element/src missing — possible bug");
    }
    // Idempotent: don't overwrite an existing deferral
    if (S.deferredIdleTransition === null) {
      S.deferredIdleTransition = { token: S.playbackInstanceToken };
    }
    // Cooldown will start when deferred IDLE is applied
    return; // Do NOT call updateUI yet
  }

  // Branch B: not playing, non-IDLE state → latch (IDLE arrived before audio)
  // Token-stamped: store current S.playbackInstanceToken so handleTTSAudio can
  // verify the latch is from the expected session phase (new token = latch + 1).
  // If handleTTSAudio never runs (e.g., server error, no audio sent), the latch
  // is harmless — transitionToIdle() clears it, and force-stop paths clear it too.
  else if (newState === SessionState.IDLE && !S.ttsPlaying && S.currentState !== SessionState.IDLE) {
    if (S.pendingIdleFromServer === null) {
      S.pendingIdleFromServer = { tokenAtLatch: S.playbackInstanceToken };
    }
    // Don't transition yet — wait for handleTTSAudio to consume the latch
    return;
  }

  // Branch C: not playing, already IDLE or no latch needed → immediate transition
  // All non-deferred IDLE transitions go through transitionToIdle() — single unified path.
  else if (newState === SessionState.IDLE) {
    transitionToIdle();
    return;
  }

  // Branch D: non-IDLE state → pass through
  updateUI(newState);
}

/**
 * Handles incoming TTS audio data (binary WebSocket frames).
 * Creates a Blob URL and plays via HTMLAudioElement for cross-browser
 * compatibility (Safari has issues with Web Audio API decodeAudioData
 * on certain MP3 encodings).
 * @param {ArrayBuffer} audioData - Raw audio bytes from TTS
 */

/**
 * Primes the TTS audio element during a user gesture so the browser
 * grants playback permission. Called from click handlers before the
 * async WebSocket round-trip that delivers the actual audio data.
 *
 * Two-pronged unlock:
 * 1. Resume a shared AudioContext (unlocks Web Audio for the page).
 * 2. Create the Audio element and call play() with an empty src —
 *    even though it fails, the element is now "user-activated" and
 *    subsequent play() calls with real data will succeed.
 */
export function primeTTSAudioElement() {
  cleanupTTSAudio();

  // Unlock the page-level audio policy via AudioContext
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().then(function () {
      ctx.close();
    });
  } catch (e) {
    // AudioContext not available — rely on element priming alone
  }

  // Create the element within the user gesture scope
  S.ttsAudioElement = new Audio();
  S.ttsAudioElement.preload = "auto";
}

export function handleTTSAudio(audioData) {
  S.hasTTSAudio = true;
  S.ttsDeliveryComplete = false;
  if (!audioData || audioData.byteLength === 0) {
    console.warn("[TTS] Received empty audio data, ignoring");
    return;
  }

  console.log("[TTS] Received audio chunk:", audioData.byteLength, "bytes");

  // Create a Blob URL from the audio data
  if (S.ttsBlobUrl) {
    URL.revokeObjectURL(S.ttsBlobUrl);
  }
  const blob = new Blob([audioData], { type: "audio/mpeg" });
  S.ttsBlobUrl = URL.createObjectURL(blob);

  // Reuse the primed element if available, otherwise create a new one
  if (!S.ttsAudioElement) {
    S.ttsAudioElement = new Audio();
    S.ttsAudioElement.preload = "auto";
  }

  // ── MUST-NOT-REFACTOR ORDERING INVARIANT ──
  // The following steps MUST execute in exactly this order. Reordering any
  // step (especially moving latch consumption after play() or after setting
  // S.ttsPlaying) can reintroduce the race condition this fix exists to prevent.
  //
  // Explicit ordering: token++ → capture → consume latch → set handlers → S.ttsPlaying=true → play()

  // 1. Increment token for this new playback instance
  S.playbackInstanceToken++;
  // 2. Capture token for closure
  const currentToken = S.playbackInstanceToken;

  // 3. Consume the S.pendingIdleFromServer latch: if IDLE arrived before this
  // function ran (ordering edge case), create the deferral now, bound to the
  // new token. Token validation: only consume if the latch token matches
  // expected progression (latchToken + 1 === currentToken). This prevents a
  // stale latch from an earlier session phase from "attaching" to unrelated
  // audio (e.g., replay triggered much later after other state changes).
  // If the token doesn't match, the latch is stale — discard it.
  if (S.pendingIdleFromServer !== null) {
    var latchIsRelevant = (S.pendingIdleFromServer.tokenAtLatch + 1 === currentToken);
    S.pendingIdleFromServer = null; // Always clear — consumed or discarded
    if (latchIsRelevant && S.deferredIdleTransition === null) {
      S.deferredIdleTransition = { token: currentToken };
    }
  }

  // 3b. Adopt existing deferral: if a S.deferredIdleTransition was created for
  // a previous playback (e.g., IDLE arrived during playback N, creating deferral
  // with token N, then new audio arrives bumping token to N+1), update the
  // deferral token to the current playback. Without this, the new onended
  // (token N+1) would never match the old deferral (token N), leaving a dead
  // deferral that prevents IDLE transition.
  if (S.deferredIdleTransition !== null && S.deferredIdleTransition.token !== currentToken) {
    S.deferredIdleTransition = { token: currentToken };
  }

  // 4. Set handlers BEFORE play() so they're ready for immediate events
  S.ttsAudioElement.onplay = function () {
    console.log("[TTS] Audio playback started");
  };

  S.ttsAudioElement.onended = function () {
    console.log("[TTS] Audio playback ended naturally");
    // Clean up state FIRST so updateUI sees consistent flags
    S.ttsPlaying = false;
    cleanupTTSAudio();
    // Then apply deferred IDLE (which calls updateUI via transitionToIdle)
    applyDeferredIdle(currentToken);
  };

  S.ttsAudioElement.onerror = function (e) {
    console.error("[TTS] Audio element error:", S.ttsAudioElement ? S.ttsAudioElement.error : e);
    // onerror: triggerTTSFailSafe owns the force-stop internally
    triggerTTSFailSafe();
  };

  // 5. Set S.ttsPlaying=true immediately before play() — covers the decode gap
  S.ttsPlaying = true;

  // 6. Swap in the real audio source and play
  S.ttsAudioElement.src = S.ttsBlobUrl;
  S.ttsAudioElement.play().then(function () {
    console.log("[TTS] play() promise resolved, audio is playing");
  }).catch(function (err) {
    console.error("[TTS] play() promise rejected:", err);
    // play() can reject without firing onerror — triggerTTSFailSafe owns the force-stop
    triggerTTSFailSafe();
  });
}

/**
 * Cleans up TTS audio resources (element and Blob URL).
 */
export function cleanupTTSAudio() {
  if (S.ttsAudioElement) {
    S.ttsAudioElement.onplay = null;
    S.ttsAudioElement.onended = null;
    S.ttsAudioElement.onerror = null;
    S.ttsAudioElement.pause();
    S.ttsAudioElement.src = "";
    S.ttsAudioElement = null;
  }
  if (S.ttsBlobUrl) {
    URL.revokeObjectURL(S.ttsBlobUrl);
    S.ttsBlobUrl = null;
  }
}

/**
 * Stops all TTS audio playback and cleans up resources.
 * Nulls out event handlers BEFORE pausing to prevent lingering handlers
 * from firing on reused elements and to reduce reentrancy risk.
 */
export function stopTTSPlayback() {
  // Null out event handlers first — prevents onended/onerror from firing
  // during pause/cleanup, which could cause reentrancy issues
  if (S.ttsAudioElement) {
    S.ttsAudioElement.onended = null;
    S.ttsAudioElement.onerror = null;
    S.ttsAudioElement.onplay = null;
  }
  cleanupTTSAudio();
  S.ttsPlaying = false;
  S.ttsDeliveryComplete = false;
}

/**
 * Applies a deferred IDLE transition if the token matches.
 * Called from onended handler after S.ttsPlaying and cleanup are done.
 *
 * No-op cases (both are safe and expected):
 * - S.deferredIdleTransition is null (no deferral was pending — e.g., audio ended
 *   before state_change: idle arrived, or deferral was already cancelled)
 * - Token mismatch (stale onended from a previous/cancelled playback)
 *
 * Clears S.deferredIdleTransition BEFORE calling transitionToIdle() — this ordering
 * prevents reentrancy (e.g., duplicate onended) from re-running transitionToIdle().
 *
 * @param {number} token - The playback instance token from the onended closure
 */
export function applyDeferredIdle(token) {
  if (S.deferredIdleTransition === null) return; // No deferral pending — no-op
  if (S.deferredIdleTransition.token !== token) return; // Stale event — ignore

  S.deferredIdleTransition = null;
  transitionToIdle();
}

/**
 * Single authoritative function for transitioning to IDLE with cooldown.
 * ALL code paths that transition to IDLE must go through this function —
 * including triggerTTSFailSafe(), applyDeferredIdle(), and handleStateChange().
 * This prevents double-cooldown, missing-cooldown, and micro-hiccup bugs.
 *
 * Order: clear S.pendingIdleFromServer first, then updateUI (pure visual state flip),
 * then startCooldown (timers/side effects). This prevents micro-hiccups from
 * cooldown DOM/timer work before the UI state is consistent.
 *
 * Idempotency guard: S.currentState === SessionState.IDLE && S.cooldownTimer !== null
 * — precise enough to distinguish "IDLE with cooldown active" (no-op) from
 * "IDLE without cooldown" (needs cooldown start, e.g., recovery paths).
 * Using just S.currentState === IDLE would skip cooldown in legitimate cases.
 */
export function transitionToIdle() {
  // Precise idempotency: skip only if already IDLE AND cooldown is running.
  // If IDLE but no cooldown (recovery path), we still need to start cooldown.
  if (S.currentState === SessionState.IDLE && S.cooldownTimer !== null) return;
  S.pendingIdleFromServer = null; // Clear latch — we're applying IDLE now
  // Mark meeting slot as completed when returning to IDLE (#174)
  if (S.meetingMode && S.meetingActiveSlotId) {
    completeActiveSlot();
  }
  updateUI(SessionState.IDLE);
  startCooldown();
}

/**
 * Cancels any pending deferred IDLE transition and invalidates the current
 * playback token so that late onended events from a previous playback
 * cannot apply a future deferral.
 *
 * DOES NOT clear S.ttsPlaying or stop playback — that is the responsibility
 * of stopTTSPlayback(). DOES NOT clear S.pendingIdleFromServer — that is
 * cleared by forceStopTtsAndCancelDeferral() or transitionToIdle().
 * Use forceStopTtsAndCancelDeferral() for force-stop paths.
 *
 * Called internally by forceStopTtsAndCancelDeferral().
 */
export function cancelDeferredIdle() {
  S.deferredIdleTransition = null;
  // Monotonic bump: any in-flight onended closure holding the old token
  // will fail the token match in applyDeferredIdle()
  S.playbackInstanceToken++;
}

/**
 * Composite force-stop: cancels deferral, bumps token, clears latch, stops audio,
 * clears S.ttsPlaying.
 *
 * Post-conditions hold immediately after the call:
 * - S.deferredIdleTransition === null
 * - S.pendingIdleFromServer === null
 * - S.playbackInstanceToken bumped (late onended events are harmless due to token
 *   invalidation + handler nulling in stopTTSPlayback)
 * - S.ttsPlaying === false
 * - audio element event handlers nulled
 *
 * Note: this is NOT truly atomic against queued browser events — a late onended
 * CAN still fire after this call returns. That is safe because the token bump +
 * handler nulling ensures late callbacks are no-ops. Do not assume "no late
 * callbacks possible"; assume "late callbacks are harmless."
 *
 * ALL force-stop paths (panic mute, revoke consent, S.ws close, onerror, play reject)
 * MUST call this instead of calling cancelDeferredIdle() and stopTTSPlayback() separately.
 */
export function forceStopTtsAndCancelDeferral() {
  cancelDeferredIdle();          // Clear deferral + bump token
  S.pendingIdleFromServer = null;  // Clear latch
  stopTTSPlayback();             // Stop audio + clear S.ttsPlaying + null handlers
}

/**
 * Fail-safe silent mode: stops TTS playback, shows written evaluation
 * as fallback, and transitions UI to IDLE. No automatic retry.
 * Per meeting-safety-controls.md: if any critical error occurs during
 * TTS delivery, playback stops immediately and the written evaluation
 * is displayed as fallback.
 *
 * Contract: calls forceStopTtsAndCancelDeferral() internally (idempotent if
 * already stopped), shows written evaluation panel, then calls transitionToIdle().
 * Callers never need to force-stop before calling this — single entry point,
 * no double-stop/double-cooldown risk.
 */
export function triggerTTSFailSafe() {
  forceStopTtsAndCancelDeferral();

  // Show the written evaluation as fallback (Requirement 7.4)
  if (S.lastEvaluationScript) {
    showEvaluation(S.lastEvaluationScript);
  }
  show(dom.evaluationPanel);

  // Show a non-recoverable error explaining the fallback
  showError("Audio playback failed. The written evaluation is displayed below.", false);

  // Transition UI to IDLE via single authoritative path
  transitionToIdle();
}

/**
 * Handles tts_complete message — TTS delivery finished on the server side.
 * Does NOT stop playback — the audio may still be playing.
 * Sets a flag so the client knows no more chunks are coming.
 */
export function handleTTSComplete() {
  console.log("[TTS] Server signaled tts_complete, audio may still be playing");
  S.ttsDeliveryComplete = true;
}

// ─── Phase 2: Consent, Duration, and Purge Handlers ──────────────

/**
 * Handles consent_status message from the server.
 * Updates local consent state and UI.
 * @param {Object|null} consent - ConsentRecord or null
 */
export function handleConsentStatus(consent) {
  if (consent) {
    S.consentSpeakerName = consent.speakerName || "";
    S.consentConfirmed = consent.consentConfirmed || false;
    // Sync form inputs with server state
    dom.speakerNameInput.value = S.consentSpeakerName;
    dom.consentCheckbox.checked = S.consentConfirmed;
  } else {
    S.consentSpeakerName = "";
    S.consentConfirmed = false;
    dom.speakerNameInput.value = "";
    dom.consentCheckbox.checked = false;
  }
  updateUI(S.currentState);
}

/**
 * Handles duration_estimate message from the server.
 * Updates the duration estimate display.
 * @param {number} estimatedSeconds - Estimated evaluation duration
 * @param {number} timeLimitSeconds - Configured time limit
 */
export function handleDurationEstimate(estimatedSeconds, timeLimitSeconds) {
  S.estimatedDuration = estimatedSeconds;
  S.configuredTimeLimit = timeLimitSeconds;
  dom.timeLimitInput.value = timeLimitSeconds;
  updateDurationEstimateDisplay(estimatedSeconds, timeLimitSeconds);
  // Show the estimate if we're in PROCESSING state
  if (S.currentState === SessionState.PROCESSING) {
    show(dom.durationEstimate);
  }
}

/**
 * Handles data_purged message from the server.
 * Clears all displayed data and updates UI based on purge reason.
 * @param {string} reason - "opt_out" or "auto_purge"
 */
export function handleDataPurged(reason) {
  // Clear all displayed data
  S.segments = [];
  renderTranscript();
  dom.evaluationContent.innerHTML =
    '<div class="evaluation-empty">Evaluation will appear here after delivery...</div>';
  hide(dom.evaluationPanel);
  hide(dom.transcriptPanel);
  S.hasEvaluationData = false;
  S.hasTTSAudio = false;
  S.lastEvaluationScript = "";
  S.lastEvaluationData = null;
  S.lastVideoQualityGrade = null;
  S.estimatedDuration = null;
  hide(dom.durationEstimate);
  forceStopTtsAndCancelDeferral();
  // Reset pipeline state on data purge (Req 6.3)
  S.pipelineStage = "idle";
  S.pipelineRunId = 0;
  // Clear evidence highlights (Phase 3)
  clearEvidenceHighlight();
  // Hide video quality grade badge
  if (videoDom.qualityGrade) {
    videoDom.qualityGrade.className = "video-quality-grade";
  }

  if (reason === "opt_out") {
    // Permanent purge — disable Save Outputs for this session
    S.dataPurged = true;
    // Reset consent form
    S.consentSpeakerName = "";
    S.consentConfirmed = false;
    dom.speakerNameInput.value = "";
    dom.consentCheckbox.checked = false;
    // Clear persisted form state on consent revocation (#58)
    clearFormState();
    S.videoConsentEnabled = false;
    S.videoStreamReady = false;
    dom.videoConsentCheckbox.checked = false;
    disable(dom.videoConsentCheckbox);
    hideVideoConsentError();
    releaseCamera();
    // Reset video FPS config to default
    S.videoFpsConfig = 2;
    dom.videoFpsSlider.value = 2;
    dom.videoFpsValue.textContent = "2 FPS";
    // Reset VAD config to defaults (Phase 3, Req 3.1, 3.5)
    S.vadEnabled = true;
    S.vadSilenceThreshold = 5;
    dom.vadEnabledCheckbox.checked = true;
    dom.vadThresholdSlider.value = 5;
    dom.vadThresholdValue.textContent = "5s";
    resetVadEnergyState();
    // Reset project context form (Phase 3, Req 4.1)
    resetProjectContextForm();
    // Show opt-out purge banner
    dom.purgeMessage.textContent = "Speaker data has been purged per opt-out request.";
    dom.purgeBanner.className = "purge-banner visible opt-out";
  } else if (reason === "auto_purge") {
    // Auto-purge — informational
    // Reset video consent (Phase 4)
    S.videoConsentEnabled = false;
    S.videoStreamReady = false;
    dom.videoConsentCheckbox.checked = false;
    disable(dom.videoConsentCheckbox);
    hideVideoConsentError();
    releaseCamera();
    // Reset video FPS config to default
    S.videoFpsConfig = 2;
    dom.videoFpsSlider.value = 2;
    dom.videoFpsValue.textContent = "2 FPS";
    // Reset VAD config to defaults (Phase 3)
    S.vadEnabled = true;
    S.vadSilenceThreshold = 5;
    dom.vadEnabledCheckbox.checked = true;
    dom.vadThresholdSlider.value = 5;
    dom.vadThresholdValue.textContent = "5s";
    resetVadEnergyState();
    // Reset project context form (Phase 3)
    resetProjectContextForm();
    dom.purgeMessage.textContent = "Session data auto-purged after timeout.";
    dom.purgeBanner.className = "purge-banner visible auto-purge";
  }

  // Transition to IDLE via single authoritative path
  transitionToIdle();
}

