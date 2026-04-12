/**
 * Main application entry point — wires modules, event listeners, init.
 * This is the top-level module loaded by index.html.
 * (#110)
 */
import { S, dom, videoDom } from "./state.js";
import { SessionState, STATUS_TEXT, PROJECT_TYPES, MAX_UPLOAD_SIZE_MB, COOLDOWN_MS } from "./constants.js";
import { show, hide, enable, disable, formatTimestamp, escapeHtml } from "./utils.js";
import {
  updateUI, updateAudioLevel, handleVADStatus, checkVadEnergyFallback,
  resetVadEnergyState, updateElapsedTime, updateConsentStatusDisplay,
  updateDurationEstimateDisplay, updateProcessingIndicator, updateDeliverButtonState,
  dismissVADNotification, showError, dismissError, showSavedConfirmation,
  showInterruptionBanner, showNotification, showElapsedTime, hideElapsedTime,
} from "./ui.js";
import {
  restoreFormState, clearFormState, onConsentChange, onVideoConsentChange,
  showVideoConsentError, hideVideoConsentError, onVideoFpsChange, onVideoFpsInput,
  onTimeLimitChange, handleVADSpeechEnd, onVADConfirmStop, onVADDismiss,
  onVADConfigChange, onVADThresholdInput, onSpeechTitleChange, onProjectTypeChange,
  onObjectivesChange, resetProjectContextForm, onAnalysisTierChange, onEvaluationStyleChange,
  onNotesChange,
} from "./consent.js";
import { updateTranscript, showEvaluation, displayRoleResults, clearEvidenceHighlight } from "./transcript.js";
import { checkMicPermission, startAudioCapture, stopAudioCapture, hardStopMic, startCooldown, clearCooldown } from "./audio.js";
import {
  acquireCamera, onCameraFlip, startVideoCapture, stopVideoCapture,
  releaseCamera, toggleVideoSize, handleVideoStatus, showVideoQualityGrade,
  startVisionCapture, stopVisionCapture,
} from "./video.js";
import { onFileSelected, onFormFileSelected } from "./upload.js";
import { loadHistory, resetHistory, isHistoryLoaded, loadMeetingHistory } from "./history.js";
import { updateTierCostLabels } from "./tier-costs.js";
import { initSetupWizard } from "./setup-wizard.js";
import { initMeetingPanel, completeActiveSlot } from "./meeting.js";
import {
  connectWebSocket, connectWebSocketAndWait, manualReconnect,
  wsSend, sendAudioFormatHandshake, forceStopTtsAndCancelDeferral,
  primeTTSAudioElement, onStopSpeech,
} from "./websocket.js";

// ─── Sign Out ──────────────────────────────────────────────────────
function signOut() {
  document.cookie = "__session=;path=/;max-age=0";
  window.location.href = "/login.html?action=signout";
}

// ─── Clerk Session Refresh (#165) ──────────────────────────────────
// Load the Clerk JS SDK to keep the __session cookie alive.
// Clerk's __session JWT expires every ~60s. The SDK refreshes it
// continuously in the background. Without this, WebSocket upgrades
// fail with 401 because the cookie goes stale.
async function initClerkSession() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    if (!config.publishableKey) return;

    // Decode Clerk Frontend API host from the publishable key
    const encodedHost = config.publishableKey.replace(/^pk_(test|live)_/, "");
    const clerkHost = atob(encodedHost).replace(/\$+$/, "");

    // Load Clerk JS (same approach as login.js)
    const script = document.createElement("script");
    script.src = "https://" + clerkHost + "/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
    script.dataset.clerkPublishableKey = config.publishableKey;
    script.crossOrigin = "anonymous";
    script.async = true;

    script.onload = async function () {
      try {
        const clerk = window.Clerk;
        if (!clerk) return;
        await clerk.load();
        console.log("[Clerk] Session refresh active");

        // If Clerk detects user signed out, redirect to login
        clerk.addListener(function () {
          if (!clerk.user) {
            window.location.href = "/login.html";
          }
        });
      } catch (err) {
        console.warn("[Clerk] Session init error:", err);
      }
    };
    document.head.appendChild(script);
  } catch (err) {
    console.warn("[Clerk] Failed to load config for session refresh:", err);
  }
}

