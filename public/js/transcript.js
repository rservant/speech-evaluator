/**
 * Transcript rendering, evidence highlights, evaluation display, role results.
 * Extracted from app.js for ES module pattern (#110).
 */
import { S, dom } from "./state.js";
import { SessionState } from "./constants.js";
import { show, hide, formatTimestamp, escapeHtml } from "./utils.js";

// ─── UI Update: Transcript ────────────────────────────────────────
/**
 * Updates the transcript display using replaceFromIndex splice semantics.
 * The client maintains a local segment array and splices from
 * replaceFromIndex onward with the new S.segments.
 *
 * @param {Array} newSegments - Replacement suffix S.segments
 * @param {number} replaceFromIndex - Index to splice from
 */
export function updateTranscript(newSegments, replaceFromIndex) {
  // Splice local segment array
  S.segments.splice(replaceFromIndex, S.segments.length - replaceFromIndex, ...newSegments);

  // Render S.segments
  renderTranscript();
}

/**
 * Renders the current S.segments array into the transcript panel.
 */
export function renderTranscript() {
  if (S.segments.length === 0) {
    dom.transcriptContent.innerHTML =
      '<div class="transcript-empty">Transcript will appear here during recording...</div>';
    dom.transcriptWordCount.textContent = "";
    return;
  }

  let html = "";
  let totalWords = 0;

  for (let idx = 0; idx < S.segments.length; idx++) {
    const seg = S.segments[idx];
    const timeStr = formatTimestamp(seg.startTime);
    const cssClass = seg.isFinal ? "" : " interim";
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    totalWords += words.length;

    html += '<div class="segment' + cssClass + '"' +
      (seg.speakerId !== undefined ? ' data-speaker="' + seg.speakerId + '"' : '') +
      ' data-segment-index="' + idx + '">';
    html += '<span class="segment-time">[' + timeStr + ']</span>';
    if (seg.speakerId !== undefined) {
      html += '<span class="speaker-label speaker-' + (seg.speakerId % 6) + '">Speaker ' + (seg.speakerId + 1) + ':</span> ';
    }
    html += escapeHtml(seg.text);
    html += "</div>";
  }

  dom.transcriptContent.innerHTML = html;
  dom.transcriptWordCount.textContent = totalWords + " words";

  // Auto-scroll to bottom
  const panelBody = dom.transcriptContent.parentElement;
  panelBody.scrollTop = panelBody.scrollHeight;
}

// ─── Phase 3: Evidence Highlight Functions (Req 7.1-7.5) ────────

/**
 * Normalizes text for evidence quote matching.
 * Matches the server-side EvidenceValidator.normalize() logic:
 *  1. Lowercase
 *  2. Strip all non-alphanumeric non-whitespace characters
 *  3. Collapse consecutive whitespace to a single space
 *  4. Trim leading/trailing whitespace
 *
 * (Req 7.3)
 * @param {string} text - The text to normalize
 * @returns {string} Normalized text
 */
export function normalizeForMatch(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Finds the transcript segment that contains the given evidence quote.
 * Uses the same normalization rules as the server-side EvidenceValidator (Req 7.3).
 *
 * @param {string} quote - The evidence quote to find
 * @param {Array} segs - The transcript S.segments array
 * @returns {{segmentIndex: number, segment: Object}|null} Match result or null
 */
export function findTranscriptMatch(quote, segs) {
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length === 0) return null;

  for (let i = 0; i < segs.length; i++) {
    const segText = normalizeForMatch(segs[i].text);
    if (segText.includes(normalizedQuote)) {
      return { segmentIndex: i, segment: segs[i] };
    }
  }
  return null;
}

/**
 * Handles clicking on an evidence link in the evaluation panel.
 * Scrolls the transcript panel to the matching segment and highlights it.
 * Auto-dismisses the highlight after 3 seconds (Req 7.5).
 *
 * @param {string} quote - The evidence quote text
 */
