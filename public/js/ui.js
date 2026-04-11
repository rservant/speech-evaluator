/**
 * UI Update Functions — state machine, error display, notifications, ZIP download.
 * Extracted from app.js for ES module pattern (#110).
 */
import { S, dom, videoDom } from "./state.js";
import { SessionState, STATUS_TEXT } from "./constants.js";
import { show, hide, enable, disable } from "./utils.js";

// ─── UI Update: Main State Machine ────────────────────────────────
/**
 * Updates the entire UI based on the current session state.
 * Shows/hides buttons, indicators, and panels according to the
 * state machine defined in the design document.
 *
 * @param {string} state - One of SessionState values
 */
export function updateUI(state) {
  S.currentState = state;

  // Update status indicator
  dom.statusIndicator.className = "status-indicator " + state;
  dom.statusText.textContent = STATUS_TEXT[state] || "Unknown state";

  // Hide all transient banners on state change (except errors and purge)
  hide(dom.interruptionBanner);
  hide(dom.savedConfirmation);

  // Dismiss VAD notification on any state change (Req 2.5, 2.6)
  dismissVADNotification();

  // Reset VAD energy state when leaving RECORDING (Req 10.4)
  // Safe to call on every state change — no-op when already reset.
  resetVadEnergyState();

  // Update consent status display throughout all states
  updateConsentStatusDisplay();

  // ── IDLE ──
  if (state === SessionState.IDLE) {
    // Show consent form only in IDLE (and not after purge — form is reset but still shown)
    show(dom.consentForm);
    // Show advanced settings in IDLE (#180)
    if (dom.advancedSettings) show(dom.advancedSettings);
    // Show project context form in IDLE (Req 4.1)
    show(dom.projectContextForm);
    // Show time limit control in IDLE
    show(dom.timeLimitControl);
    // Show VAD config in IDLE (Req 3.1, 3.4)
    show(dom.vadConfig);
    // Show video FPS config in IDLE only when video consent is enabled (Req 2.9)
    if (S.videoConsentEnabled) {
      show(dom.videoFpsConfig_el);
    } else {
      hide(dom.videoFpsConfig_el);
    }
    // Show video preview in IDLE only when video consent is enabled and camera is active
    if (S.videoConsentEnabled && S.videoStream) {
      show(videoDom.previewContainer);
    } else {
      hide(videoDom.previewContainer);
    }
    // Enable video consent checkbox in IDLE
    enable(dom.videoConsentCheckbox);
    // Hide duration estimate in IDLE
    hide(dom.durationEstimate);

    // Start Speech gated on consent
    show(dom.btnStart);
    if (S.consentConfirmed && S.consentSpeakerName.trim().length > 0 && !S.inCooldown) {
      enable(dom.btnStart);
    } else {
      disable(dom.btnStart);
    }

    hide(dom.btnStop);
    hide(dom.btnDeliver);
    // Show Save Outputs only if evaluation data exists, not already saved, and not purged
    if (S.hasEvaluationData && !S.outputsSaved && !S.dataPurged) {
      show(dom.btnSave);
      show(dom.btnPdf);
    } else {
      hide(dom.btnSave);
      hide(dom.btnPdf);
    }
    // Show Replay button if TTS audio was received and evaluation data exists and not purged
    if (S.hasTTSAudio && S.hasEvaluationData && !S.dataPurged) {
      show(dom.btnReplay);
    } else {
      hide(dom.btnReplay);
    }
    // Disable replay during cooldown
    if (S.inCooldown) {
      disable(dom.btnReplay);
    } else {
      enable(dom.btnReplay);
    }
    enable(dom.btnPanic);

    // Show Revoke Consent button when consent is confirmed (allows opt-out)
    if (S.consentConfirmed) {
      show(dom.btnRevoke);
    } else {
      hide(dom.btnRevoke);
    }

    hide(dom.speakingIndicator);
    hide(dom.processingIndicator);
    hideElapsedTime();
    hide(dom.audioLevel);

    return;
  }

  // ── RECORDING ──
  if (state === SessionState.RECORDING) {
    // Hide consent form during recording (consent is immutable)
    hide(dom.consentForm);
    // Hide advanced settings during recording (#180)
    if (dom.advancedSettings) hide(dom.advancedSettings);
    // Hide project context form during recording (Req 4.7 — immutable after recording starts)
    hide(dom.projectContextForm);
    // Hide time limit control during recording
    hide(dom.timeLimitControl);
    // Hide VAD config during recording (Req 3.4)
    hide(dom.vadConfig);
    // Hide video FPS config during recording (Req 1.4 — immutable after recording starts)
    hide(dom.videoFpsConfig_el);
    // Disable video consent checkbox during recording (Req 1.4)
    disable(dom.videoConsentCheckbox);
    // Keep video preview visible during recording so operator can verify camera is working
    hide(dom.durationEstimate);

    hide(dom.btnStart);
    show(dom.btnStop);
    hide(dom.btnDeliver);
    hide(dom.btnSave);
    hide(dom.btnPdf);
    hide(dom.btnReplay);
    enable(dom.btnStop);
    enable(dom.btnPanic);

    // Show Revoke Consent during recording (opt-out is always available)
    if (S.consentConfirmed) {
      show(dom.btnRevoke);
    } else {
      hide(dom.btnRevoke);
    }

    hide(dom.speakingIndicator);
    hide(dom.processingIndicator);
    showElapsedTime();
    show(dom.audioLevel);

    // Show transcript panel for live captions
    show(dom.transcriptPanel);

    return;
  }

  // ── PROCESSING ──
  if (state === SessionState.PROCESSING) {
    // Hide consent form during processing
    hide(dom.consentForm);
    // Hide advanced settings during processing (#180)
    if (dom.advancedSettings) hide(dom.advancedSettings);
    // Hide project context form during processing (Req 4.7 — immutable after recording starts)
    hide(dom.projectContextForm);
    // Show time limit control in PROCESSING (can still adjust before delivery)
    show(dom.timeLimitControl);
    // Hide VAD config during processing (Req 3.4)
    hide(dom.vadConfig);
    // Hide video FPS config during processing
    hide(dom.videoFpsConfig_el);
    // Disable video consent checkbox during processing
    disable(dom.videoConsentCheckbox);
    // Hide video preview during processing
    hide(videoDom.previewContainer);
    // Show duration estimate if available
    if (S.estimatedDuration !== null) {
      show(dom.durationEstimate);
    }

    hide(dom.btnStart);
    hide(dom.btnStop);
    show(dom.btnDeliver);
    hide(dom.btnSave);
    hide(dom.btnPdf);
    hide(dom.btnReplay);
    // Deliver button gating based on pipeline stage (Req 4.1-4.4)
    // Disable during in-progress stages and initial idle; enable only on terminal/actionable stages
    // Server remains authoritative — UI gating is advisory only (Req 4.4)
    if (S.pipelineStage === "ready" || S.pipelineStage === "failed" || S.pipelineStage === "invalidated") {
      enable(dom.btnDeliver);
    } else {
      disable(dom.btnDeliver);
    }
    enable(dom.btnPanic);

    // Show Revoke Consent during processing
    if (S.consentConfirmed) {
      show(dom.btnRevoke);
    } else {
      hide(dom.btnRevoke);
    }

    hide(dom.speakingIndicator);
    show(dom.processingIndicator);
    // Update processing indicator text to reflect current pipeline stage
    updateProcessingIndicator(S.pipelineStage);
    hideElapsedTime();
    hide(dom.audioLevel);

    // Keep transcript visible
    show(dom.transcriptPanel);

    return;
  }

  // ── DELIVERING ──
  if (state === SessionState.DELIVERING) {
    // Hide consent form during delivery
    hide(dom.consentForm);
    // Hide advanced settings during delivery (#180)
    if (dom.advancedSettings) hide(dom.advancedSettings);
    // Hide project context form during delivery (Req 4.7 — immutable after recording starts)
    hide(dom.projectContextForm);
    // Hide time limit and duration estimate during delivery
    hide(dom.timeLimitControl);
    // Hide VAD config during delivery (Req 3.4)
    hide(dom.vadConfig);
    // Hide video FPS config during delivery
    hide(dom.videoFpsConfig_el);
    // Disable video consent checkbox during delivery
    disable(dom.videoConsentCheckbox);
    // Hide video preview during delivery
    hide(videoDom.previewContainer);
    hide(dom.durationEstimate);

    hide(dom.btnStart);
    hide(dom.btnStop);
    hide(dom.btnDeliver);
    hide(dom.btnSave);
    hide(dom.btnPdf);
    hide(dom.btnReplay);
    hide(dom.btnRevoke);
    // Disable all actions except Panic Mute during delivery
    enable(dom.btnPanic);

    show(dom.speakingIndicator);
    hide(dom.processingIndicator);
    hideElapsedTime();
    hide(dom.audioLevel);

    // Show evaluation panel for fallback reading
    show(dom.evaluationPanel);
    // Keep transcript visible
    show(dom.transcriptPanel);

    return;
  }
}

