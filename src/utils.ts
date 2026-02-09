// Shared utilities for the AI Toastmasters Evaluator.
//
// This module contains deterministic helper functions used across multiple
// components (ToneChecker, TTSEngine, EvaluationGenerator) to ensure
// consistent behavior.

// ─── Common abbreviations that should NOT trigger a sentence split ───────────

/**
 * Set of common abbreviations (lowercase, without trailing period) that
 * should not be treated as sentence-ending punctuation.
 *
 * Categories:
 *  - Titles: Mr, Mrs, Ms, Dr, Prof, Rev, Sr, Jr, Sgt, Cpl, Gen, Col, Capt, Lt, Cmdr
 *  - Latin: e.g, i.e, etc, vs, viz, approx, ca
 *  - Address/place: St, Ave, Blvd, Rd, Dept, Bldg
 *  - Academic: Ph.D → handled as "Ph" (the "D." is a separate abbreviation)
 */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "rev",
  "sr",
  "jr",
  "sgt",
  "cpl",
  "gen",
  "col",
  "capt",
  "lt",
  "cmdr",
  "st",
  "ave",
  "blvd",
  "rd",
  "dept",
  "bldg",
  "vs",
  "etc",
  "approx",
  "ca",
  "ph",
]);

/**
 * Multi-character abbreviations that include internal periods (e.g., "e.g", "i.e").
 * These are matched as complete tokens before the general abbreviation check.
 */
const MULTI_PERIOD_ABBREVIATIONS = ["e.g", "i.e"];

/**
 * Title abbreviations that are almost always followed by a capitalized name.
 * These should NOT trigger a sentence split even when followed by a capital letter.
 */
const TITLE_ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "rev",
  "sr",
  "jr",
  "sgt",
  "cpl",
  "gen",
  "col",
  "capt",
  "lt",
  "cmdr",
  "st",
]);

// ─── splitSentences ─────────────────────────────────────────────────────────────

/**
 * Split text into sentences at sentence-ending punctuation (`.` `!` `?`),
 * preserving the punctuation with the preceding sentence.
 *
 * Handles:
 *  - Common abbreviations (Mr., Mrs., Dr., e.g., i.e., etc., vs., St.)
 *  - Decimal numbers (3.14, 0.5)
 *  - Ellipses (...)
 *  - Multiple punctuation (!! ?? !? ...)
 *  - Quoted sentences where punctuation is inside quotes
 *
 * Algorithm:
 *  1. Walk through the text character by character.
 *  2. When a sentence-ending punctuation mark is found, check whether it is
 *     followed by whitespace or end-of-string.
 *  3. If so, apply heuristics to determine whether this is a true sentence
 *     boundary or a false positive (abbreviation, decimal, ellipsis).
 *  4. If it is a true boundary, split here — the punctuation stays with the
 *     preceding sentence.
 *
 * @param text  The input text to segment into sentences.
 * @returns     An array of trimmed, non-empty sentence strings.
 */
export function splitSentences(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const sentences: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Only consider sentence-ending punctuation
    if (ch !== "." && ch !== "!" && ch !== "?") {
      continue;
    }

    // Consume any additional consecutive sentence-ending punctuation (e.g., "!!", "?!", "...")
    let punctEnd = i + 1;
    while (
      punctEnd < text.length &&
      (text[punctEnd] === "." || text[punctEnd] === "!" || text[punctEnd] === "?")
    ) {
      punctEnd++;
    }

    // The punctuation must be followed by whitespace or end-of-string to be a candidate
    const atEnd = punctEnd >= text.length;
    const followedByWhitespace = !atEnd && /\s/.test(text[punctEnd]);

    if (!atEnd && !followedByWhitespace) {
      // Punctuation is followed by a non-whitespace character — not a sentence boundary.
      // Advance past the punctuation cluster.
      i = punctEnd - 1;
      continue;
    }

    // ── Heuristic checks for false positives ──

    // 1. Check for decimal numbers: digit(s) + "." + digit(s)
    if (ch === "." && punctEnd === i + 1) {
      // Single period — check if it's a decimal point
      if (isDecimalPeriod(text, i)) {
        continue;
      }
    }

    // 2. Check for multi-period abbreviations (e.g., i.e.) — handled below in check 4

    // 3. Check for single-word abbreviations (Mr., Dr., etc.)
    //    But if the abbreviation is followed by a capitalized word, it may be
    //    doing double duty as both abbreviation period and sentence-ending period.
    //    We split in that case UNLESS the abbreviation is a title (Mr., Mrs., Dr., etc.)
    //    which is almost always followed by a capitalized name.
    if (ch === "." && punctEnd === i + 1 && isSingleWordAbbreviation(text, i)) {
      if (!isFollowedByCapitalizedWord(text, punctEnd) || isTitleAbbreviation(text, i)) {
        continue;
      }
    }

    // 4. Check for multi-period abbreviations at sentence end (e.g., i.e.)
    //    Same double-duty logic: if followed by a capital letter and not a title, split.
    if (ch === "." && punctEnd === i + 1 && isMultiPeriodAbbreviation(text, i)) {
      if (!isFollowedByCapitalizedWord(text, punctEnd)) {
        continue;
      }
    }

    // ── This is a true sentence boundary ──
    const sentenceText = text.slice(currentStart, punctEnd).trim();
    if (sentenceText.length > 0) {
      sentences.push(sentenceText);
    }
    currentStart = punctEnd;

    // Advance past the punctuation cluster (the for-loop will increment once more)
    i = punctEnd - 1;
  }

  // Capture any remaining text after the last sentence boundary
  const remaining = text.slice(currentStart).trim();
  if (remaining.length > 0) {
    sentences.push(remaining);
  }

  return sentences;
}

