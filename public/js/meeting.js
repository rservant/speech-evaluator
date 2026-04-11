/**
 * Meeting Mode — agenda management, meeting-level consent (#174, #175)
 *
 * Manages a pre-loaded speaker queue that lets the operator tap through
 * speakers during a meeting without re-entering names and forms.
 */
import { S, dom } from "./state.js";
import { wsSend } from "./websocket.js";
import { updateUI } from "./ui.js";
import { SessionState } from "./constants.js";

const MEETING_STORAGE_KEY = "speech-evaluator-meeting-agenda";

// ─── Agenda CRUD ─────────────────────────────────────────────────────────────

export function createMeetingAgenda() {
  S.meetingAgenda = {
    meetingId: crypto.randomUUID(),
    clubName: "",
    meetingDate: new Date().toISOString().slice(0, 10),
    slots: [],
    createdAt: new Date().toISOString(),
  };
  saveMeetingAgenda();
}

export function addSlot(type) {
  if (!S.meetingAgenda) return;
  const slot = {
    id: crypto.randomUUID(),
    type,
    speakerName: "",
    projectTitle: "",
    order: S.meetingAgenda.slots.length,
    status: "pending",
  };
  S.meetingAgenda.slots.push(slot);
  saveMeetingAgenda();
  renderAgendaPanel();
}

export function removeSlot(slotId) {
  if (!S.meetingAgenda) return;
  S.meetingAgenda.slots = S.meetingAgenda.slots.filter((s) => s.id !== slotId);
  reindexSlots();
  saveMeetingAgenda();
  renderAgendaPanel();
}

export function moveSlot(slotId, direction) {
  if (!S.meetingAgenda) return;
  const slots = S.meetingAgenda.slots;
  const idx = slots.findIndex((s) => s.id === slotId);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= slots.length) return;
  [slots[idx], slots[targetIdx]] = [slots[targetIdx], slots[idx]];
  reindexSlots();
  saveMeetingAgenda();
  renderAgendaPanel();
}

function reindexSlots() {
  if (!S.meetingAgenda) return;
  S.meetingAgenda.slots.forEach((s, i) => { s.order = i; });
}

export function updateSlotField(slotId, field, value) {
  if (!S.meetingAgenda) return;
  const slot = S.meetingAgenda.slots.find((s) => s.id === slotId);
  if (!slot) return;
  slot[field] = value;
  saveMeetingAgenda();
}

// ─── Slot Activation ─────────────────────────────────────────────────────────

export function activateSlot(slotId) {
  if (!S.meetingAgenda) return;
  if (!S.meetingConsented) {
    alert("Please confirm meeting consent before activating a speaker.");
    return;
  }

  // Deactivate any currently active slot
  S.meetingAgenda.slots.forEach((s) => {
    if (s.status === "active") s.status = "pending";
  });

  const slot = S.meetingAgenda.slots.find((s) => s.id === slotId);
  if (!slot) return;

  slot.status = "active";
  S.meetingActiveSlotId = slotId;

  // Auto-populate consent + project context
  S.consentSpeakerName = slot.speakerName;
  S.consentConfirmed = true;

  // Update consent form fields (hidden but used by server)
  if (dom.speakerNameInput) dom.speakerNameInput.value = slot.speakerName;
  if (dom.consentCheckbox) dom.consentCheckbox.checked = true;

  // Send consent to server
  wsSend({ type: "set_consent", speakerName: slot.speakerName, consentConfirmed: true });

  // Auto-populate project context
  S.projectContext.speechTitle = slot.projectTitle || "";
  S.projectContext.projectType = slot.type === "table-topics" ? "Table Topics" : "";
  S.projectContext.objectives = [];

  if (dom.speechTitleInput) dom.speechTitleInput.value = S.projectContext.speechTitle;

  wsSend({
    type: "set_project_context",
    speechTitle: S.projectContext.speechTitle,
    projectType: S.projectContext.projectType,
    objectives: S.projectContext.objectives,
  });

  // Send meeting context to server
  wsSend({
    type: "set_meeting_context",
    meetingId: S.meetingAgenda.meetingId,
    slotId: slot.id,
    clubName: S.meetingAgenda.clubName || undefined,
  });

  saveMeetingAgenda();
  renderAgendaPanel();
  updateUI(S.currentState);
}

export function completeActiveSlot() {
  if (!S.meetingAgenda || !S.meetingActiveSlotId) return;
  const slot = S.meetingAgenda.slots.find((s) => s.id === S.meetingActiveSlotId);
  if (slot) slot.status = "completed";
  S.meetingActiveSlotId = null;
  saveMeetingAgenda();
  renderAgendaPanel();
}

export function skipSlot(slotId) {
  if (!S.meetingAgenda) return;
  const slot = S.meetingAgenda.slots.find((s) => s.id === slotId);
  if (!slot) return;
  slot.status = "skipped";
  if (S.meetingActiveSlotId === slotId) S.meetingActiveSlotId = null;
  saveMeetingAgenda();
  renderAgendaPanel();
}

// ─── Meeting Consent (#175) ──────────────────────────────────────────────────