// ─── Load User Info (Issue #41) ──────────────────────────────────
function loadUserInfo() {
  fetch("/api/me")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data) return;

      var userInfoEl = document.getElementById("user-info");
      var avatarEl = document.getElementById("user-avatar");
      var initialsEl = document.getElementById("user-initials");
      var nameEl = document.getElementById("user-name");

      // Show display name or email
      nameEl.textContent = data.name || data.email;

      // Show avatar photo or initials fallback
      if (data.picture) {
        avatarEl.src = data.picture;
        avatarEl.style.display = "block";
        avatarEl.onerror = function () {
          avatarEl.style.display = "none";
          showInitials(initialsEl, data.name || data.email);
        };
      } else {
        showInitials(initialsEl, data.name || data.email);
      }

      userInfoEl.style.display = "flex";

      // Auto-populate speaker name from signed-in user (#163)
      // Only fill if the field is still empty (respect localStorage restore or manual input)
      if (data.name && dom.speakerNameInput && !dom.speakerNameInput.value.trim()) {
        dom.speakerNameInput.value = data.name;
        onConsentChange(); // trigger consent state update
      }
    })
    .catch(function () { /* silently ignore — user info is non-critical */ });
}

function showInitials(el, nameOrEmail) {
  var parts = nameOrEmail.split(/[\s@]/);
  var initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : nameOrEmail.substring(0, 2).toUpperCase();
  el.textContent = initials;
  el.style.display = "inline-block";
}

loadUserInfo();
initClerkSession(); // Keep __session cookie alive for WS auth (#165)

// ─── Meeting Roles (Phase 9, #72) ──────────────────────────────────

async function loadRoles() {
  try {
    const res = await fetch("/api/roles");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.roles || data.roles.length === 0) return;

    const container = document.getElementById("role-checkboxes");
    const selector = document.getElementById("config-roles");

    for (const role of data.roles) {
      const div = document.createElement("div");
      div.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 0;";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `role-${role.id}`;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          S.activeRoles.add(role.id);
        } else {
          S.activeRoles.delete(role.id);
        }
        // Send updated active roles to server via WebSocket
        wsSend({ type: "set_active_roles", roleIds: Array.from(S.activeRoles) });
      });

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.style.cssText = "cursor:pointer; font-size:0.9em;";
      label.innerHTML = `<strong>${role.name}</strong> — ${role.description}`;

      div.appendChild(checkbox);
      div.appendChild(label);
      container.appendChild(div);
    }

    selector.style.display = "block";
  } catch (e) {
    console.warn("[Roles] Failed to load roles:", e);
  }
}
loadRoles();

// ─── Button Click Handlers ────────────────────────────────────────