// ─── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Check if the period at position `dotIndex` is a decimal point.
 * A decimal period has a digit immediately before AND immediately after it.
 */
function isDecimalPeriod(text: string, dotIndex: number): boolean {
  if (dotIndex === 0 || dotIndex >= text.length - 1) return false;
  const before = text[dotIndex - 1];
  const after = text[dotIndex + 1];
  return /\d/.test(before) && /\d/.test(after);
}

/**
 * Check if the period at position `dotIndex` terminates a multi-period
 * abbreviation like "e.g." or "i.e.".
 */
function isMultiPeriodAbbreviation(text: string, dotIndex: number): boolean {
  for (const abbr of MULTI_PERIOD_ABBREVIATIONS) {
    // The abbreviation pattern is e.g. "e.g" + "." at dotIndex
    // So we look for the abbreviation text ending right before dotIndex+1
    const fullAbbr = abbr + ".";
    const startPos = dotIndex + 1 - fullAbbr.length;
    if (startPos < 0) continue;

    const candidate = text.slice(startPos, dotIndex + 1).toLowerCase();
    if (candidate === fullAbbr) {
      // Make sure it's at a word boundary (start of string or preceded by whitespace/punctuation)
      if (startPos === 0 || /[\s,;:(]/.test(text[startPos - 1])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if the period at position `dotIndex` terminates a known single-word
 * abbreviation (e.g., "Mr.", "Dr.", "St.").
 */
function isSingleWordAbbreviation(text: string, dotIndex: number): boolean {
  // Extract the word immediately before the period
  const word = extractWordBefore(text, dotIndex);
  if (!word) return false;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Extract the word immediately before position `pos` in the text.
 * A "word" is a contiguous sequence of alphabetic characters.
 * Returns null if no word is found.
 */
function extractWordBefore(text: string, pos: number): string | null {
  let end = pos;
  let start = end - 1;

  // Walk backwards over alphabetic characters
  while (start >= 0 && /[a-zA-Z]/.test(text[start])) {
    start--;
  }
  start++; // move back to first alpha char

  if (start >= end) return null;

  // Ensure the word starts at a word boundary
  if (start > 0 && /[a-zA-Z0-9]/.test(text[start - 1])) {
    return null; // part of a larger word
  }

  return text.slice(start, end);
}


/**
 * Check if the text after position `pos` starts with a capitalized word
 * (after skipping whitespace). This is used to detect sentence boundaries
 * after abbreviations.
 */
function isFollowedByCapitalizedWord(text: string, pos: number): boolean {
  // Skip whitespace
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  if (i >= text.length) return false;
  return /[A-Z]/.test(text[i]);
}

/**
 * Check if the period at position `dotIndex` terminates a title abbreviation
 * (Mr., Mrs., Dr., etc.) — these are almost always followed by a capitalized
 * name and should not trigger a sentence split.
 */
function isTitleAbbreviation(text: string, dotIndex: number): boolean {
  const word = extractWordBefore(text, dotIndex);
  if (!word) return false;
  return TITLE_ABBREVIATIONS.has(word.toLowerCase());
}