export function onMeetingConsentChange() {
  const cb = document.getElementById("meeting-consent-checkbox");
  S.meetingConsented = cb?.checked ?? false;
  saveMeetingAgenda();
  renderAgendaPanel();
}

// ─── Toggle Meeting Mode ──────────────────────────────────────────────────────

export function toggleMeetingMode(enabled) {
  S.meetingMode = enabled;

  if (enabled && !S.meetingAgenda) {
    createMeetingAgenda();
  }

  // Hide/show standard consent form and meeting panel
  const consentForm = document.getElementById("consent-form");
  const projectForm = document.getElementById("project-context-form");
  const meetingPanel = document.getElementById("meeting-panel");
  const meetingEntry = document.getElementById("meeting-mode-entry");

  if (consentForm) consentForm.style.display = enabled ? "none" : "";
  if (projectForm) projectForm.style.display = enabled ? "none" : "";
  if (meetingPanel) meetingPanel.style.display = enabled ? "" : "none";
  if (meetingEntry) meetingEntry.style.display = enabled ? "none" : "";

  // Sync both toggles
  const toggle = document.getElementById("meeting-mode-toggle");
  const entryToggle = document.getElementById("meeting-mode-toggle-entry");
  if (toggle) toggle.checked = enabled;
  if (entryToggle) entryToggle.checked = enabled;

  saveMeetingAgenda();
  renderAgendaPanel();
  updateUI(S.currentState);
}

// ─── PDF Import ──────────────────────────────────────────────────────────────

export async function importAgendaFromPDF() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,.docx,.txt,.md";

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const importBtn = document.getElementById("btn-import-agenda");
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = "Parsing...";
    }

    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await fetch("/api/agenda/parse", { method: "POST", body: formData });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      const { slots } = await resp.json();
      if (!S.meetingAgenda) createMeetingAgenda();

      // Append parsed slots with UUIDs
      for (const parsed of slots) {
        S.meetingAgenda.slots.push({
          id: crypto.randomUUID(),
          type: parsed.type,
          speakerName: parsed.speakerName,
          projectTitle: parsed.projectTitle || "",
          order: S.meetingAgenda.slots.length,
          status: "pending",
        });
      }

      saveMeetingAgenda();
      renderAgendaPanel();
    } catch (err) {
      alert(`Failed to parse agenda: ${err.message}`);
    } finally {
      if (importBtn) {
        importBtn.disabled = false;
        importBtn.textContent = "📋 Import Agenda";
      }
    }
  };

  input.click();
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function saveMeetingAgenda() {
  const data = {
    meetingMode: S.meetingMode,
    meetingConsented: S.meetingConsented,
    meetingAgenda: S.meetingAgenda,
  };
  localStorage.setItem(MEETING_STORAGE_KEY, JSON.stringify(data));
}