// ─── UI Update: Audio Level Meter ────────────────────────────────
/**
 * Updates the audio level indicator bar.
 * Prefers server-side VAD energy when available (Req 10.3).
 * Falls back to client-side AudioWorklet RMS when VAD energy is
 * unavailable or stale (Req 10.4).
 *
 * When called with a source of "vad", the energy value comes from
 * the server's vad_status message (already 0..1 normalized).
 * When called with a source of "worklet" (or no source), the rms
 * value comes from the AudioWorklet (0..1 range, typical speech
 * 0.01-0.15).
 *
 * @param {number} rms - RMS audio level (0..1)
 * @param {"worklet"|"vad"} [source="worklet"] - Source of the level data
 */
export function updateAudioLevel(rms, source) {
  // If VAD energy is active and this is a worklet update, skip it (Req 10.3).
  // The server-side VAD energy takes priority when available.
  if (source !== "vad" && S.useVadEnergy) {
    return;
  }

  // Scale: multiply by ~5 and clamp to 100% for visual responsiveness
  const pct = Math.min(100, rms * 500);
  dom.audioLevelBar.style.width = pct + "%";
  // Turn red when clipping (RMS > 0.3 is very loud)
  if (rms > 0.3) {
    dom.audioLevelBar.classList.add("hot");
  } else {
    dom.audioLevelBar.classList.remove("hot");
  }
}

