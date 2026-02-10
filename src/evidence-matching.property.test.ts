// Property-Based Tests for Evidence Matching
// Feature: phase-3-semi-automation, UI-P1: Evidence quote normalization is consistent with EvidenceValidator

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { EvidenceValidator } from "./evidence-validator.js";

// ─── Client-side normalizeForMatch re-implementation ────────────────────────────
//
// This is the exact same logic as the client-side normalizeForMatch() function
// in public/index.html (lines 1965-1967). We re-implement it here in Node.js
// so we can verify it produces identical output to the server-side
// EvidenceValidator.normalize() for all inputs.
//
// Client-side source:
//   function normalizeForMatch(text) {
//     return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
//   }

/**
 * Client-side normalizeForMatch — re-implemented from public/index.html.
 * Lowercase, strip all non-alphanumeric non-whitespace characters,
 * collapse whitespace, trim.
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Server-side normalize reference ────────────────────────────────────────────

const validator = new EvidenceValidator();

/**
 * Server-side normalization via EvidenceValidator.normalize().
 */
function serverNormalize(text: string): string {
  return validator.normalize(text);
}

// ─── Generators ─────────────────────────────────────────────────────────────────

/**
 * Generator for strings that exercise normalization edge cases:
 * mixed case, punctuation, multiple whitespace types, unicode, etc.
 */
const ASCII_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  " \t\n\r.,!?;:'\"-()[]{}/@#$%^&*+=<>|~`_";

const arbitraryNormalizationInput = fc.oneof(
  // General unicode strings (broad coverage)
  fc.string({ minLength: 0, maxLength: 200 }),
  // ASCII strings with punctuation and whitespace variety
  fc.array(
    fc.constantFrom(...ASCII_CHARS.split("")),
    { minLength: 0, maxLength: 200 },
  ).map((chars) => chars.join("")),
  // Realistic evidence quote-like strings
  fc.array(
    fc.constantFrom(
      "the", "speaker", "said", "I", "believe", "we", "can", "do", "better",
      "today", "want", "talk", "about", "importance", "public", "speaking",
      "Hello,", "World!", "it's", "don't", "can't", "won't", "they're",
      "Mr.", "Dr.", "U.S.A.", "e.g.", "i.e.", "etc.",
      "100%", "$50", "#1", "@home", "re-evaluate", "co-operate",
      "  ", "\t", "\n",
    ),
    { minLength: 0, maxLength: 30 },
  ).map((words) => words.join(" ")),
  // Edge cases: empty, whitespace-only, punctuation-only
  fc.constantFrom("", " ", "  ", "\t\n\r", "...", "!!!", "???", "---"),
);

// ─── Property Tests ─────────────────────────────────────────────────────────────

describe("Feature: phase-3-semi-automation, UI-P1: Evidence quote normalization is consistent with EvidenceValidator", () => {
  it("UI-P1: normalizeForMatch(s) === serverNormalize(s) for all strings s", () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * For any string, the client-side normalizeForMatch() function SHALL produce
     * the same output as the server-side evidence normalization (lowercase, strip
     * all non-alphanumeric non-whitespace characters, collapse whitespace, trim).
     * Specifically: normalizeForMatch(s) === serverNormalize(s) for all strings s.
     */
    fc.assert(
      fc.property(arbitraryNormalizationInput, (input: string) => {
        const clientResult = normalizeForMatch(input);
        const serverResult = serverNormalize(input);

        expect(clientResult).toBe(serverResult);
      }),
      { numRuns: 1000 },
    );
  });

  it("UI-P1: normalizeForMatch(s) === serverNormalize(s) for fully random strings", () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * Broader coverage with fully random unicode strings to catch any
     * divergence in regex behavior between the two implementations.
     */
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input: string) => {
        const clientResult = normalizeForMatch(input);
        const serverResult = serverNormalize(input);

        expect(clientResult).toBe(serverResult);
      }),
      { numRuns: 1000 },
    );
  });
});
