// Auto-translate via a separate, small Claude call. Kept outside the main
// agent loop so its tokens don't count against the per-turn budget.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TRANSLATE_MODEL = "claude-haiku-4-5-20251001";

export async function translate(text, from, to) {
  if (!text || from === to) return text;
  if (process.env.DRY_RUN === "true" && !process.env.ANTHROPIC_API_KEY) {
    return `[${to.toUpperCase()} translation of: ${text}]`;
  }
  const langName = { cs: "Czech", en: "English" };
  const resp = await client.messages.create({
    model: TRANSLATE_MODEL,
    max_tokens: 1024,
    system: `You are a professional translator for a Czech travel agency's website. Translate from ${langName[from]} to ${langName[to]} preserving tone (professional, warm) and any HTML tags. Output ONLY the translated text — no quotes, no commentary.`,
    messages: [{ role: "user", content: text }],
  });
  const block = resp.content.find(b => b.type === "text");
  return block ? block.text.trim() : text;
}
