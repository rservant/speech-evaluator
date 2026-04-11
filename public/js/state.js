/**
 * Shared application state — single mutable object.
 *
 * All modules import S and read/write properties directly:
 *   import { S } from "./state.js";
 *   S.currentState = SessionState.RECORDING;
 *
 * This avoids the ES module live-binding limitation (exports cannot
 * be reassigned from outside the declaring module) without needing
 * a setState() function for every variable.
 */
import { SessionState } from "./constants.js";

export const S = {
  // ─── Application State ───────────────────────────────────────
  currentState: SessionState.IDLE,
  hasEvaluationData: false,
  hasTTSAudio: false,
  outputsSaved: false,
  segments: [],

  // ─── Consent & Time Limit ────────────────────────────────────
  consentConfirmed: false,
  consentSpeakerName: "",
  dataPurged: false,
  estimatedDuration: null,
  configuredTimeLimit: 120,

  // ─── Eager Pipeline ──────────────────────────────────────────
  pipelineStage: "idle",
  pipelineRunId: 0,

  // ─── VAD Configuration ───────────────────────────────────────
  vadEnabled: true,
  vadSilenceThreshold: 5,
  vadNotificationVisible: false,

  // ─── Project Context ─────────────────────────────────────────
  projectContext: { speechTitle: "", projectType: "", objectives: [] },

  // ─── Video Consent ───────────────────────────────────────────
  videoConsentEnabled: false,
  videoStreamReady: false,
  videoFpsConfig: 2,

  // ─── Analysis Tier (#125) ─────────────────────────────────────
  analysisTier: "standard",

  // ─── Evaluation Style (#133) ──────────────────────────────────
  evaluationStyle: "classic",

  // ─── VAD Audio Level Meter ───────────────────────────────────
  lastVadStatusTime: 0,
  useVadEnergy: false,

  // ─── TTS Audio Playback ──────────────────────────────────────
  ttsAudioElement: null,
  ttsBlobUrl: null,
  ttsPlaying: false,
  ttsDeliveryComplete: false,
  lastEvaluationScript: "",
  lastEvaluationData: null,
  highlightDismissTimer: null,
  playbackInstanceToken: 0,
  deferredIdleTransition: null,
  pendingIdleFromServer: null,

  // ─── Audio Capture ───────────────────────────────────────────
  ws: null,
  audioContext: null,
  workletNode: null,
  mediaStream: null,
  sourceNode: null,
  audioFormatSent: false,

  // ─── Speech Recording ────────────────────────────────────────
  speechRecorder: null,
  speechRecordingChunks: [],
  speechRecordingBlob: null,
  inCooldown: false,
  cooldownTimer: null,

  // ─── Meeting Roles ───────────────────────────────────────────
  activeRoles: new Set(),

  // ─── Upload ──────────────────────────────────────────────────
  pendingFormFile: null,
  uploadStartTime: null,
  uploadElapsedInterval: null,
  uploadProgressSamples: [],
  activeUploadXHR: null,

  // ─── Mode ────────────────────────────────────────────────────
  currentMode: "live",
  practiceAutoStopTimer: null,

  // ─── WebSocket ───────────────────────────────────────────────
  liveSessionActive: false,

  // ─── Meeting Mode (#174) ─────────────────────────────────────
  meetingMode: false,
  meetingAgenda: null,
  meetingActiveSlotId: null,
  meetingConsented: false,

  // ─── Video Capture ───────────────────────────────────────────
  videoStream: null,
  videoCaptureInterval: null,
  videoFrameSeq: 0,
  recordingStartPerfNow: 0,
  videoFramesSent: 0,
  videoFramesSkipped: 0,
  currentFacingMode: "user",
  hasMultipleCameras: false,
  lastVideoQualityGrade: null,
};