export function onEvidenceLinkClick(quote) {
  // Clear any existing highlight and timer
  clearEvidenceHighlight();

  // Find the matching segment
  var match = findTranscriptMatch(quote, S.segments);
  if (!match) return;

  // Find the segment DOM element by data-segment-index
  var segEl = dom.transcriptContent.querySelector(
    '[data-segment-index="' + match.segmentIndex + '"]'
  );
  if (!segEl) return;

  // Add highlight class
  segEl.classList.add("segment-highlight");

  // Scroll the transcript panel to the highlighted segment
  var panelBody = dom.transcriptContent.parentElement;
  segEl.scrollIntoView({ behavior: "smooth", block: "center" });

  // Make sure the transcript panel is visible
  show(dom.transcriptPanel);

  // Auto-dismiss highlight after 3 seconds (Req 7.5)
  S.highlightDismissTimer = setTimeout(function () {
    clearEvidenceHighlight();
  }, 3000);
}

/**
 * Clears any active evidence highlight from the transcript panel.
 * Cancels the auto-dismiss timer if active (Req 7.5).
 */
export function clearEvidenceHighlight() {
  // Clear the timer
  if (S.highlightDismissTimer !== null) {
    clearTimeout(S.highlightDismissTimer);
    S.highlightDismissTimer = null;
  }

  // Remove highlight class from all S.segments
  var highlighted = dom.transcriptContent.querySelectorAll(".segment-highlight");
  for (var i = 0; i < highlighted.length; i++) {
    highlighted[i].classList.remove("segment-highlight");
  }
}

/**
 * Renders the evaluation text with evidence quotes as clickable links.
 * Evidence quotes from evaluation items are matched against the text
 * and wrapped in clickable <span> elements (Req 7.1).
 *
 * Redacted quotes (containing "[a fellow member]") will not match
 * transcript text and are displayed without clickable navigation (Req 7.4).
 *
 * @param {string} text - The evaluation script text
 * @param {Object|null} evaluationData - The StructuredEvaluationPublic object
 */
// ─── Style-Specific Rendering (#135) ─────────────────────────────

/** Field configuration for each evaluation style */
const STYLE_FIELD_CONFIG = {
  sbi: {
    label: "SBI",
    icon: (item) => item.valence === "positive" ? "✅" : "💡",
    fields: [
      { key: "situation", label: "Situation" },
      { key: "behavior", label: "Behavior" },
      { key: "impact", label: "Impact" },
    ],
  },
  feedforward: {
    label: "Feedforward",
    icon: () => "🔮",
    fields: [
      { key: "observation", label: "Observation" },
      { key: "nextTime", label: "Next Time" },
    ],
  },
  coin: {
    label: "COIN",
    icon: () => "🪙",
    fields: [
      { key: "context", label: "Context" },
      { key: "observation", label: "Observation" },
      { key: "impact", label: "Impact" },
      { key: "nextSteps", label: "Next Steps" },
    ],
  },
  holistic: {
    label: "Holistic",
    icon: (item) => {
      const icons = { heard: "👂", saw: "👁️", felt: "💭" };
      return icons[item.category] || "📝";
    },
    fields: [
      { key: "category", label: "Category" },
      { key: "observation", label: "Observation" },
      { key: "detail", label: "Detail" },
    ],
  },
  eec: {
    label: "EEC",
    icon: () => "🎯",
    fields: [
      { key: "example", label: "Example" },
      { key: "effect", label: "Effect" },
      { key: "change_or_continue", label: "Change / Continue" },
    ],
  },
  radical_candour: {
    label: "Radical Candour",
    icon: (item) => item.candour_type === "praise" ? "💪" : "🔥",
    fields: [
      { key: "observation", label: "Observation" },
      { key: "impact", label: "Impact" },
      { key: "suggestion", label: "Suggestion" },
    ],
  },
  socratic: {
    label: "Socratic",
    icon: () => "🤔",
    fields: [
      { key: "question", label: "Question" },
      { key: "context", label: "Context" },
      { key: "reflection_prompt", label: "Reflect" },
    ],
  },
  comparative: {
    label: "Comparative",
    icon: () => "⚖️",
    fields: [
      { key: "current_behavior", label: "What You Did" },
      { key: "improved_alternative", label: "Alternative" },
      { key: "rationale", label: "Why" },
    ],
  },
  micro_focus: {
    label: "Micro-Focus",
    icon: () => "🔬",
    fields: [
      { key: "focus_area", label: "Focus Area" },
      { key: "observation", label: "Observation" },
      { key: "deep_analysis", label: "Analysis" },
      { key: "exercises", label: "Exercises", isArray: true },
    ],
  },
};