export function restoreMeetingAgenda() {
  try {
    const raw = localStorage.getItem(MEETING_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    S.meetingMode = data.meetingMode ?? false;
    S.meetingConsented = data.meetingConsented ?? false;
    S.meetingAgenda = data.meetingAgenda ?? null;

    // Restore active slot reference
    if (S.meetingAgenda) {
      const active = S.meetingAgenda.slots.find((s) => s.status === "active");
      S.meetingActiveSlotId = active?.id ?? null;
    }
  } catch {
    // Corrupted data — ignore
  }
}

export function clearMeetingAgenda() {
  S.meetingMode = false;
  S.meetingAgenda = null;
  S.meetingActiveSlotId = null;
  S.meetingConsented = false;
  localStorage.removeItem(MEETING_STORAGE_KEY);
}

// ─── End Meeting ─────────────────────────────────────────────────────────────

export async function endMeeting() {
  if (!S.meetingAgenda) return;
  if (!confirm("End this meeting? The agenda will be cleared.")) return;

  // Finalize meeting to GCS (#176)
  try {
    const record = {
      meetingId: S.meetingAgenda.meetingId,
      clubName: S.meetingAgenda.clubName || undefined,
      meetingDate: S.meetingAgenda.meetingDate,
      slots: S.meetingAgenda.slots
        .filter((s) => s.status === "completed" || s.status === "skipped")
        .map((s) => ({
          slotId: s.id,
          type: s.type,
          speakerName: s.speakerName,
          projectTitle: s.projectTitle || undefined,
          status: s.status,
        })),
      createdAt: S.meetingAgenda.createdAt,
    };

    await fetch(`/api/meetings/${record.meetingId}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  } catch (err) {
    console.warn("Failed to finalize meeting:", err);
  }

  clearMeetingAgenda();
  toggleMeetingMode(false);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export function renderAgendaPanel() {
  const panel = document.getElementById("meeting-panel");
  if (!panel) return;

  if (!S.meetingMode || !S.meetingAgenda) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "";
  const agenda = S.meetingAgenda;

  // Build header
  const clubInput = panel.querySelector("#meeting-club-name");
  if (clubInput) clubInput.value = agenda.clubName || "";

  const dateInput = panel.querySelector("#meeting-date");
  if (dateInput) dateInput.value = agenda.meetingDate || "";

  // Meeting consent checkbox
  const consentCb = document.getElementById("meeting-consent-checkbox");
  if (consentCb) consentCb.checked = S.meetingConsented;

  // Slot list
  const slotList = panel.querySelector("#meeting-slot-list");
  if (!slotList) return;

  slotList.innerHTML = "";

  for (const slot of agenda.slots) {
    const row = document.createElement("div");
    row.className = `meeting-slot meeting-slot--${slot.status}`;
    row.dataset.slotId = slot.id;

    const icon = slot.type === "speech" ? "🎤" : "💬";
    const statusIcon = slot.status === "completed" ? " ✅" : slot.status === "skipped" ? " ⏭️" : "";

    row.innerHTML = `
      <span class="meeting-slot-order">${slot.order + 1}.</span>
      <span class="meeting-slot-icon">${icon}</span>
      <input type="text" class="meeting-slot-name" value="${escapeAttr(slot.speakerName)}"
        placeholder="${slot.type === 'speech' ? 'Speaker name' : 'TT speaker'}"
        data-field="speakerName" ${slot.status === "completed" || slot.status === "skipped" ? "disabled" : ""}>
      ${slot.type === "speech" ? `<input type="text" class="meeting-slot-title" value="${escapeAttr(slot.projectTitle || "")}"
        placeholder="Project title" data-field="projectTitle"
        ${slot.status === "completed" || slot.status === "skipped" ? "disabled" : ""}>` : ""}
      <span class="meeting-slot-status">${statusIcon}</span>
      <div class="meeting-slot-actions">
        ${slot.status === "pending" ? `
          <button class="btn-icon" title="Activate" data-action="activate">▶</button>
          <button class="btn-icon" title="Move up" data-action="move-up">↑</button>
          <button class="btn-icon" title="Move down" data-action="move-down">↓</button>
          <button class="btn-icon" title="Skip" data-action="skip">✕</button>
          <button class="btn-icon btn-icon--danger" title="Remove" data-action="remove">🗑</button>
        ` : ""}
        ${slot.status === "active" ? `<span class="meeting-slot-active-label">Active</span>` : ""}
      </div>
    `;

    // Wire input change handlers
    for (const input of row.querySelectorAll("input[data-field]")) {
      input.addEventListener("change", (e) => {
        updateSlotField(slot.id, e.target.dataset.field, e.target.value);
      });
    }

    // Wire action buttons
    for (const btn of row.querySelectorAll("button[data-action]")) {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "activate") activateSlot(slot.id);
        else if (action === "move-up") moveSlot(slot.id, -1);
        else if (action === "move-down") moveSlot(slot.id, 1);
        else if (action === "skip") skipSlot(slot.id);
        else if (action === "remove") removeSlot(slot.id);
      });
    }

    slotList.appendChild(row);
  }
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initMeetingPanel() {
  restoreMeetingAgenda();

  // Wire toggles (panel toggle + entry toggle)
  const toggle = document.getElementById("meeting-mode-toggle");
  const entryToggle = document.getElementById("meeting-mode-toggle-entry");

  function syncToggles(checked) {
    if (toggle) toggle.checked = checked;
    if (entryToggle) entryToggle.checked = checked;
    toggleMeetingMode(checked);
  }

  if (toggle) {
    toggle.checked = S.meetingMode;
    toggle.addEventListener("change", () => syncToggles(toggle.checked));
  }
  if (entryToggle) {
    entryToggle.checked = S.meetingMode;
    entryToggle.addEventListener("change", () => syncToggles(entryToggle.checked));
  }

  // Wire add buttons
  const addSpeech = document.getElementById("btn-add-speech");
  if (addSpeech) addSpeech.addEventListener("click", () => addSlot("speech"));

  const addTT = document.getElementById("btn-add-tt");
  if (addTT) addTT.addEventListener("click", () => addSlot("table-topics"));

  // Wire import button
  const importBtn = document.getElementById("btn-import-agenda");
  if (importBtn) importBtn.addEventListener("click", importAgendaFromPDF);

  // Wire end meeting button
  const endBtn = document.getElementById("btn-end-meeting");
  if (endBtn) endBtn.addEventListener("click", endMeeting);

  // Wire meeting consent
  const consentCb = document.getElementById("meeting-consent-checkbox");
  if (consentCb) consentCb.addEventListener("change", onMeetingConsentChange);

  // Wire club name and date inputs
  const clubInput = document.getElementById("meeting-club-name");
  if (clubInput) {
    clubInput.addEventListener("change", () => {
      if (S.meetingAgenda) {
        S.meetingAgenda.clubName = clubInput.value;
        saveMeetingAgenda();
      }
    });
  }

  const dateInput = document.getElementById("meeting-date");
  if (dateInput) {
    dateInput.addEventListener("change", () => {
      if (S.meetingAgenda) {
        S.meetingAgenda.meetingDate = dateInput.value;
        saveMeetingAgenda();
      }
    });
  }

  // Apply restored state
  if (S.meetingMode) {
    toggleMeetingMode(true);
  }
}