async function onStartSpeech() {
  // Guard: immediately disable to prevent double-click (#29)
  disable(dom.btnStart);

  // Guard: don't start during cooldown
  if (S.inCooldown) { enable(dom.btnStart); return; }

  // Guard: consent must be confirmed (Req 2.3)
  if (!S.consentConfirmed || S.consentSpeakerName.trim().length === 0) {
    showError("Please enter the speaker's name and confirm consent before starting.", true);
    enable(dom.btnStart);
    return;
  }

  // Connect WebSocket on demand (deferred from page load per #59)
  S.liveSessionActive = true;
  try {
    await connectWebSocketAndWait();
  } catch (err) {
    showError("Could not connect to server. Please try again.", true);
    S.liveSessionActive = false;
    enable(dom.btnStart);
    return;
  }

  // Reset state for new recording
  S.segments = [];
  S.hasEvaluationData = false;
  S.hasTTSAudio = false;
  S.outputsSaved = false;
  S.dataPurged = false;
  S.estimatedDuration = null;
  S.lastEvaluationScript = "";
  S.lastEvaluationData = null;
  // Reset pipeline state for new recording (Req 2.5, 6.3)
  S.pipelineStage = "idle";
  S.pipelineRunId = 0;
  forceStopTtsAndCancelDeferral();
  dismissError();
  hideVideoConsentError();
  clearEvidenceHighlight();
  hide(dom.interruptionBanner);
  hide(dom.savedConfirmation);
  hide(dom.purgeBanner);
  hide(dom.durationEstimate);
  dom.evaluationContent.innerHTML =
    '<div class="evaluation-empty">Evaluation will appear here after delivery...</div>';
  hide(dom.evaluationPanel);

  // Ensure audio format handshake was sent
  if (!S.audioFormatSent) {
    sendAudioFormatHandshake();
  }

  // Send start_recording command to server BEFORE starting audio capture
  // so server is in RECORDING state when binary frames arrive
  wsSend({ type: "start_recording" });

  // Transition to RECORDING state BEFORE starting audio capture (#165)
  // AudioWorklet fires onmessage immediately — the guard at audio.js:75
  // checks S.currentState === RECORDING. If state is still IDLE, every
  // audio chunk is silently dropped.
  updateUI(SessionState.RECORDING);
  updateElapsedTime(0);

  // Start audio capture (mic + AudioWorklet)
  const captureStarted = await startAudioCapture();
  if (!captureStarted) {
    // Revert state on failure
    updateUI(SessionState.IDLE);
    return; // Error already shown by startAudioCapture
  }

  // Phase 4: Camera is already acquired via video consent toggle (Req 1.5)
  // Only start video capture if video consent is enabled and camera is ready

  if (S.videoConsentEnabled && S.videoStream) {
    startVideoCapture();
  }

  // Sprint C2: Start Vision frame capture if tier has vision enabled (#128)
  startVisionCapture();

  // Practice mode: 5-minute auto-stop timer (#146)
  if (S.currentMode === "practice") {
    clearTimeout(S.practiceAutoStopTimer);
    S.practiceAutoStopTimer = setTimeout(() => {
      if (S.currentState === SessionState.RECORDING) {
        showNotification("Practice time limit (5 minutes) reached — auto-stopping.");
        onStopSpeech();
      }
    }, 5 * 60 * 1000);
  }
}



async function onDeliverEvaluation() {
  // Echo prevention: hard-stop mic tracks before TTS delivery
  hardStopMic();

  // Prime the audio element during the user gesture so the browser
  // grants playback permission. The real TTS source is swapped in
  // when the WebSocket delivers the audio data.
  primeTTSAudioElement();

  // Send deliver_evaluation command to server
  wsSend({ type: "deliver_evaluation" });

  // Optimistic UI update
  updateUI(SessionState.DELIVERING);
}

async function onReplayEvaluation() {
  // Guard: don't replay during cooldown
  if (S.inCooldown) return;

  // Echo prevention: hard-stop mic before replay (same as initial delivery)
  hardStopMic();

  // Prime the audio element during the user gesture (same as deliver)
  primeTTSAudioElement();

  // Send replay_tts command to server
  wsSend({ type: "replay_tts" });

  // Optimistic UI update to DELIVERING state
  updateUI(SessionState.DELIVERING);
}

// ─── Mode Switching (#68) ─────────────────────────────────────────