/**
 * Renders style-specific evaluation items into a container element.
 * Each style has a distinct card layout with labeled fields.
 * Exported for reuse in history.js.
 *
 * @param {Array} styleItems - The style_items array from StructuredEvaluation
 * @param {string} evaluationStyle - The evaluation_style identifier
 * @returns {HTMLElement} A container div with rendered style items
 */
export function renderStyledItems(styleItems, evaluationStyle) {
  const container = document.createElement("div");
  container.className = "style-items-container";

  const config = STYLE_FIELD_CONFIG[evaluationStyle];
  if (!config || !Array.isArray(styleItems)) {
    // Unknown style — render raw JSON as fallback
    const fallback = document.createElement("pre");
    fallback.className = "style-items-fallback";
    fallback.textContent = JSON.stringify(styleItems, null, 2);
    container.appendChild(fallback);
    return container;
  }

  for (const item of styleItems) {
    const card = document.createElement("div");
    card.className = "style-item-card";

    // Header with icon
    const header = document.createElement("div");
    header.className = "style-item-header";
    const icon = config.icon(item);
    header.textContent = icon;
    card.appendChild(header);

    // Fields
    for (const fieldDef of config.fields) {
      const value = item[fieldDef.key];
      if (!value) continue;

      const field = document.createElement("div");
      field.className = "style-item-field";

      const label = document.createElement("span");
      label.className = "style-field-label";
      label.textContent = fieldDef.label;
      field.appendChild(label);

      if (fieldDef.isArray && Array.isArray(value)) {
        // Render array values as a numbered list
        const list = document.createElement("ol");
        list.className = "style-field-list";
        for (const entry of value) {
          const li = document.createElement("li");
          li.textContent = entry;
          list.appendChild(li);
        }
        field.appendChild(list);
      } else {
        const text = document.createElement("span");
        text.className = "style-field-value";
        text.textContent = value;
        field.appendChild(text);
      }

      card.appendChild(field);
    }

    container.appendChild(card);
  }

  return container;
}

/**
 * Renders category score bars as a DOM element.
 * Shared between live evaluation and history views.
 * Phase 8 — #144
 */
/**
 * Builds an SVG-based radar (spider) chart for category scores.
 * Pure SVG — no external dependencies.
 * @param {Array<{category: string, score: number}>} scores
 * @returns {SVGElement}
 */
function renderCategoryRadar(scores) {
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = 75;
  const levels = 5; // concentric rings (2, 4, 6, 8, 10)
  const n = scores.length;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "category-radar-svg");

  // Helper: angle for axis i (start from top, go clockwise)
  const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const px = (i, r) => cx + r * Math.cos(angle(i));
  const py = (i, r) => cy + r * Math.sin(angle(i));

  // Grid rings
  for (let lv = 1; lv <= levels; lv++) {
    const r = (lv / levels) * maxR;
    const pts = Array.from({ length: n }, (_, i) => `${px(i, r)},${py(i, r)}`).join(" ");
    const ring = document.createElementNS(ns, "polygon");
    ring.setAttribute("points", pts);
    ring.setAttribute("class", "radar-ring");
    svg.appendChild(ring);
  }

  // Axis lines
  for (let i = 0; i < n; i++) {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", String(cx));
    line.setAttribute("y1", String(cy));
    line.setAttribute("x2", String(px(i, maxR)));
    line.setAttribute("y2", String(py(i, maxR)));
    line.setAttribute("class", "radar-axis");
    svg.appendChild(line);
  }

  // Data polygon
  const dataR = scores.map((s) => (s.score / 10) * maxR);
  const dataPts = scores.map((_, i) => `${px(i, dataR[i])},${py(i, dataR[i])}`).join(" ");
  const dataPoly = document.createElementNS(ns, "polygon");
  dataPoly.setAttribute("points", dataPts);
  dataPoly.setAttribute("class", "radar-data");
  svg.appendChild(dataPoly);

  // Data dots + labels
  for (let i = 0; i < n; i++) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(px(i, dataR[i])));
    dot.setAttribute("cy", String(py(i, dataR[i])));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "radar-dot");
    svg.appendChild(dot);

    // Category label
    const labelR = maxR + 16;
    const lbl = document.createElementNS(ns, "text");
    lbl.setAttribute("x", String(px(i, labelR)));
    lbl.setAttribute("y", String(py(i, labelR)));
    lbl.setAttribute("class", "radar-label");
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("dominant-baseline", "central");
    const catName = scores[i].category.charAt(0).toUpperCase() + scores[i].category.slice(1);
    lbl.textContent = `${catName} (${scores[i].score})`;
    svg.appendChild(lbl);
  }

  return svg;
}

