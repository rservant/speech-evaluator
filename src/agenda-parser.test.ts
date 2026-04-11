// Agenda Parser Tests (#174)

import { describe, it, expect, vi } from "vitest";
import { parseAgendaFromText, type AgendaParserClient } from "./agenda-parser.js";

function makeMockClient(response: string): AgendaParserClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: response } }],
        }),
      },
    },
  };
}

function makeMockClientNull(): AgendaParserClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: null } }],
        }),
      },
    },
  };
}

describe("parseAgendaFromText", () => {
  it("parses a well-formatted agenda with speeches and table topics", async () => {
    const response = JSON.stringify({
      slots: [
        { type: "speech", speakerName: "Alice", projectTitle: "Ice Breaker", order: 0 },
        { type: "speech", speakerName: "Bob", projectTitle: "Persuasive Speaking", order: 1 },
        { type: "table-topics", speakerName: "Carol", order: 2 },
        { type: "table-topics", speakerName: "Dave", order: 3 },
      ],
    });
    const client = makeMockClient(response);

    const result = await parseAgendaFromText("Meeting agenda text...", client);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "speech", speakerName: "Alice", projectTitle: "Ice Breaker", order: 0 });
    expect(result[1]).toEqual({ type: "speech", speakerName: "Bob", projectTitle: "Persuasive Speaking", order: 1 });
    expect(result[2]).toEqual({ type: "table-topics", speakerName: "Carol", projectTitle: undefined, order: 2 });
    expect(result[3]).toEqual({ type: "table-topics", speakerName: "Dave", projectTitle: undefined, order: 3 });
  });

  it("returns empty array for empty text", async () => {
    const client = makeMockClient("should not be called");

    const result = await parseAgendaFromText("", client);

    expect(result).toEqual([]);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("returns empty array for whitespace-only text", async () => {
    const client = makeMockClient("should not be called");

    const result = await parseAgendaFromText("   \n  ", client);

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns null content", async () => {
    const client = makeMockClientNull();

    const result = await parseAgendaFromText("Some agenda text", client);

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns no slots", async () => {
    const client = makeMockClient(JSON.stringify({ slots: [] }));

    const result = await parseAgendaFromText("Some agenda text", client);

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns object without slots array", async () => {
    const client = makeMockClient(JSON.stringify({ speakers: [] }));

    const result = await parseAgendaFromText("Some agenda text", client);

    expect(result).toEqual([]);
  });

  it("filters out invalid slots with missing speakerName", async () => {
    const response = JSON.stringify({
      slots: [
        { type: "speech", speakerName: "Alice", projectTitle: "Ice Breaker" },
        { type: "speech", speakerName: "", projectTitle: "Bad Entry" },
        { type: "table-topics", speakerName: "Bob" },
      ],
    });
    const client = makeMockClient(response);

    const result = await parseAgendaFromText("Agenda", client);

    expect(result).toHaveLength(2);
    expect(result[0].speakerName).toBe("Alice");
    expect(result[1].speakerName).toBe("Bob");
  });

  it("filters out slots with invalid type", async () => {
    const response = JSON.stringify({
      slots: [
        { type: "speech", speakerName: "Alice" },
        { type: "evaluator", speakerName: "Eve" },
        { type: "table-topics", speakerName: "Bob" },
      ],
    });
    const client = makeMockClient(response);

    const result = await parseAgendaFromText("Agenda", client);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("speech");
    expect(result[1].type).toBe("table-topics");
  });

  it("re-indexes order sequentially after filtering", async () => {
    const response = JSON.stringify({
      slots: [
        { type: "speech", speakerName: "Alice", order: 0 },
        { type: "invalid", speakerName: "Filtered", order: 1 },
        { type: "speech", speakerName: "Bob", order: 2 },
      ],
    });
    const client = makeMockClient(response);

    const result = await parseAgendaFromText("Agenda", client);

    expect(result[0].order).toBe(0);
    expect(result[1].order).toBe(1);
  });

  it("trims whitespace from speaker names and titles", async () => {
    const response = JSON.stringify({
      slots: [
        { type: "speech", speakerName: "  Alice  ", projectTitle: "  Ice Breaker  " },
      ],
    });
    const client = makeMockClient(response);

    const result = await parseAgendaFromText("Agenda", client);

    expect(result[0].speakerName).toBe("Alice");
    expect(result[0].projectTitle).toBe("Ice Breaker");
  });

  it("sends correct model and response_format to OpenAI", async () => {
    const response = JSON.stringify({ slots: [] });
    const client = makeMockClient(response);

    await parseAgendaFromText("Agenda text", client);

    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    );
  });

  it("propagates LLM errors", async () => {
    const client: AgendaParserClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("API rate limit")),
        },
      },
    };

    await expect(parseAgendaFromText("Agenda", client)).rejects.toThrow("API rate limit");
  });
});
