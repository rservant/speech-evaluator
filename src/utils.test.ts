import { describe, it, expect } from "vitest";
import { splitSentences } from "./utils.js";

describe("splitSentences", () => {
  // ── Basic splitting ──────────────────────────────────────────────────────

  it("should return an empty array for empty string", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("should return an empty array for whitespace-only string", () => {
    expect(splitSentences("   ")).toEqual([]);
  });

  it("should split simple sentences ending with periods", () => {
    expect(splitSentences("Hello world. Goodbye world.")).toEqual([
      "Hello world.",
      "Goodbye world.",
    ]);
  });

  it("should split sentences ending with exclamation marks", () => {
    expect(splitSentences("Great job! Keep it up!")).toEqual([
      "Great job!",
      "Keep it up!",
    ]);
  });

  it("should split sentences ending with question marks", () => {
    expect(splitSentences("How are you? I am fine.")).toEqual([
      "How are you?",
      "I am fine.",
    ]);
  });

  it("should handle mixed punctuation", () => {
    expect(splitSentences("Really? Yes! It is true.")).toEqual([
      "Really?",
      "Yes!",
      "It is true.",
    ]);
  });

  it("should handle a single sentence with no trailing punctuation", () => {
    expect(splitSentences("Hello world")).toEqual(["Hello world"]);
  });

  it("should handle a single sentence with trailing punctuation", () => {
    expect(splitSentences("Hello world.")).toEqual(["Hello world."]);
  });

  it("should preserve punctuation with the preceding sentence", () => {
    const result = splitSentences("First sentence. Second sentence.");
    expect(result[0]).toBe("First sentence.");
    expect(result[1]).toBe("Second sentence.");
  });

  // ── Abbreviations ────────────────────────────────────────────────────────

  it("should not split on Mr.", () => {
    expect(splitSentences("Mr. Smith went home. He was tired.")).toEqual([
      "Mr. Smith went home.",
      "He was tired.",
    ]);
  });

  it("should not split on Mrs.", () => {
    expect(splitSentences("Mrs. Jones spoke well. The audience agreed.")).toEqual([
      "Mrs. Jones spoke well.",
      "The audience agreed.",
    ]);
  });

  it("should not split on Dr.", () => {
    expect(splitSentences("Dr. Brown gave a speech. It was inspiring.")).toEqual([
      "Dr. Brown gave a speech.",
      "It was inspiring.",
    ]);
  });

  it("should not split on e.g.", () => {
    expect(
      splitSentences("Use connectors, e.g. however or therefore. This helps flow."),
    ).toEqual([
      "Use connectors, e.g. however or therefore.",
      "This helps flow.",
    ]);
  });

  it("should not split on i.e.", () => {
    expect(
      splitSentences("The main point, i.e. the thesis, was clear. Good job."),
    ).toEqual([
      "The main point, i.e. the thesis, was clear.",
      "Good job.",
    ]);
  });

  it("should not split on etc.", () => {
    expect(
      splitSentences("Bring pens, paper, etc. The meeting starts soon."),
    ).toEqual([
      "Bring pens, paper, etc.",
      "The meeting starts soon.",
    ]);
  });

  it("should not split on vs.", () => {
    expect(splitSentences("It was quality vs. quantity. Both matter.")).toEqual([
      "It was quality vs. quantity.",
      "Both matter.",
    ]);
  });

  it("should not split on St.", () => {
    expect(splitSentences("He lives on St. James Ave. The house is big.")).toEqual([
      "He lives on St. James Ave.",
      "The house is big.",
    ]);
  });

  it("should not split on Prof.", () => {
    expect(splitSentences("Prof. Lee presented the findings. They were remarkable.")).toEqual([
      "Prof. Lee presented the findings.",
      "They were remarkable.",
    ]);
  });

  // ── Decimal numbers ──────────────────────────────────────────────────────

  it("should not split on decimal numbers like 3.14", () => {
    expect(splitSentences("The value was 3.14 approximately. That is pi.")).toEqual([
      "The value was 3.14 approximately.",
      "That is pi.",
    ]);
  });

  it("should not split on decimal numbers like 0.5", () => {
    expect(splitSentences("The ratio was 0.5 exactly. Half of the total.")).toEqual([
      "The ratio was 0.5 exactly.",
      "Half of the total.",
    ]);
  });

  it("should not split on version numbers like 2.0", () => {
    expect(splitSentences("We use version 2.0 now. It is better.")).toEqual([
      "We use version 2.0 now.",
      "It is better.",
    ]);
  });

  // ── Multiple punctuation ─────────────────────────────────────────────────

  it("should handle multiple exclamation marks", () => {
    expect(splitSentences("Amazing!! Truly wonderful.")).toEqual([
      "Amazing!!",
      "Truly wonderful.",
    ]);
  });

  it("should handle multiple question marks", () => {
    expect(splitSentences("Really?? Yes, really.")).toEqual([
      "Really??",
      "Yes, really.",
    ]);
  });

  it("should handle ellipsis followed by a new sentence", () => {
    expect(splitSentences("And then... The crowd cheered.")).toEqual([
      "And then...",
      "The crowd cheered.",
    ]);
  });

  it("should handle mixed multiple punctuation like ?!", () => {
    expect(splitSentences("Are you serious?! I am.")).toEqual([
      "Are you serious?!",
      "I am.",
    ]);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("should handle text with no sentence-ending punctuation", () => {
    expect(splitSentences("This has no ending punctuation")).toEqual([
      "This has no ending punctuation",
    ]);
  });

  it("should handle text ending without punctuation after a sentence", () => {
    expect(splitSentences("First sentence. And then some more")).toEqual([
      "First sentence.",
      "And then some more",
    ]);
  });

  it("should handle punctuation not followed by whitespace (e.g., URLs)", () => {
    expect(splitSentences("Visit example.com for details. Thank you.")).toEqual([
      "Visit example.com for details.",
      "Thank you.",
    ]);
  });

  it("should handle multiple spaces between sentences", () => {
    expect(splitSentences("First sentence.  Second sentence.")).toEqual([
      "First sentence.",
      "Second sentence.",
    ]);
  });

  it("should trim leading and trailing whitespace from sentences", () => {
    expect(splitSentences("  Hello world.  Goodbye.  ")).toEqual([
      "Hello world.",
      "Goodbye.",
    ]);
  });

  it("should handle a sentence with only punctuation-like content", () => {
    expect(splitSentences("...")).toEqual(["..."]);
  });

  // ── Realistic evaluation script examples ─────────────────────────────────

  it("should correctly split a realistic evaluation opening", () => {
    const text =
      "Thank you for that speech, Mr. Johnson. Your opening was strong and immediately captured attention. The way you used a personal story, e.g. the childhood memory, was very effective.";
    const result = splitSentences(text);
    expect(result).toEqual([
      "Thank you for that speech, Mr. Johnson.",
      "Your opening was strong and immediately captured attention.",
      "The way you used a personal story, e.g. the childhood memory, was very effective.",
    ]);
  });

  it("should correctly split a script with metrics references", () => {
    const text =
      "Your speaking pace was approximately 145.5 words per minute. That is within the ideal range! Consider varying your pace for emphasis.";
    const result = splitSentences(text);
    expect(result).toEqual([
      "Your speaking pace was approximately 145.5 words per minute.",
      "That is within the ideal range!",
      "Consider varying your pace for emphasis.",
    ]);
  });

  it("should handle a complex paragraph with abbreviations and numbers", () => {
    const text =
      "Dr. Smith mentioned 3.14 as an example. Mrs. Lee agreed, i.e. she nodded. The score was not 8.5 out of 10. Was it higher? Yes!";
    const result = splitSentences(text);
    expect(result).toEqual([
      "Dr. Smith mentioned 3.14 as an example.",
      "Mrs. Lee agreed, i.e. she nodded.",
      "The score was not 8.5 out of 10.",
      "Was it higher?",
      "Yes!",
    ]);
  });
});
