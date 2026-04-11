/**
 * History module — browse past evaluations stored in GCS (#123).
 * Fetches from GET /api/history/:speaker, renders list with expand/play/download.
 */

// ─── State ──────────────────────────────────────────────────────────
let historyLoaded = false;
let historyLoading = false;
let historyNextCursor = null;
let historySpeaker = "";
let historyResults = [];
let compareSelections = []; // max 2 indices for side-by-side comparison (#154)

// ─── DOM References ─────────────────────────────────────────────────
function getHistoryPanel() {
  return document.getElementById("history-panel");
}

function getHistoryList() {
  return document.getElementById("history-list");
}

function getHistoryEmpty() {
  return document.getElementById("history-empty");
}

function getHistoryLoadMore() {
  return document.getElementById("history-load-more");
}

function getHistorySpinner() {
  return document.getElementById("history-spinner");
}

// ─── API ────────────────────────────────────────────────────────────

async function fetchHistory(speaker, cursor) {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);

  const encoded = encodeURIComponent(speaker);
  const res = await fetch(`/api/history/${encoded}?${params}`);
  if (!res.ok) throw new Error(`History API error: ${res.status}`);
  return res.json();
}

async function deleteEvaluationApi(speaker, prefix) {
  const encodedSpeaker = encodeURIComponent(speaker);
  const encodedPrefix = encodeURIComponent(prefix);
  const res = await fetch(`/api/history/${encodedSpeaker}/${encodedPrefix}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete API error: ${res.status}`);
  return res.json();
}

async function fetchProgress(speaker) {
  const encoded = encodeURIComponent(speaker);
  const res = await fetch(`/api/progress/${encoded}`);
  if (!res.ok) throw new Error(`Progress API error: ${res.status}`);
  return res.json();
}

// ─── Progress Trend Chart (#140) ────────────────────────────────────

/**
 * Build an SVG sparkline from data points.
 * @param {number[]} values - Data values to plot
 * @param {string} color - Stroke color
 * @param {number} width - SVG width
 * @param {number} height - SVG height
 * @returns {string} SVG markup
 */