/**
 * Handles vad_status messages from the server.
 * Updates the audio level meter with server-side VAD energy (Req 10.1, 10.3).
 * Tracks the last receive time for the 2-second fallback (Req 10.4).
 * @param {Object} message - The vad_status message with energy and isSpeech fields
 */
export function handleVADStatus(message) {
  // Only process during RECORDING state
  if (S.currentState !== SessionState.RECORDING) return;

  // When VAD is disabled, ignore vad_status messages — use AudioWorklet path
  if (!S.vadEnabled) return;

  // Track the last time we received a vad_status for fallback logic
  S.lastVadStatusTime = Date.now();
  S.useVadEnergy = true;

  // Drive the audio level meter with server-side energy
  updateAudioLevel(message.energy, "vad");
}

/**
 * Checks whether the VAD energy source has gone stale (no vad_status
 * received for 2+ seconds) and falls back to AudioWorklet if so (Req 10.4).
 * Called from the AudioWorklet onmessage handler during RECORDING.
 */
export function checkVadEnergyFallback() {
  if (!S.useVadEnergy) return;

  const now = Date.now();
  if (now - S.lastVadStatusTime >= 2000) {
    // VAD energy has gone stale — fall back to AudioWorklet
    S.useVadEnergy = false;
  }
}

/**
 * Resets VAD audio level meter state. Called when leaving RECORDING state
 * or when VAD is disabled.
 */