function switchMode(mode) {
  S.currentMode = mode;
  const tabLive = document.getElementById("tab-live");
  const tabUpload = document.getElementById("tab-upload");
  const tabPractice = document.getElementById("tab-practice");
  const tabHistory = document.getElementById("tab-history");
  const btnStart = document.getElementById("btn-start");
  const btnUpload = document.getElementById("btn-upload");
  const btnPanic = document.getElementById("btn-panic");
  const videoContainer = document.querySelector(".video-preview-container");
  const historyPanel = document.getElementById("history-panel");
  const controlsEl = document.querySelector(".controls");
  const transcriptPanel = document.getElementById("transcript-panel");
  const evaluationPanel = document.getElementById("evaluation-panel");
  // Practice mode hides advanced config sections
  const projectContextForm = document.getElementById("project-context-form");
  const videoConsentRow = document.getElementById("video-consent-row");
  const evalStyleConfig = document.getElementById("evaluation-style-config");
  const practiceLabel = document.getElementById("practice-mode-label");

  // Update tab active states
  tabLive.classList.toggle("active", mode === "live");
  tabUpload.classList.toggle("active", mode === "upload");
  if (tabPractice) tabPractice.classList.toggle("active", mode === "practice");
  if (tabHistory) tabHistory.classList.toggle("active", mode === "history");

  if (mode === "live" || mode === "practice") {
    btnStart.classList.remove("hidden");
    btnPanic.classList.remove("hidden");
    btnUpload.classList.add("hidden");
    if (videoContainer) videoContainer.classList.toggle("visible", mode === "live");
    if (historyPanel) historyPanel.style.display = "none";
    if (controlsEl) controlsEl.style.display = "";
    if (transcriptPanel) transcriptPanel.style.display = "";
    if (evaluationPanel) evaluationPanel.style.display = "";

    // Practice mode: simplify UI — hide project context, video, eval style
    const isPractice = mode === "practice";
    if (projectContextForm) projectContextForm.style.display = isPractice ? "none" : "";
    if (videoConsentRow) videoConsentRow.style.display = isPractice ? "none" : "";
    if (evalStyleConfig) evalStyleConfig.style.display = isPractice ? "none" : "";
    if (practiceLabel) practiceLabel.style.display = isPractice ? "block" : "none";

    // Notify server of session mode
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      wsSend({ type: "set_session_mode", mode: isPractice ? "practice" : "live" });
    }
  } else if (mode === "upload") {
    btnStart.classList.add("hidden");
    btnPanic.classList.add("hidden");
    btnUpload.classList.remove("hidden");
    if (videoContainer) videoContainer.classList.remove("visible");
    if (historyPanel) historyPanel.style.display = "none";
    if (controlsEl) controlsEl.style.display = "";
    if (transcriptPanel) transcriptPanel.style.display = "";
    if (evaluationPanel) evaluationPanel.style.display = "";
    // Restore hidden sections
    if (projectContextForm) projectContextForm.style.display = "";
    if (videoConsentRow) videoConsentRow.style.display = "";
    if (evalStyleConfig) evalStyleConfig.style.display = "";
    if (practiceLabel) practiceLabel.style.display = "none";
  } else if (mode === "history") {
    btnStart.classList.add("hidden");
    btnPanic.classList.add("hidden");
    btnUpload.classList.add("hidden");
    if (videoContainer) videoContainer.classList.remove("visible");
    if (historyPanel) historyPanel.style.display = "block";
    if (controlsEl) controlsEl.style.display = "none";
    if (transcriptPanel) transcriptPanel.style.display = "none";
    if (evaluationPanel) evaluationPanel.style.display = "none";
    if (practiceLabel) practiceLabel.style.display = "none";

    // Auto-load all evaluations history (#184)
    if (!isHistoryLoaded()) {
      loadHistory();
    }
    // Load meeting history (#176)
    loadMeetingHistory();
  }
}

// ─── PDF Export (#71) ────────────────────────────────────────────────
function onExportPDF() {
  // Use browser print dialog with CSS print stylesheet
  // This captures the evaluation panel, transcript, and role results
  const originalTitle = document.title;
  const speakerName = S.consentSpeakerName || "Speech";
  const date = new Date().toISOString().slice(0, 10);
  document.title = `${speakerName} - Evaluation - ${date}`;

  window.print();
  document.title = originalTitle;
}

function onSaveOutputs() {
  // Guard: don't save if data was purged
  if (S.dataPurged) return;

  // Send save_outputs command to server
  wsSend({ type: "save_outputs" });
  disable(dom.btnSave);
}