function buildSparkline(values, color, width = 200, height = 40) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padding = 4;
  const plotH = height - padding * 2;
  const plotW = width - padding * 2;
  const step = plotW / (values.length - 1);

  const points = values.map((v, i) => {
    const x = padding + i * step;
    const y = padding + plotH - ((v - min) / range) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  // Dot on last point
  const lastX = padding + (values.length - 1) * step;
  const lastY = padding + plotH - ((values[values.length - 1] - min) / range) * plotH;

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${color}" />
  </svg>`;
}

/**
 * Compute the percentage change between first and last value.
 * Returns { arrow, text, className }.
 */
function trendDelta(values, lowerIsBetter = false) {
  if (!values || values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return null;
  const pct = ((last - first) / first) * 100;
  const improved = lowerIsBetter ? pct < 0 : pct > 0;
  const arrow = improved ? "↑" : "↓";
  const text = `${arrow} ${Math.abs(pct).toFixed(0)}%`;
  const className = improved ? "trend-positive" : "trend-negative";
  return { text, className };
}

function renderProgressPanel(progressData) {
  const panel = document.getElementById("progress-panel");
  if (!panel) return;

  const speeches = progressData.speeches;
  if (!speeches || speeches.length < 2) {
    panel.style.display = "none";
    return;
  }

  const wpmValues = speeches.map(s => s.wordsPerMinute);
  const passValues = speeches.map(s => Math.round(s.passRate * 100));
  const fillerValues = speeches.filter(s => s.fillerWordFrequency != null).map(s => s.fillerWordFrequency);

  const wpmTrend = trendDelta(wpmValues);
  const passTrend = trendDelta(passValues);
  const fillerTrend = trendDelta(fillerValues, true);

  let html = `<div class="progress-chart-panel">
    <div class="progress-header">
      <span class="progress-title">📈 Progress (${speeches.length} speeches)</span>
    </div>
    <div class="progress-metrics">`;

  // WPM sparkline
  html += `<div class="progress-metric">
    <div class="progress-metric-label">Words/Min</div>
    ${buildSparkline(wpmValues, "#4fc3f7")}
    <div class="progress-metric-value">${Math.round(wpmValues[wpmValues.length - 1])} WPM
      ${wpmTrend ? `<span class="${wpmTrend.className}">${escapeHtml(wpmTrend.text)}</span>` : ""}
    </div>
  </div>`;

  // Pass Rate sparkline
  html += `<div class="progress-metric">
    <div class="progress-metric-label">Pass Rate</div>
    ${buildSparkline(passValues, "#81c784")}
    <div class="progress-metric-value">${passValues[passValues.length - 1]}%
      ${passTrend ? `<span class="${passTrend.className}">${escapeHtml(passTrend.text)}</span>` : ""}
    </div>
  </div>`;

  // Filler Rate sparkline (only if data exists)
  if (fillerValues.length >= 2) {
    html += `<div class="progress-metric">
      <div class="progress-metric-label">Fillers/Min</div>
      ${buildSparkline(fillerValues, "#ffb74d")}
      <div class="progress-metric-value">${fillerValues[fillerValues.length - 1].toFixed(1)}/min
        ${fillerTrend ? `<span class="${fillerTrend.className}">${escapeHtml(fillerTrend.text)}</span>` : ""}
      </div>
    </div>`;
  }

  html += `</div></div>`;
  panel.innerHTML = html;
  panel.style.display = "block";
}

// ── Improvement Plan (#145) ──────────────────────────────────────────────────

async function fetchImprovementPlan(speaker) {
  const res = await fetch(`/api/improvement-plan/${encodeURIComponent(speaker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderImprovementPlan(data) {
  const panel = document.getElementById("improvement-plan-panel");
  if (!panel) return;

  if (!data.plan) {
    panel.style.display = "none";
    return;
  }

  const { plan } = data;
  const focusLabel = plan.focusCategory.charAt(0).toUpperCase() + plan.focusCategory.slice(1);

  let html = `<div class="improvement-plan-content">`;
  html += `<div class="improvement-plan-header">`;
  html += `<span class="improvement-plan-icon">🎯</span>`;
  html += `<div class="improvement-plan-title">Your Focus Area: <strong>${escapeHtml(focusLabel)}</strong></div>`;
  html += `<span class="improvement-plan-score">${plan.focusCategoryAvg}/10</span>`;
  html += `</div>`;

  // Category averages bar chart
  if (plan.categoryAverages && plan.categoryAverages.length > 0) {
    html += '<div class="improvement-scores">';
    for (const ca of plan.categoryAverages) {
      const pct = Math.round((ca.averageScore / 10) * 100);
      const colorClass = ca.averageScore >= 7 ? "score-good" : ca.averageScore >= 4 ? "score-fair" : "score-poor";
      const isFocus = ca.category === plan.focusCategory ? " focus-category" : "";
      const label = ca.category.charAt(0).toUpperCase() + ca.category.slice(1);
      const trendIcon = ca.trend === "improving" ? "↑" : ca.trend === "declining" ? "↓" : "→";
      html += `
        <div class="category-score-row${isFocus}">
          <span class="category-score-name">${escapeHtml(label)}</span>
          <div class="category-score-track">
            <div class="category-score-fill ${colorClass}" style="width:${pct}%"></div>
          </div>
          <span class="category-score-value">${ca.averageScore} ${trendIcon}</span>
        </div>
      `;
    }
    html += '</div>';
  }

  // Practice exercises
  if (plan.exercises && plan.exercises.length > 0) {
    html += '<div class="improvement-exercises">';
    html += '<div class="improvement-exercises-label">Practice Exercises</div>';
    for (const ex of plan.exercises) {
      html += `
        <div class="improvement-exercise">
          <div class="exercise-header">
            <span class="exercise-title">${escapeHtml(ex.title)}</span>
            <span class="exercise-duration">${escapeHtml(ex.duration)}</span>
          </div>
          <div class="exercise-description">${escapeHtml(ex.description)}</div>
        </div>
      `;
    }
    html += '</div>';
  }

  html += `<div class="improvement-plan-meta">Based on ${plan.evaluationCount} evaluations</div>`;
  html += `</div>`;

  panel.innerHTML = html;
  panel.style.display = "block";
}

// ── Habit Report (#147) ─────────────────────────────────────────────────────────

async function fetchHabits(speaker) {
  const res = await fetch(`/api/habits/${encodeURIComponent(speaker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderHabitReport(data) {
  const panel = document.getElementById("habits-panel");
  if (!panel) return;

  if (!data.report) {
    panel.style.display = "none";
    return;
  }

  const { report } = data;
  if (report.habits.length === 0 && report.breakthroughs.length === 0) {
    panel.style.display = "none";
    return;
  }

  let html = '<div class="habit-report-content">';
  html += '<div class="habit-report-title">Patterns</div>';

  // Habits (⚠️ recurring weaknesses)
  for (const h of report.habits) {
    const label = h.category.charAt(0).toUpperCase() + h.category.slice(1);
    html += `
      <div class="habit-item habit-weakness">
        <span class="habit-badge">⚠️</span>
        <div class="habit-detail">
          <div class="habit-label">${escapeHtml(label)} <span class="habit-avg">${h.averageScore}/10</span></div>
          <div class="habit-desc">Below threshold for ${h.speechCount} consecutive speeches</div>
        </div>
      </div>`;
  }

  // Breakthroughs (🎉 sustained improvements)
  for (const b of report.breakthroughs) {
    const label = b.category.charAt(0).toUpperCase() + b.category.slice(1);
    const gain = b.scores[b.scores.length - 1] - b.scores[0];
    html += `
      <div class="habit-item habit-breakthrough">
        <span class="habit-badge">🎉</span>
        <div class="habit-detail">
          <div class="habit-label">${escapeHtml(label)} <span class="habit-gain">+${gain}</span></div>
          <div class="habit-desc">Improved over ${b.speechCount} speeches</div>
        </div>
      </div>`;
  }

  html += `<div class="habit-meta">Based on ${report.evaluationCount} evaluations</div>`;
  html += '</div>';

  panel.innerHTML = html;
  panel.style.display = "block";
}

// --- Goals (#153) --------------------------------------------------------

let currentGoalsSpeaker = null;

async function fetchGoals(speaker) {
  const res = await fetch(`/api/goals/${encodeURIComponent(speaker)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function saveGoalsToServer(speaker, goals) {
  const res = await fetch(`/api/goals/${encodeURIComponent(speaker)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goals }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderGoalsPanel(data) {
  const panel = document.getElementById("goals-panel");
  if (!panel) return;

  const { goals, evaluations } = data;

  let html = '<div class="goals-content">';
  html += '<div class="goals-header">';
  html += '<span class="goals-title">🎯 Goals</span>';
  html += '</div>';

  if (evaluations && evaluations.length > 0) {
    for (const ev of evaluations) {
      const g = ev.goal;
      const metClass = ev.met ? "goal-met" : "goal-not-met";
      const icon = ev.met ? "🎉" : "⚠️";
      const metricLabel = g.metric === "wpm" ? "WPM"
        : g.metric === "filler_frequency" ? "Fillers/min"
        : `${(g.category || "").charAt(0).toUpperCase() + (g.category || "").slice(1)} Score`;
      const targetLabel = g.direction === "between"
        ? `${g.target}–${g.targetHigh}`
        : `${g.direction === "above" ? "≥" : "≤"} ${g.target}`;
      const currentLabel = ev.currentValue !== null ? String(Math.round(ev.currentValue * 10) / 10) : "—";
      const pct = ev.currentValue !== null
        ? Math.min(100, Math.round((ev.currentValue / (g.targetHigh || g.target)) * 100))
        : 0;

      html += `
        <div class="goal-item ${metClass}">
          <span class="goal-icon">${icon}</span>
          <div class="goal-detail">
            <div class="goal-label">${escapeHtml(metricLabel)}: ${escapeHtml(targetLabel)}</div>
            <div class="goal-bar-track">
              <div class="goal-bar-fill ${metClass}" style="width:${pct}%"></div>
            </div>
            <div class="goal-current">Current: ${escapeHtml(currentLabel)}</div>
          </div>
          <button class="goal-delete-btn" data-goal-id="${escapeHtml(g.id)}" title="Remove goal">✕</button>
        </div>`;
    }
  }

  // Add goal form
  html += `
    <details class="goal-add-form">
      <summary>+ Add Goal</summary>
      <div class="goal-form-fields">
        <select id="goal-metric">
          <option value="wpm">Words Per Minute</option>
          <option value="filler_frequency">Filler Frequency</option>
          <option value="category_score">Category Score</option>
        </select>
        <select id="goal-category" style="display:none;">
          <option value="delivery">Delivery</option>
          <option value="content">Content</option>
          <option value="structure">Structure</option>
          <option value="engagement">Engagement</option>
        </select>
        <select id="goal-direction">
          <option value="above">Above</option>
          <option value="below">Below</option>
          <option value="between">Between</option>
        </select>
        <input id="goal-target" type="number" placeholder="Target" step="0.1" />
        <input id="goal-target-high" type="number" placeholder="Upper" step="0.1" style="display:none;" />
        <button id="goal-add-btn" class="btn goal-submit-btn">Add</button>
      </div>
    </details>`;

  html += '</div>';
  panel.innerHTML = html;
  panel.style.display = "block";

  // Wire up metric change → show/hide category
  const metricSel = panel.querySelector("#goal-metric");
  const catSel = panel.querySelector("#goal-category");
  const dirSel = panel.querySelector("#goal-direction");
  const highInput = panel.querySelector("#goal-target-high");
  if (metricSel) metricSel.addEventListener("change", () => {
    catSel.style.display = metricSel.value === "category_score" ? "" : "none";
  });
  if (dirSel) dirSel.addEventListener("change", () => {
    highInput.style.display = dirSel.value === "between" ? "" : "none";
  });

  // Wire add button
  const addBtn = panel.querySelector("#goal-add-btn");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const metric = metricSel.value;
    const direction = dirSel.value;
    const target = parseFloat(panel.querySelector("#goal-target").value);
    if (isNaN(target)) return;
    const newGoal = {
      id: crypto.randomUUID(),
      metric,
      direction,
      target,
      created: new Date().toISOString(),
    };
    if (metric === "category_score") newGoal.category = catSel.value;
    if (direction === "between") {
      const high = parseFloat(highInput.value);
      if (!isNaN(high)) newGoal.targetHigh = high;
    }
    const allGoals = [...(goals || []), newGoal];
    try {
      const result = await saveGoalsToServer(currentGoalsSpeaker, allGoals);
      renderGoalsPanel(result);
    } catch (e) {
      console.warn("[Goals] Failed to save:", e);
    }
  });

  // Wire delete buttons
  panel.querySelectorAll(".goal-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const goalId = btn.dataset.goalId;
      const remaining = (goals || []).filter((g) => g.id !== goalId);
      try {
        const result = await saveGoalsToServer(currentGoalsSpeaker, remaining);
        renderGoalsPanel(result);
      } catch (e) {
        console.warn("[Goals] Failed to delete:", e);
      }
    });
  });
}

// --- Comparison (#154) ---------------------------------------------------

function handleCompareToggle(index, checked) {
  if (checked) {
    if (compareSelections.length >= 2) {
      // Uncheck the oldest selection
      const oldIdx = compareSelections.shift();
      const oldCheckbox = document.querySelector(`.compare-checkbox[data-index="${oldIdx}"]`);
      if (oldCheckbox) oldCheckbox.checked = false;
    }
    compareSelections.push(index);
  } else {
    compareSelections = compareSelections.filter((i) => i !== index);
  }

  // Render or hide comparison panel
  if (compareSelections.length === 2) {
    renderComparisonPanel(compareSelections[0], compareSelections[1]);
  } else {
    const panel = document.getElementById("compare-panel");
    if (panel) panel.style.display = "none";
  }
}

function renderComparisonPanel(idxA, idxB) {
  const panel = document.getElementById("compare-panel");
  if (!panel) return;

  const a = historyResults[idxA];
  const b = historyResults[idxB];
  if (!a || !b) return;

  const ma = a.metadata;
  const mb = b.metadata;

  // Metric diff helper
  const delta = (va, vb, invert) => {
    const d = vb - va;
    if (Math.abs(d) < 0.01) return '<span class="delta-neutral">—</span>';
    const isGood = invert ? d < 0 : d > 0;
    const arrow = d > 0 ? "↑" : "↓";
    const cls = isGood ? "delta-good" : "delta-bad";
    return `<span class="${cls}">${arrow} ${Math.abs(Math.round(d * 10) / 10)}</span>`;
  };

  let html = '<div class="compare-content">';
  html += '<div class="compare-header">';
  html += '<span class="compare-title">⚖️ Comparison</span>';
  html += '<button id="compare-clear" class="btn compare-clear-btn">Clear</button>';
  html += '</div>';

  // Side-by-side metric table
  html += '<table class="compare-table">';
  html += '<thead><tr>';
  html += `<th></th>`;
  html += `<th>${escapeHtml(ma.speechTitle || "Untitled")}<br><small>${escapeHtml(formatDate(ma.date))}</small></th>`;
  html += `<th>${escapeHtml(mb.speechTitle || "Untitled")}<br><small>${escapeHtml(formatDate(mb.date))}</small></th>`;
  html += '<th>Delta</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  // WPM
  html += `<tr><td>WPM</td><td>${Math.round(ma.wordsPerMinute)}</td><td>${Math.round(mb.wordsPerMinute)}</td><td>${delta(ma.wordsPerMinute, mb.wordsPerMinute)}</td></tr>`;

  // Duration
  html += `<tr><td>Duration</td><td>${formatDuration(ma.durationSeconds)}</td><td>${formatDuration(mb.durationSeconds)}</td><td>${delta(ma.durationSeconds, mb.durationSeconds)}</td></tr>`;

  // Pass Rate
  const prA = typeof ma.passRate === "number" ? Math.round(ma.passRate * 100) : "—";
  const prB = typeof mb.passRate === "number" ? Math.round(mb.passRate * 100) : "—";
  html += `<tr><td>Pass Rate</td><td>${prA}%</td><td>${prB}%</td><td>${typeof ma.passRate === "number" && typeof mb.passRate === "number" ? delta(ma.passRate * 100, mb.passRate * 100) : "—"}</td></tr>`;

  html += '</tbody></table>';
  html += '</div>';

  panel.innerHTML = html;
  panel.style.display = "block";

  // Wire clear button
  const clearBtn = panel.querySelector("#compare-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      compareSelections = [];
      document.querySelectorAll(".compare-checkbox").forEach((cb) => { cb.checked = false; });
      panel.style.display = "none";
    });
  }
}

// --- Rendering ------------------------------------------------------------

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatPassRate(rate) {
  return `${Math.round(rate * 100)}%`;
}

function renderHistoryItem(item, index) {
  const { metadata, urls } = item;
  const div = document.createElement("div");
  div.className = "history-item";
  div.setAttribute("data-index", String(index));

  const passRateClass = metadata.passRate >= 0.7 ? "pass-good" : metadata.passRate >= 0.4 ? "pass-fair" : "pass-poor";

  div.innerHTML = `
    <div class="history-item-header" role="button" tabindex="0" aria-expanded="false">
      <label class="compare-checkbox-label" title="Select for comparison">
        <input type="checkbox" class="compare-checkbox" data-index="${index}" />
      </label>
      <div class="history-item-meta">
        <span class="history-date">${escapeHtml(formatDate(metadata.date))}</span>
        <span class="history-title">${escapeHtml(metadata.speechTitle || "Untitled")}</span>
      </div>
      <div class="history-item-stats">
        ${metadata.projectType ? `<span class="history-tag">${escapeHtml(metadata.projectType)}</span>` : ""}
        <span class="history-stat">${formatDuration(metadata.durationSeconds)}</span>
        <span class="history-stat">${Math.round(metadata.wordsPerMinute)} WPM</span>
        <span class="history-pass ${passRateClass}">${formatPassRate(metadata.passRate)}</span>
        <span class="history-expand-icon">▸</span>
      </div>
    </div>
    <div class="history-item-detail" style="display:none;"></div>
  `;

  // Click to expand
  const header = div.querySelector(".history-item-header");
  header.addEventListener("click", (e) => {
    // Don't expand when clicking the compare checkbox
    if (e.target.classList.contains("compare-checkbox") || e.target.classList.contains("compare-checkbox-label")) return;
    toggleHistoryDetail(div, item);
  });
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleHistoryDetail(div, item);
    }
  });

  // Compare checkbox handler (#154)
  const checkbox = div.querySelector(".compare-checkbox");
  if (checkbox) {
    checkbox.addEventListener("change", () => {
      handleCompareToggle(index, checkbox.checked);
    });
    // Stop click from bubbling to header
    checkbox.addEventListener("click", (e) => e.stopPropagation());
  }

  return div;
}

async function toggleHistoryDetail(div, item) {
  const detail = div.querySelector(".history-item-detail");
  const header = div.querySelector(".history-item-header");
  const icon = div.querySelector(".history-expand-icon");
  const isExpanded = detail.style.display !== "none";

  if (isExpanded) {
    detail.style.display = "none";
    header.setAttribute("aria-expanded", "false");
    icon.textContent = "▸";
    return;
  }

  // Expand
  header.setAttribute("aria-expanded", "true");
  icon.textContent = "▾";
  detail.style.display = "block";
  detail.innerHTML = '<div class="history-loading-detail">Loading evaluation...</div>';

  try {
    // Fetch evaluation data from signed URL
    const { urls } = item;
    let evalData = null;
    if (urls.evaluation) {
      const res = await fetch(urls.evaluation);
      if (res.ok) evalData = await res.json();
    }

    let html = '<div class="history-detail-content">';

    // Audio player
    if (urls.audio) {
      html += `
        <div class="history-audio-section">
          <button class="history-play-btn" data-src="${escapeHtml(urls.audio)}">▶ Play Evaluation</button>
          <audio class="history-audio-player" preload="none"></audio>
        </div>
      `;
    }

    // Evaluation items
    if (evalData && evalData.evaluation) {
      const evaluation = evalData.evaluation;

      if (evaluation.opening) {
        html += `<div class="history-eval-opening">${escapeHtml(evaluation.opening)}</div>`;
      }

      if (evaluation.items && evaluation.items.length > 0) {
        html += '<div class="history-eval-items">';

        // Non-classic styles: render style_items if present (#135)
        if (evaluation.evaluation_style && evaluation.evaluation_style !== "classic"
            && evaluation.style_items && evaluation.style_items.length > 0) {
          for (const si of evaluation.style_items) {
            html += renderHistoryStyleItem(si, evaluation.evaluation_style);
          }
        } else {
          // Classic: commendation/recommendation cards
          for (const ei of evaluation.items) {
            const typeIcon = ei.type === "commendation" ? "✅" : "💡";
            html += `
              <div class="history-eval-item ${ei.type}">
                <div class="history-eval-item-header">${typeIcon} <strong>${escapeHtml(ei.summary)}</strong></div>
                <div class="history-eval-item-body">${escapeHtml(ei.explanation)}</div>
                ${ei.evidence_quote ? `<div class="history-eval-evidence">"${escapeHtml(ei.evidence_quote)}"</div>` : ""}
              </div>
            `;
          }
        }

        html += "</div>";
      }

      // Category scores bar chart (#144)
      if (evaluation.category_scores && evaluation.category_scores.length > 0) {
        html += '<div class="history-category-scores">';
        html += '<div class="category-scores-label">Category Scores</div>';
        html += '<div class="category-scores-bars">';
        for (const cs of evaluation.category_scores) {
          const pct = Math.round((cs.score / 10) * 100);
          const colorClass = cs.score >= 7 ? "score-good" : cs.score >= 4 ? "score-fair" : "score-poor";
          const categoryLabel = cs.category.charAt(0).toUpperCase() + cs.category.slice(1);
          html += `
            <div class="category-score-row">
              <span class="category-score-name">${escapeHtml(categoryLabel)}</span>
              <div class="category-score-track">
                <div class="category-score-fill ${colorClass}" style="width:${pct}%"></div>
              </div>
              <span class="category-score-value">${cs.score}</span>
            </div>
          `;
        }
        html += '</div>';
        if (evaluation.category_scores.some(cs => cs.rationale && cs.rationale !== "No rationale provided")) {
          html += '<details class="category-scores-rationale"><summary>View rationales</summary>';
          for (const cs of evaluation.category_scores) {
            if (cs.rationale && cs.rationale !== "No rationale provided") {
              const categoryLabel = cs.category.charAt(0).toUpperCase() + cs.category.slice(1);
              html += `<div class="rationale-item"><strong>${escapeHtml(categoryLabel)}:</strong> ${escapeHtml(cs.rationale)}</div>`;
            }
          }
          html += '</details>';
        }
        html += '</div>';
      }

      if (evaluation.closing) {
        html += `<div class="history-eval-closing">${escapeHtml(evaluation.closing)}</div>`;
      }
    } else {
      html += '<div class="history-no-eval">Evaluation data unavailable.</div>';
    }

    // Links
    html += '<div class="history-links">';
    if (urls.transcript) html += `<a href="${escapeHtml(urls.transcript)}" target="_blank" class="history-link">📄 Transcript</a>`;
    if (urls.metrics) html += `<a href="${escapeHtml(urls.metrics)}" target="_blank" class="history-link">📊 Metrics</a>`;
    html += `<button class="history-export-btn" title="Export as Markdown">📄 Export</button>`;
    html += `<button class="history-share-btn" title="Create shareable link">🔗 Share</button>`;
    html += `<button class="history-delete-btn" title="Delete this evaluation">🗑️ Delete</button>`;
    html += "</div>";

    html += "</div>";
    detail.innerHTML = html;

    // Wire audio play button
    const playBtn = detail.querySelector(".history-play-btn");
    if (playBtn) {
      const audio = detail.querySelector(".history-audio-player");
      playBtn.addEventListener("click", () => {
        if (audio.paused || !audio.src) {
          audio.src = playBtn.getAttribute("data-src");
          audio.play();
          playBtn.textContent = "⏸ Pause";
        } else {
          audio.pause();
          playBtn.textContent = "▶ Play Evaluation";
        }
      });
      audio.addEventListener("ended", () => {
        playBtn.textContent = "▶ Play Evaluation";
      });
    }
    // Wire delete button (#128)
    const deleteBtn = detail.querySelector(".history-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = confirm(`Delete evaluation "${item.metadata.speechTitle || "Untitled"}"? This cannot be undone.`);
        if (!ok) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Deleting...";
        try {
          await deleteEvaluationApi(item.metadata.speakerName, item.metadata.prefix);
          // Remove from list
          div.remove();
          historyResults = historyResults.filter(r => r.metadata.prefix !== item.metadata.prefix);
          if (historyResults.length === 0) {
            const emptyEl = getHistoryEmpty();
            if (emptyEl) emptyEl.style.display = "block";
          }
        } catch (err) {
          console.error("[History] Failed to delete:", err);
          deleteBtn.textContent = "🗑️ Delete";
          deleteBtn.disabled = false;
          alert("Failed to delete: " + err.message);
        }
      });
    }

    // Wire export button (#164)
    const exportBtn = detail.querySelector(".history-export-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        exportBtn.disabled = true;
        exportBtn.textContent = "Exporting...";
        try {
          // Extract the speaker-relative prefix from the full GCS prefix
          // Full prefix: results/alice-speaker/2026-03-21-1700-title/
          // We need: alice-speaker/2026-03-21-1700-title/
          const prefix = item.metadata.prefix;
          const relativePath = prefix.replace(/^results\//, "");
          const speaker = encodeURIComponent(item.metadata.speakerName);
          const res = await fetch(`/api/export/${speaker}/${relativePath}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${item.metadata.speechTitle || "evaluation"}-${(item.metadata.date || "").split("T")[0] || "report"}.md`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          exportBtn.textContent = "📄 Export";
          exportBtn.disabled = false;
        } catch (err) {
          console.error("[History] Failed to export:", err);
          exportBtn.textContent = "📄 Export";
          exportBtn.disabled = false;
          alert("Failed to export: " + err.message);
        }
      });
    }

    // Wire share button (#164)
    const shareBtn = detail.querySelector(".history-share-btn");
    if (shareBtn) {
      shareBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        shareBtn.disabled = true;
        shareBtn.textContent = "Creating...";
        try {
          const res = await fetch("/api/share", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ evalPrefix: item.metadata.prefix }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const shareUrl = `${window.location.origin}${data.url}`;
          await navigator.clipboard.writeText(shareUrl);
          shareBtn.textContent = "✅ Copied!";
          setTimeout(() => {
            shareBtn.textContent = "🔗 Share";
            shareBtn.disabled = false;
          }, 2000);
        } catch (err) {
          console.error("[History] Failed to share:", err);
          shareBtn.textContent = "🔗 Share";
          shareBtn.disabled = false;
          alert("Failed to create share link: " + err.message);
        }
      });
    }
  } catch (err) {
    detail.innerHTML = `<div class="history-error">Failed to load evaluation: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── Style Item Rendering for History (#135) ───────────────────────

/** Style field configuration (mirrors transcript.js STYLE_FIELD_CONFIG) */
const HISTORY_STYLE_CONFIG = {
  sbi: {
    icon: (item) => item.valence === "positive" ? "✅" : "💡",
    fields: [
      { key: "situation", label: "Situation" },
      { key: "behavior", label: "Behavior" },
      { key: "impact", label: "Impact" },
    ],
  },
  feedforward: {
    icon: () => "🔮",
    fields: [
      { key: "observation", label: "Observation" },
      { key: "nextTime", label: "Next Time" },
    ],
  },
  coin: {
    icon: () => "🪙",
    fields: [
      { key: "context", label: "Context" },
      { key: "observation", label: "Observation" },
      { key: "impact", label: "Impact" },
      { key: "nextSteps", label: "Next Steps" },
    ],
  },
  holistic: {
    icon: (item) => ({ heard: "👂", saw: "👁️", felt: "💭" }[item.category] || "📝"),
    fields: [
      { key: "category", label: "Category" },
      { key: "observation", label: "Observation" },
      { key: "detail", label: "Detail" },
    ],
  },
};

function renderHistoryStyleItem(item, evaluationStyle) {
  const config = HISTORY_STYLE_CONFIG[evaluationStyle];
  if (!config) return `<div class="history-eval-item"><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></div>`;

  const icon = config.icon(item);
  let fieldsHtml = "";
  for (const f of config.fields) {
    const val = item[f.key];
    if (!val) continue;
    fieldsHtml += `<div class="style-item-field"><span class="style-field-label">${escapeHtml(f.label)}</span><span class="style-field-value">${escapeHtml(val)}</span></div>`;
  }

  return `<div class="style-item-card"><div class="style-item-header">${icon}</div>${fieldsHtml}</div>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Load History ───────────────────────────────────────────────────

export async function loadHistory(speaker) {
  if (!speaker || speaker.trim().length === 0) return;
  if (historyLoading) return;

  // If speaker changed, reset
  if (speaker !== historySpeaker) {
    historySpeaker = speaker;
    historyResults = [];
    historyNextCursor = null;
    historyLoaded = false;
  }

  historyLoading = true;
  const spinner = getHistorySpinner();
  const emptyEl = getHistoryEmpty();
  const listEl = getHistoryList();
  const loadMoreBtn = getHistoryLoadMore();

  if (spinner) spinner.style.display = "flex";
  if (emptyEl) emptyEl.style.display = "none";
  if (loadMoreBtn) loadMoreBtn.style.display = "none";

  try {
    const data = await fetchHistory(speaker, historyNextCursor);
    historyNextCursor = data.nextCursor || null;
    historyLoaded = true;

    // Fetch progress data on first load (#140)
    if (!historyNextCursor || historyResults.length === 0) {
      try {
        const progress = await fetchProgress(speaker);
        renderProgressPanel(progress);
      } catch (progressErr) {
        console.warn("[History] Progress chart unavailable:", progressErr);
      }

      // Improvement plan (#145) — fire-and-forget
      fetchImprovementPlan(speaker)
        .then(renderImprovementPlan)
        .catch((e) => console.warn("[History] Improvement plan unavailable:", e));

      // Habit report (#147) — fire-and-forget
      fetchHabits(speaker)
        .then(renderHabitReport)
        .catch((e) => console.warn("[History] Habit report unavailable:", e));

      // Goals (#153) — fire-and-forget
      currentGoalsSpeaker = speaker;
      fetchGoals(speaker)
        .then(renderGoalsPanel)
        .catch((e) => console.warn("[History] Goals unavailable:", e));
    }

    if (data.results.length === 0 && historyResults.length === 0) {
      // Empty state
      if (emptyEl) emptyEl.style.display = "block";
    } else {
      // Append results
      for (const item of data.results) {
        historyResults.push(item);
        const el = renderHistoryItem(item, historyResults.length - 1);
        if (listEl) listEl.appendChild(el);
      }

      // Show/hide load more
      if (loadMoreBtn) {
        loadMoreBtn.style.display = historyNextCursor ? "block" : "none";
      }
    }
  } catch (err) {
    console.error("[History] Failed to load:", err);
    if (listEl) {
      const errDiv = document.createElement("div");
      errDiv.className = "history-error";
      errDiv.textContent = "Failed to load evaluation history. Please try again.";
      listEl.appendChild(errDiv);
    }
  } finally {
    historyLoading = false;
    if (spinner) spinner.style.display = "none";
  }
}

// ─── Reset (on speaker change) ──────────────────────────────────────

export function resetHistory() {
  historyLoaded = false;
  historyLoading = false;
  historyNextCursor = null;
  historySpeaker = "";
  historyResults = [];

  const listEl = getHistoryList();
  if (listEl) listEl.innerHTML = "";

  const emptyEl = getHistoryEmpty();
  if (emptyEl) emptyEl.style.display = "none";

  const progressPanel = document.getElementById("progress-panel");
  if (progressPanel) { progressPanel.style.display = "none"; progressPanel.innerHTML = ""; }
  const goalsPanel = document.getElementById("goals-panel");
  if (goalsPanel) { goalsPanel.style.display = "none"; goalsPanel.innerHTML = ""; }
}

export function isHistoryLoaded() {
  return historyLoaded;
}

// ─── Meeting History (#176) ──────────────────────────────────────────────────

let meetingsLoaded = false;

export async function loadMeetingHistory() {
  if (meetingsLoaded) return;
  const meetingsPanel = document.getElementById("meetings-panel");
  if (!meetingsPanel) return;

  try {
    const resp = await fetch("/api/meetings");
    if (!resp.ok) return;
    const { results } = await resp.json();

    if (results.length === 0) {
      meetingsPanel.style.display = "none";
      return;
    }

    meetingsPanel.style.display = "";
    meetingsPanel.innerHTML = `<h3 class="history-section-title">Meetings</h3>`;

    for (const meeting of results) {
      const card = document.createElement("div");
      card.className = "meeting-history-card";
      card.innerHTML = `
        <div class="meeting-history-header" data-meeting-id="${meeting.meetingId}">
          <span class="meeting-history-date">${meeting.meetingDate}</span>
          ${meeting.clubName ? `<span class="meeting-history-club">${escapeHtml(meeting.clubName)}</span>` : ""}
          <span class="meeting-history-count">${meeting.completedCount}/${meeting.slotCount} speakers</span>
          <button class="btn-icon meeting-history-expand" data-meeting-id="${meeting.meetingId}">▼</button>
        </div>
        <div class="meeting-history-detail" id="meeting-detail-${meeting.meetingId}" style="display:none;"></div>
      `;

      card.querySelector(".meeting-history-expand").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const detailEl = document.getElementById(`meeting-detail-${meeting.meetingId}`);
        if (!detailEl) return;

        if (detailEl.style.display !== "none") {
          detailEl.style.display = "none";
          btn.textContent = "▼";
          return;
        }

        btn.textContent = "▲";
        detailEl.style.display = "";
        detailEl.innerHTML = "<p style='color:var(--text-secondary);font-size:0.85em;'>Loading...</p>";

        try {
          const resp = await fetch(`/api/meetings/${meeting.meetingId}`);
          if (!resp.ok) throw new Error("Failed to load meeting");
          const { meeting: record, evaluations } = await resp.json();

          renderMeetingDetail(detailEl, record, evaluations);
        } catch (err) {
          detailEl.innerHTML = `<p style="color:var(--red-primary);">Failed to load meeting details</p>`;
        }
      });

      meetingsPanel.appendChild(card);
    }
    meetingsLoaded = true;
  } catch (err) {
    console.warn("Failed to load meetings:", err);
  }
}

function renderMeetingDetail(container, record, evaluations) {
  container.innerHTML = "";

  if (!record.slots || record.slots.length === 0) {
    container.innerHTML = "<p style='color:var(--text-secondary);'>No speakers in this meeting.</p>";
    return;
  }

  for (const slot of record.slots) {
    const eval_ = evaluations.find((e) => {
      // Match by prefix containing the slotId
      return e.prefix.includes(`/slots/${slot.slotId}/`);
    });

    const row = document.createElement("div");
    row.className = `meeting-eval-row meeting-eval-row--${slot.status}`;

    const icon = slot.type === "speech" ? "🎤" : "💬";
    const title = slot.projectTitle ? ` — ${escapeHtml(slot.projectTitle)}` : "";

    if (slot.status === "completed" && eval_) {
      row.innerHTML = `
        <span>${icon} <strong>${escapeHtml(slot.speakerName)}</strong>${title}</span>
        <span class="meeting-eval-meta">
          ${eval_.metadata.wordsPerMinute ? `${Math.round(eval_.metadata.wordsPerMinute)} WPM` : ""}
          ${eval_.metadata.durationSeconds ? ` · ${Math.round(eval_.metadata.durationSeconds)}s` : ""}
        </span>
        <div class="meeting-eval-actions">
          ${eval_.urls.evaluation_audio ? `<button class="btn btn--sm" data-audio-url="${eval_.urls.evaluation_audio}">▶ Play</button>` : ""}
        </div>
      `;

      const playBtn = row.querySelector("[data-audio-url]");
      if (playBtn) {
        playBtn.addEventListener("click", () => {
          playMeetingAudio(playBtn.dataset.audioUrl, playBtn);
        });
      }
    } else if (slot.status === "skipped") {
      row.innerHTML = `<span>${icon} <s>${escapeHtml(slot.speakerName)}</s>${title}</span><span style="color:var(--text-secondary);font-size:0.85em;">Skipped</span>`;
    } else {
      row.innerHTML = `<span>${icon} ${escapeHtml(slot.speakerName)}${title}</span>`;
    }

    container.appendChild(row);
  }
}

let meetingAudioElement = null;
let activeMeetingPlayBtn = null;

function playMeetingAudio(url, btn) {
  // Stop any currently playing audio
  if (meetingAudioElement) {
    meetingAudioElement.pause();
    meetingAudioElement = null;
    if (activeMeetingPlayBtn) {
      activeMeetingPlayBtn.textContent = "▶ Play";
      activeMeetingPlayBtn = null;
    }

    // If same button clicked, just stop
    if (btn === activeMeetingPlayBtn) return;
  }

  meetingAudioElement = new Audio(url);
  activeMeetingPlayBtn = btn;
  btn.textContent = "⏹ Stop";

  meetingAudioElement.onended = () => {
    btn.textContent = "▶ Play";
    meetingAudioElement = null;
    activeMeetingPlayBtn = null;
  };

  meetingAudioElement.onerror = () => {
    btn.textContent = "▶ Play";
    meetingAudioElement = null;
    activeMeetingPlayBtn = null;
  };

  meetingAudioElement.play().catch(() => {
    btn.textContent = "▶ Play";
    meetingAudioElement = null;
    activeMeetingPlayBtn = null;
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