export function resetVadEnergyState() {
  S.lastVadStatusTime = 0;
  S.useVadEnergy = false;
}


// ─── UI Update: Elapsed Time ──────────────────────────────────────
/**
 * Updates the elapsed time display during recording.
 * @param {number} seconds - Elapsed seconds since recording started
 */
export function updateElapsedTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const formatted = String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  dom.elapsedTime.textContent = formatted;
}

// ─── UI Update: Consent Status Display ────────────────────────────
/**
 * Updates the consent status display in the status bar.
 * Shows "Speaker: Name ✓ Consent confirmed" when consent is set.
 */
export function updateConsentStatusDisplay() {
  if (S.consentConfirmed && S.consentSpeakerName.trim().length > 0) {
    dom.consentStatus.textContent = "Speaker: " + S.consentSpeakerName + " \u2713 Consent confirmed";
    show(dom.consentStatus);
  } else {
    dom.consentStatus.textContent = "";
    hide(dom.consentStatus);
  }
}

// ─── UI Update: Duration Estimate ─────────────────────────────────
/**
 * Updates the duration estimate display.
 * @param {number} estimatedSeconds - Estimated evaluation duration in seconds
 * @param {number} timeLimitSeconds - Configured time limit in seconds
 */
export function updateDurationEstimateDisplay(estimatedSeconds, timeLimitSeconds) {
  const estMins = Math.floor(estimatedSeconds / 60);
  const estSecs = Math.floor(estimatedSeconds % 60);
  const limMins = Math.floor(timeLimitSeconds / 60);
  const limSecs = Math.floor(timeLimitSeconds % 60);
  const estStr = String(estMins) + ":" + String(estSecs).padStart(2, "0");
  const limStr = String(limMins) + ":" + String(limSecs).padStart(2, "0");
  dom.durationEstimateText.textContent = "Estimated: " + estStr + " / Limit: " + limStr;
}

// ─── UI Update: Processing Indicator (Eager Pipeline) ─────────────
/**
 * Updates the processing indicator text based on the current pipeline stage.
 * Maps PipelineStage values to user-facing status messages.
 * @param {string} stage - One of the PipelineStage values
 */
export function updateProcessingIndicator(stage) {
  const messages = {
    processing_speech: "Speech processed \u2014 preparing evaluation...",
    generating_evaluation: "Generating evaluation...",
    synthesizing_audio: "Synthesizing audio...",
    ready: "\u2713 Evaluation ready \u2014 click \"Deliver Evaluation\"",
    failed: "\u26A0 Evaluation generation failed \u2014 click \"Deliver Evaluation\" to retry",
    invalidated: "Settings changed \u2014 evaluation will regenerate on delivery",
  };
  const span = dom.processingIndicator.querySelector("span");
  if (span) {
    span.textContent = messages[stage] || "Processing...";
  }
}

/**
 * Updates the Deliver button enabled/disabled state based on pipeline stage.
 * Disable during in-progress stages; enable on terminal/actionable stages.
 * Server remains authoritative — UI gating is advisory only (Req 4.4).
 * @param {string} stage - One of the PipelineStage values
 */
export function updateDeliverButtonState(stage) {
  if (S.currentState !== SessionState.PROCESSING) return;
  if (stage === "ready" || stage === "failed" || stage === "invalidated") {
    enable(dom.btnDeliver);
  } else {
    disable(dom.btnDeliver);
  }
}

export function dismissVADNotification() {
  if (S.vadNotificationVisible) {
    S.vadNotificationVisible = false;
    hide(dom.vadNotification);
  }
}

// ─── UI Update: Error Display ─────────────────────────────────────
/**
 * Displays an error message to the operator.
 *
 * @param {string} message - Error description
 * @param {boolean} recoverable - Whether the operator can retry
 */
export function showError(message, recoverable) {
  dom.errorMessage.textContent = message;
  dom.errorBanner.className = "error-banner visible " +
    (recoverable ? "recoverable" : "non-recoverable");
}

/**
 * Dismisses the error banner.
 */