export function renderCategoryScoresBar(categoryScores) {
  if (!categoryScores || !Array.isArray(categoryScores) || categoryScores.length === 0) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "history-category-scores";

  const label = document.createElement("div");
  label.className = "category-scores-label";
  label.textContent = "Category Scores";
  wrapper.appendChild(label);

  // Radar chart (#151)
  if (categoryScores.length >= 3) {
    const radarContainer = document.createElement("div");
    radarContainer.className = "category-radar-container";
    radarContainer.appendChild(renderCategoryRadar(categoryScores));
    wrapper.appendChild(radarContainer);
  }

  const bars = document.createElement("div");
  bars.className = "category-scores-bars";

  for (const cs of categoryScores) {
    const pct = Math.round((cs.score / 10) * 100);
    const colorClass = cs.score >= 7 ? "score-good" : cs.score >= 4 ? "score-fair" : "score-poor";
    const categoryLabel = cs.category.charAt(0).toUpperCase() + cs.category.slice(1);

    const row = document.createElement("div");
    row.className = "category-score-row";
    row.innerHTML = `
      <span class="category-score-name">${escapeHtml(categoryLabel)}</span>
      <div class="category-score-track">
        <div class="category-score-fill ${colorClass}" style="width:${pct}%"></div>
      </div>
      <span class="category-score-value">${cs.score}</span>
    `;
    bars.appendChild(row);
  }
  wrapper.appendChild(bars);

  // Collapsible rationales
  const hasRationale = categoryScores.some(cs => cs.rationale && cs.rationale !== "No rationale provided");
  if (hasRationale) {
    const details = document.createElement("details");
    details.className = "category-scores-rationale";
    const summary = document.createElement("summary");
    summary.textContent = "View rationales";
    details.appendChild(summary);

    for (const cs of categoryScores) {
      if (cs.rationale && cs.rationale !== "No rationale provided") {
        const item = document.createElement("div");
        item.className = "rationale-item";
        const catLabel = cs.category.charAt(0).toUpperCase() + cs.category.slice(1);
        item.innerHTML = `<strong>${escapeHtml(catLabel)}:</strong> ${escapeHtml(cs.rationale)}`;
        details.appendChild(item);
      }
    }
    wrapper.appendChild(details);
  }

  return wrapper;
}

/**
 * Renders the evaluation text with evidence quotes as clickable links.
 * Evidence quotes from evaluation items are matched against the text
 * and wrapped in clickable <span> elements (Req 7.1).
 *
 * For non-classic evaluation styles, renders style_items with
 * style-specific card layouts below the evaluation script (Req #135).
 *
 * Redacted quotes (containing "[a fellow member]") will not match
 * transcript text and are displayed without clickable navigation (Req 7.4).
 *
 * @param {string} text - The evaluation script text
 * @param {Object|null} evaluationData - The StructuredEvaluationPublic object
 */
