// Agenda Parser — extracts speaker slots from meeting agenda text via GPT-4o (#174)

import type { ParsedAgendaSlot } from "./types.js";

/**
 * Minimal OpenAI client interface for agenda parsing.
 * Matches the subset of the OpenAI SDK used by this module.
 */
export interface AgendaParserClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: { type: string };
        temperature?: number;
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

const SYSTEM_PROMPT = `You are a Toastmasters meeting agenda parser. Given the text of a meeting agenda, extract the list of speakers and table topics participants.

Return a JSON object with a single "slots" array. Each slot has:
- "type": "speech" for prepared speeches, "table-topics" for table topics / impromptu speakers
- "speakerName": the speaker's name (required, non-empty)
- "projectTitle": the speech title or project name (optional, only for prepared speeches)
- "order": sequential integer starting at 0

Rules:
- Include ONLY speakers who will give speeches or table topics responses
- Do NOT include meeting officers (Sergeant at Arms, Toastmaster of the Day, General Evaluator, etc.) unless they are also giving a speech
- Do NOT include evaluators, timer, grammarian, ah-counter unless they appear as speakers
- If you cannot identify any speakers, return {"slots": []}
- Table topics speakers may be listed as a group — create one slot per named speaker
- If table topics speakers are not named, create placeholder slots with speakerName "TT Speaker 1", "TT Speaker 2", etc.`;

/**
 * Parse meeting agenda text into structured speaker slots using GPT-4o.
 *
 * @param text - Plain text extracted from a meeting agenda PDF/DOCX/TXT
 * @param client - OpenAI-compatible client
 * @returns Parsed agenda slots
 */
export async function parseAgendaFromText(
  text: string,
  client: AgendaParserClient,
): Promise<ParsedAgendaSlot[]> {
  if (!text.trim()) {
    return [];
  }

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return [];
  }

  const parsed = JSON.parse(content) as { slots?: unknown[] };
  if (!Array.isArray(parsed.slots)) {
    return [];
  }

  return parsed.slots
    .filter(isValidSlot)
    .map((slot, index) => ({
      type: slot.type as "speech" | "table-topics",
      speakerName: String(slot.speakerName).trim(),
      projectTitle: slot.projectTitle ? String(slot.projectTitle).trim() : undefined,
      order: index,
    }));
}

function isValidSlot(slot: unknown): slot is { type: string; speakerName: string; projectTitle?: string } {
  if (typeof slot !== "object" || slot === null) return false;
  const s = slot as Record<string, unknown>;
  if (s.type !== "speech" && s.type !== "table-topics") return false;
  if (typeof s.speakerName !== "string" || !s.speakerName.trim()) return false;
  return true;
}