function onRevokeConsent() {
  // Confirmation dialog per privacy-and-retention.md and meeting-safety-controls.md
  const confirmed = window.confirm(
    "This will permanently delete all data from this speech. Continue?"
  );
  if (!confirmed) return;

  // Hard-stop mic if recording
  hardStopMic();
  // Phase 4: Release camera on consent revocation
  releaseCamera();
  // Clear speech recording (#60)
  S.speechRecordingChunks = [];
  S.speechRecordingBlob = null;
  // Atomic: cancel deferral + bump token + stop audio + clear S.ttsPlaying + clear latch
  forceStopTtsAndCancelDeferral();
  clearCooldown();

  // Send revoke_consent command to server
  wsSend({ type: "revoke_consent" });

  // The server will respond with data_purged message which handles the rest
}

function onPanicMute() {
  // Panic mute: immediate action, no confirmation dialog
  // Hard-stop mic immediately
  hardStopMic();
  // Phase 4: Stop video capture immediately
  stopVideoCapture();
  // Sprint C2: Stop Vision capture (#128)
  stopVisionCapture();
  // Clear speech recording (#60)
  S.speechRecordingChunks = [];
  S.speechRecordingBlob = null;
  // Atomic: cancel deferral + bump token + stop audio + clear S.ttsPlaying + clear latch
  forceStopTtsAndCancelDeferral();
  clearCooldown();
  // Reset pipeline state on panic mute (Req 6.3)
  S.pipelineStage = "idle";
  S.pipelineRunId = 0;

  // Send panic_mute command to server
  wsSend({ type: "panic_mute" });

  // Optimistic UI update
  updateUI(SessionState.IDLE);
  showInterruptionBanner();
}

// ─── Initialize ───────────────────────────────────────────────────
// Set initial UI state and establish WebSocket connection
updateUI(SessionState.IDLE);

// Restore form state from localStorage (#58)
restoreFormState();

// Apply URL parameters for deep linking from Red Club (#196)
// URL params override localStorage (user clicked a specific link)
(function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const speaker = params.get("speaker");
  const title = params.get("title");
  const project = params.get("project");

  if (speaker) {
    S.consentSpeakerName = speaker;
    if (dom.speakerNameInput) dom.speakerNameInput.value = speaker;
  }
  if (title) {
    S.projectContext.speechTitle = title;
    if (dom.speechTitleInput) dom.speechTitleInput.value = title;
  }
  if (project) {
    S.projectContext.projectType = project;
    if (dom.projectTypeSelect) dom.projectTypeSelect.value = project;
  }
})();

// Re-evaluate UI after form restore — consent state may enable Start Speech (#165)
updateUI(SessionState.IDLE);

// Initialize meeting mode panel (#174)
initMeetingPanel();

// Show setup wizard for first-time users (#156)
initSetupWizard();