export function dismissError() {
  hide(dom.errorBanner);
  dom.errorBanner.className = "error-banner";
}

// ─── UI Update: Saved Confirmation ────────────────────────────────
/**
 * Shows a confirmation that outputs were saved and triggers a ZIP download.
 * @param {string[]} paths - File paths that were saved on server
 * @param {Array<{name: string, content: string, encoding: string}>} files - File contents for download
 */
export function showSavedConfirmation(paths, files) {
  S.outputsSaved = true;
  dom.savedMessage.textContent = "Outputs saved — downloading...";
  show(dom.savedConfirmation);
  // Hide save button after successful save
  hide(dom.btnSave);

  // Trigger client-side ZIP download
  if (files && files.length > 0) {
    downloadOutputsAsZip(files);
    dom.savedMessage.textContent = "Outputs downloaded \u2705";
  } else {
    dom.savedMessage.textContent = "Outputs saved on server: " + paths.join(", ");
  }
}

/**
 * Downloads output files as a ZIP archive.
 * Uses a minimal inline ZIP builder (no external dependencies).
 * @param {Array<{name: string, content: string, encoding: string}>} files
 */
export function downloadOutputsAsZip(files) {
  // Include original speech recording if available (#60)
  if (S.speechRecordingBlob && S.speechRecordingBlob.size > 0) {
    // Convert blob to base64 for buildZip
    const reader = new FileReader();
    reader.onloadend = function () {
      const base64 = reader.result.split(",")[1]; // strip data:...;base64,
      const ext = S.speechRecordingBlob.type.includes("mp4") ? "mp4" : "webm";
      files.push({ name: "speech_recording." + ext, content: base64, encoding: "base64" });
      finishZipDownload(files);
    };
    reader.readAsDataURL(S.speechRecordingBlob);
  } else {
    finishZipDownload(files);
  }
}

export function finishZipDownload(files) {
  // Build ZIP file bytes
  const zipBytes = buildZip(files);
  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);

  // Build filename: speech-evaluation_{speaker}_{date}.zip
  const speakerName = dom.speakerNameInput?.value?.trim() || "evaluation";
  const safeName = speakerName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 40);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `speech-evaluation_${safeName}_${dateStr}.zip`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Minimal ZIP file builder. Creates a valid ZIP from text files.
 * Supports only Store (no compression) which is fine for small text files.
 * @param {Array<{name: string, content: string, encoding: string}>} files
 * @returns {Uint8Array} ZIP file bytes
 */
export function buildZip(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), c => c.charCodeAt(0))
      : encoder.encode(file.content);
    const crc = crc32(contentBytes);

    // Local file header (30 bytes + name + content)
    const local = new Uint8Array(30 + nameBytes.length + contentBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // compression (store)
    lv.setUint16(10, 0, true);            // mod time
    lv.setUint16(12, 0, true);            // mod date
    lv.setUint32(14, crc, true);          // crc-32
    lv.setUint32(18, contentBytes.length, true);  // compressed size
    lv.setUint32(22, contentBytes.length, true);  // uncompressed size
    lv.setUint16(26, nameBytes.length, true);     // filename length
    lv.setUint16(28, 0, true);            // extra field length
    local.set(nameBytes, 30);
    local.set(contentBytes, 30 + nameBytes.length);
    localHeaders.push(local);

    // Central directory header (46 bytes + name)
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);    // signature
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression
    cv.setUint16(12, 0, true);            // mod time
    cv.setUint16(14, 0, true);            // mod date
    cv.setUint32(16, crc, true);          // crc-32
    cv.setUint32(20, contentBytes.length, true);  // compressed size
    cv.setUint32(24, contentBytes.length, true);  // uncompressed size
    cv.setUint16(28, nameBytes.length, true);     // filename length
    cv.setUint16(30, 0, true);            // extra field length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attributes
    cv.setUint32(38, 0, true);            // external attributes
    cv.setUint32(42, offset, true);       // local header offset
    central.set(nameBytes, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralHeaders) centralSize += c.length;

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);       // signature
  ev.setUint16(4, 0, true);                // disk number
  ev.setUint16(6, 0, true);                // central dir disk
  ev.setUint16(8, files.length, true);     // entries on this disk
  ev.setUint16(10, files.length, true);    // total entries
  ev.setUint32(12, centralSize, true);     // central dir size
  ev.setUint32(16, centralOffset, true);   // central dir offset
  ev.setUint16(20, 0, true);               // comment length

  // Concatenate all parts
  const totalSize = offset + centralSize + 22;
  const zip = new Uint8Array(totalSize);
  let pos = 0;
  for (const l of localHeaders) { zip.set(l, pos); pos += l.length; }
  for (const c of centralHeaders) { zip.set(c, pos); pos += c.length; }
  zip.set(eocd, pos);

  return zip;
}