// ─── DOM References ──────────────────────────────────────────────
// Populated eagerly — module runs after DOM is parsed (script at end of body)
export const dom = {
  statusIndicator: document.getElementById("status-indicator"),
  statusText: document.getElementById("status-text"),
  elapsedTime: document.getElementById("elapsed-time"),
  btnStart: document.getElementById("btn-start"),
  btnStop: document.getElementById("btn-stop"),
  btnDeliver: document.getElementById("btn-deliver"),
  btnReplay: document.getElementById("btn-replay"),
  btnSave: document.getElementById("btn-save"),
  btnPdf: document.getElementById("btn-pdf"),
  btnPanic: document.getElementById("btn-panic"),
  btnRevoke: document.getElementById("btn-revoke"),
  btnUpload: document.getElementById("btn-upload"),
  speakingIndicator: document.getElementById("speaking-indicator"),
  processingIndicator: document.getElementById("processing-indicator"),
  transcriptPanel: document.getElementById("transcript-panel"),
  transcriptContent: document.getElementById("transcript-content"),
  transcriptWordCount: document.getElementById("transcript-word-count"),
  evaluationPanel: document.getElementById("evaluation-panel"),
  evaluationContent: document.getElementById("evaluation-content"),
  errorBanner: document.getElementById("error-banner"),
  errorMessage: document.getElementById("error-message"),
  interruptionBanner: document.getElementById("interruption-banner"),
  savedConfirmation: document.getElementById("saved-confirmation"),
  savedMessage: document.getElementById("saved-message"),
  connectionStatus: document.getElementById("connection-status"),
  audioLevel: document.getElementById("audio-level"),
  audioLevelBar: document.getElementById("audio-level-bar"),
  // Phase 2
  consentForm: document.getElementById("consent-form"),
  speakerNameInput: document.getElementById("speaker-name-input"),
  consentCheckbox: document.getElementById("consent-checkbox"),
  consentStatus: document.getElementById("consent-status"),
  timeLimitControl: document.getElementById("time-limit-control"),
  timeLimitInput: document.getElementById("time-limit-input"),
  durationEstimate: document.getElementById("duration-estimate"),
  durationEstimateText: document.getElementById("duration-estimate-text"),
  purgeBanner: document.getElementById("purge-banner"),
  purgeMessage: document.getElementById("purge-message"),
  // Phase 3: VAD
  vadConfig: document.getElementById("vad-config"),
  vadEnabledCheckbox: document.getElementById("vad-enabled-checkbox"),
  vadThresholdSlider: document.getElementById("vad-threshold-slider"),
  vadThresholdValue: document.getElementById("vad-threshold-value"),
  vadNotification: document.getElementById("vad-notification"),
  // Phase 3: Project Context
  projectContextForm: document.getElementById("project-context-form"),
  speechTitleInput: document.getElementById("speech-title-input"),
  projectTypeSelect: document.getElementById("project-type-select"),
  objectivesTextarea: document.getElementById("objectives-textarea"),
  // Phase 4: Video
  videoConsentCheckbox: document.getElementById("video-consent-checkbox"),
  videoConsentError: document.getElementById("video-consent-error"),
  videoFpsConfig_el: document.getElementById("video-fps-config"),
  videoFpsSlider: document.getElementById("video-fps-slider"),
  videoFpsValue: document.getElementById("video-fps-value"),
  // Analysis Tier (#125)
  analysisTierConfig: document.getElementById("analysis-tier-config"),
  // Evaluation Style (#133)
  evaluationStyleConfig: document.getElementById("evaluation-style-config"),
};

// ─── Video DOM References ────────────────────────────────────────
export const videoDom = {
  previewContainer: document.getElementById("video-preview-container"),
  preview: document.getElementById("video-preview"),
  captureCanvas: document.getElementById("video-capture-canvas"),
  frameStats: document.getElementById("video-frame-stats"),
  qualityGrade: document.getElementById("video-quality-grade"),
  btnCameraFlip: document.getElementById("btn-camera-flip"),
};