// ─── Theme Toggle (#56) ──────────────────────────────────────────
const themeToggleBtn = document.getElementById("theme-toggle");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggleBtn.textContent = theme === "light" ? "☀️" : "🌙";
  themeToggleBtn.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  try { localStorage.setItem("speech-evaluator-theme", theme); } catch (e) { /* ignore */ }
}
// Initialize: localStorage > prefers-color-scheme > dark default
const savedTheme = (() => { try { return localStorage.getItem("speech-evaluator-theme"); } catch (e) { return null; } })();
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(savedTheme || (prefersDark ? "dark" : "light"));
themeToggleBtn.addEventListener("click", function () {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// WebSocket is connected on demand when "Start Speech" is clicked (#59)
dom.connectionStatus.textContent = "Ready";
dom.connectionStatus.style.color = "var(--text-muted)";

// Check mic availability on load (non-blocking)
checkMicPermission();

// Fetch and display app version in footer
fetch("/api/version")
  .then(function (r) { return r.json(); })
  .then(function (data) {
    if (data.version) {
      document.getElementById("app-footer").textContent =
        "AI Speech Evaluator \u2014 v" + data.version;
    }
  })
  .catch(function () { /* footer stays as default text */ });

// ─── Phase 2: Consent & Time Limit Event Listeners ────────────────
// Listen for consent form changes
dom.speakerNameInput.addEventListener("input", onConsentChange);
dom.consentCheckbox.addEventListener("change", onConsentChange);

// Listen for time limit changes
dom.timeLimitInput.addEventListener("change", onTimeLimitChange);

// Phase 3: Listen for VAD config changes
dom.vadEnabledCheckbox.addEventListener("change", onVADConfigChange);
dom.vadThresholdSlider.addEventListener("change", onVADConfigChange);
dom.vadThresholdSlider.addEventListener("input", onVADThresholdInput);

// Phase 3: Listen for project context form changes
dom.speechTitleInput.addEventListener("input", onSpeechTitleChange);
dom.projectTypeSelect.addEventListener("change", onProjectTypeChange);
dom.objectivesTextarea.addEventListener("input", onObjectivesChange);

// Analysis Tier: listen for radio button changes (#125)
document.querySelectorAll('input[name="analysis-tier"]').forEach(radio => {
  radio.addEventListener("change", () => {
    onAnalysisTierChange();
    updateTierCostLabels();
  });
});

// Evaluation Style: listen for radio button changes (#133)
document.querySelectorAll('input[name="evaluation-style"]').forEach(radio => {
  radio.addEventListener("change", onEvaluationStyleChange);
});

// Initialize tier cost labels
updateTierCostLabels();

// Operator Notes: listen for input events (#164)
const operatorNotesTextarea = document.getElementById("operator-notes");
if (operatorNotesTextarea) {
  operatorNotesTextarea.addEventListener("input", onNotesChange);
}

// Phase 4: Listen for video consent and FPS config changes
dom.videoConsentCheckbox.addEventListener("change", onVideoConsentChange);
dom.videoFpsSlider.addEventListener("change", onVideoFpsChange);
dom.videoFpsSlider.addEventListener("input", onVideoFpsInput);


// ─── Button Event Listeners (migrated from inline onclick, #110) ──
document.getElementById("btn-reconnect").addEventListener("click", function () {
  if (window.__reconnectWS) window.__reconnectWS();
});
document.getElementById("btn-signout").addEventListener("click", signOut);
document.getElementById("btn-dismiss-error").addEventListener("click", dismissError);
document.getElementById("btn-attach-form").addEventListener("click", function () {
  document.getElementById("form-file-input").click();
});
document.getElementById("btn-vad-confirm").addEventListener("click", onVADConfirmStop);
document.getElementById("btn-vad-dismiss").addEventListener("click", onVADDismiss);
document.getElementById("btn-camera-flip").addEventListener("click", onCameraFlip);
document.getElementById("btn-video-toggle").addEventListener("click", toggleVideoSize);
document.getElementById("tab-live").addEventListener("click", function () { switchMode("live"); });
document.getElementById("tab-upload").addEventListener("click", function () { switchMode("upload"); });
document.getElementById("tab-practice").addEventListener("click", function () { switchMode("practice"); });
document.getElementById("tab-history").addEventListener("click", function () { switchMode("history"); });
document.getElementById("history-load-more").addEventListener("click", function () {
  const speaker = S.consentSpeakerName || "";
  if (speaker) loadHistory(speaker);
});
document.getElementById("btn-start").addEventListener("click", onStartSpeech);
document.getElementById("btn-upload").addEventListener("click", function () {
  document.getElementById("upload-file-input").click();
});
document.getElementById("upload-file-input").addEventListener("change", onFileSelected);
document.getElementById("form-file-input").addEventListener("change", onFormFileSelected);
document.getElementById("btn-stop").addEventListener("click", onStopSpeech);
document.getElementById("btn-deliver").addEventListener("click", onDeliverEvaluation);
document.getElementById("btn-replay").addEventListener("click", onReplayEvaluation);
document.getElementById("btn-save").addEventListener("click", onSaveOutputs);
document.getElementById("btn-pdf").addEventListener("click", onExportPDF);
document.getElementById("btn-revoke").addEventListener("click", onRevokeConsent);
document.getElementById("btn-panic").addEventListener("click", onPanicMute);

// Set initial mode state (#68)
switchMode("live");