export function renderEvaluationWithEvidence(text, evaluationData) {
  if (!text || text.trim().length === 0) {
    var emptyDiv = document.createElement("div");
    emptyDiv.className = "evaluation-empty";
    emptyDiv.textContent = "Evaluation will appear here after delivery...";
    dom.evaluationContent.textContent = "";
    dom.evaluationContent.appendChild(emptyDiv);
    return;
  }

  // Non-classic styles: render script text + styled cards
  if (evaluationData && evaluationData.evaluation_style && evaluationData.evaluation_style !== "classic"
      && evaluationData.style_items && evaluationData.style_items.length > 0) {
    dom.evaluationContent.textContent = "";

    // Render opening
    if (evaluationData.opening) {
      const openingDiv = document.createElement("div");
      openingDiv.className = "eval-section eval-opening";
      openingDiv.textContent = evaluationData.opening;
      dom.evaluationContent.appendChild(openingDiv);
    }

    // Render style items
    const styledContainer = renderStyledItems(evaluationData.style_items, evaluationData.evaluation_style);
    dom.evaluationContent.appendChild(styledContainer);

    // Render closing
    if (evaluationData.closing) {
      const closingDiv = document.createElement("div");
      closingDiv.className = "eval-section eval-closing";
      closingDiv.textContent = evaluationData.closing;
      dom.evaluationContent.appendChild(closingDiv);
    }

    // Category scores bar chart (#144)
    if (evaluationData.category_scores) {
      const scoresEl = renderCategoryScoresBar(evaluationData.category_scores);
      if (scoresEl) dom.evaluationContent.appendChild(scoresEl);
    }
    return;
  }

  // If no evaluation data with items, fall back to plain text rendering
  if (!evaluationData || !evaluationData.items || evaluationData.items.length === 0) {
    var plainDiv = document.createElement("div");
    plainDiv.textContent = text;
    dom.evaluationContent.textContent = "";
    dom.evaluationContent.appendChild(plainDiv);
    return;
  }

  // Build a list of evidence quotes with their match status.
  // Matching is done on the raw (unescaped) text.
  var evidenceQuotes = [];
  for (var i = 0; i < evaluationData.items.length; i++) {
    var item = evaluationData.items[i];
    if (item.evidence_quote && item.evidence_quote.trim().length > 0) {
      var match = findTranscriptMatch(item.evidence_quote, S.segments);
      evidenceQuotes.push({
        quote: item.evidence_quote,
        timestamp: item.evidence_timestamp,
        hasMatch: match !== null
      });
    }
  }

  // Sort evidence quotes by length descending to avoid partial replacement issues
  // (longer quotes should be replaced first)
  evidenceQuotes.sort(function (a, b) {
    return b.quote.length - a.quote.length;
  });

  // Find evidence quote positions in the raw text, tracking occupied ranges
  // to prevent overlapping replacements
  var quotePositions = []; // { start, end, quoteIndex }
  var occupiedRanges = [];

  for (var q = 0; q < evidenceQuotes.length; q++) {
    var ev = evidenceQuotes[q];
    var searchStart = 0;
    var foundIndex = -1;

    while (searchStart < text.length) {
      var idx = text.indexOf(ev.quote, searchStart);
      if (idx === -1) break;

      // Check overlap with occupied ranges
      var overlaps = false;
      for (var r = 0; r < occupiedRanges.length; r++) {
        if (idx < occupiedRanges[r].end && idx + ev.quote.length > occupiedRanges[r].start) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        foundIndex = idx;
        break;
      }
      searchStart = idx + 1;
    }

    if (foundIndex === -1) continue;

    quotePositions.push({ start: foundIndex, end: foundIndex + ev.quote.length, quoteIndex: q });
    occupiedRanges.push({ start: foundIndex, end: foundIndex + ev.quote.length });
  }

  // Sort positions by start offset for left-to-right DOM assembly
  quotePositions.sort(function (a, b) { return a.start - b.start; });

  // Build DOM: interleave text nodes with evidence span elements
  var container = document.createElement("div");
  var cursor = 0;

  for (var p = 0; p < quotePositions.length; p++) {
    var pos = quotePositions[p];
    var evData = evidenceQuotes[pos.quoteIndex];

    // Text before this quote
    if (pos.start > cursor) {
      container.appendChild(document.createTextNode(text.substring(cursor, pos.start)));
    }

    // Evidence span (created via DOM — no innerHTML)
    var span = document.createElement("span");
    span.textContent = evData.quote;

    if (evData.hasMatch) {
      // Clickable evidence link (Req 7.1)
      span.className = "evidence-link";
      span.dataset.quote = evData.quote;
      span.dataset.timestamp = evData.timestamp;
      span.title = "Click to navigate to transcript";
      span.addEventListener("click", (function (quote) {
        return function () { onEvidenceLinkClick(quote); };
      })(evData.quote));
    } else {
      // No match — display without clickable navigation (Req 7.4)
      span.className = "evidence-no-match";
    }

    container.appendChild(span);
    cursor = pos.end;
  }

  // Remaining text after the last quote
  if (cursor < text.length) {
    container.appendChild(document.createTextNode(text.substring(cursor)));
  }

  dom.evaluationContent.textContent = "";
  dom.evaluationContent.appendChild(container);

  // Category scores bar chart (#144)
  if (evaluationData && evaluationData.category_scores) {
    const scoresEl = renderCategoryScoresBar(evaluationData.category_scores);
    if (scoresEl) dom.evaluationContent.appendChild(scoresEl);
  }
}