/**
 * CRC-32 computation for ZIP file integrity.
 * @param {Uint8Array} data
 * @returns {number} CRC-32 value
 */
export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── UI Update: Interruption Banner ───────────────────────────────
/**
 * Shows the interruption banner after a panic mute.
 */
export function showInterruptionBanner() {
  show(dom.interruptionBanner);
}

// ─── Notification Toast ──────────────────────────────────────────

// MAX_UPLOAD_SIZE_MB imported from ./js/constants.js

/**
 * Shows a toast notification banner.
 * @param {string} message - Text to display
 * @param {string} type - 'error' | 'warning' | 'success' | 'info'
 * @param {number} durationMs - Auto-dismiss after this many ms (default 5000)
 */
export function showNotification(message, type = "info", durationMs = 5000) {
  let toast = document.getElementById("notification-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "notification-toast";
    toast.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      padding: 12px 24px; border-radius: 8px; z-index: 10000;
      font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 500;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4); transition: opacity 0.3s;
      max-width: 90vw; text-align: center;
    `;
    document.body.appendChild(toast);
  }

  const colors = {
    error: { bg: "#3a1c1c", border: "#e74c3c", text: "#ff8a80" },
    warning: { bg: "#3a2e1c", border: "#f39c12", text: "#ffe0b2" },
    success: { bg: "#1c3a1c", border: "#27ae60", text: "#a5d6a7" },
    info: { bg: "#1c2a3a", border: "#3498db", text: "#90caf9" },
  };
  const c = colors[type] || colors.info;
  toast.style.background = c.bg;
  toast.style.border = `1px solid ${c.border}`;
  toast.style.color = c.text;
  toast.textContent = message;
  toast.style.opacity = "1";

  clearTimeout(toast._dismissTimer);
  toast._dismissTimer = setTimeout(() => {
    toast.style.opacity = "0";
  }, durationMs);
}

// ─── Utility Functions (imported from ./js/utils.js) ──────────────
// show, hide, enable, disable, formatTimestamp, escapeHtml are imported

export function showElapsedTime() {
  dom.elapsedTime.classList.add("visible");
}

export function hideElapsedTime() {
  dom.elapsedTime.classList.remove("visible");
}

// ─── Coaching Cue Toast (#155) ───────────────────────────────────

const CUE_ICONS = {
  pace_fast: "🏃",
  pace_slow: "🐢",
  filler_alert: "🔇",
  long_pause: "⏸️",
};

/**
 * Shows a coaching cue toast overlay during practice mode recording.
 * Auto-dismisses after 5 seconds with a fade-out animation.
 * @param {{ cueType: string, message: string }} cue
 */
export function showCoachingCue(cue) {
  const container = document.getElementById("coaching-cue-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "coaching-cue-toast";
  const icon = CUE_ICONS[cue.cueType] || "💡";
  toast.textContent = `${icon} ${cue.message}`;

  container.appendChild(toast);

  // Trigger slide-in animation
  requestAnimationFrame(() => toast.classList.add("visible"));

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.classList.remove("visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    // Fallback removal if transitionend never fires
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
  }, 5000);
}