// ─── UI Update: Evaluation ────────────────────────────────────────
/**
 * Displays the evaluation text in the evaluation panel.
 * Used both for normal display and as TTS fallback.
 * When evaluation data with evidence items is available,
 * renders evidence quotes as clickable links (Phase 3, Req 7.1).
 *
 * @param {string} text - The evaluation script text
 */
export function showEvaluation(text) {
  S.hasEvaluationData = true;

  if (!text || text.trim().length === 0) {
    dom.evaluationContent.innerHTML =
      '<div class="evaluation-empty">Evaluation will appear here after delivery...</div>';
    return;
  }

  // Use evidence-aware rendering when evaluation data is available
  renderEvaluationWithEvidence(text, S.lastEvaluationData);
  show(dom.evaluationPanel);

  // Auto-scroll to evaluation so feedback is visible (#181)
  setTimeout(() => {
    dom.evaluationPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

// ─── UI Update: Role Results Display ─────────────────────────────
/**
 * Displays meeting role results (e.g., Ah-Counter report) in a
 * dedicated panel below the evaluation.
 */
export function displayRoleResults(results) {
  if (!results || results.length === 0) return;

  // Find or create the role results container
  let container = document.getElementById("role-results-panel");
  if (!container) {
    container = document.createElement("div");
    container.id = "role-results-panel";
    container.style.cssText = "margin-top: 24px;";
    // Insert after evaluation panel
    const evalPanel = document.getElementById("evaluation-panel");
    if (evalPanel && evalPanel.parentNode) {
      evalPanel.parentNode.insertBefore(container, evalPanel.nextSibling);
    } else {
      document.querySelector(".main-content")?.appendChild(container);
    }
  }

  container.innerHTML = "";

  for (const role of results) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "margin-bottom: 16px; padding: 20px; border-left: 3px solid var(--red-primary, #e53935);";

    let html = `<h3 style="margin: 0 0 12px; color: var(--text-primary);">${escapeHtml(role.report.title)}</h3>`;

    for (const section of role.report.sections) {
      html += `<h4 style="margin: 12px 0 6px; color: var(--text-secondary); font-size: 0.9em; text-transform: uppercase;">${escapeHtml(section.heading)}</h4>`;
      html += `<p style="margin: 0 0 8px; color: var(--text-primary); white-space: pre-wrap;">${escapeHtml(section.content)}</p>`;
    }

    card.innerHTML = html;
    container.appendChild(card);
  }

  container.style.display = "block";
  showNotification(`${results.length} meeting role report(s) ready`, "success");
}



