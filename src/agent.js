// Claude API agent loop. Hand-rolled (no Agent SDK) so we control which
// tools exist. Enforces per-turn budget: 20 tool calls, 100K tokens, 120s.

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS, runTool } from "./tools/index.js";
import { SITE_CONFIG } from "./site-config.js";

const MAX_TOOL_CALLS = 20;
const MAX_TOKENS = 100_000;
const MAX_WALL_MS = 120_000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT_CS = `Jsi asistent pro správu webu cestovní kanceláře OK TOURS (oktours.cz). Klient (česky mluvící, ne-technický) ti píše požadavky a ty editaci provádíš sám.

Tvá pravidla:

1. **Plánuj v duchu, mluv česky.** Před každou změnou si v duchu rozmysli, co přesně uděláš. S klientem komunikuj jen česky, srozumitelně, bez technického žargonu (žádné "commit", "soubor", "tag" — místo toho "uložím", "úprava", "stránka").

2. **Vždy edituj všechny jazykové varianty.** Web má českou (index.html) a anglickou (index-en.html) verzi. Když měníš obsah viditelný uživatelům (jméno, popis, kontakt, položku menu, atd.), uprav OBĚ verze. Pokud jedna jazyková mutace chybí (klient zadal jen česky), použij nástroj 'translate' pro přibližný překlad — klient ho schválí ve fázi potvrzení.

3. **Drž se nejmenší možné změny.** Neměň HTML strukturu, neměň CSS, neměň layout. Jen text, obrázky a PDF.

4. **Žádné mazání bez potvrzení.** Pokud máš smazat tým, sekci, PDF nebo obrázek, nastav 'is_destructive: true' v 'propose_change' — klient uvidí varování.

5. **Strukturální požadavky odmítej.** Pokud klient chce přidat novou sekci typu, změnit layout nebo restyle, odpověz: "To je strukturální změna. Napíšu Martinovi, aby ji udělal. Mám mu poslat zprávu?"

6. **Postupuj vždy takto:**
   - 'list_files' nebo 'list_pages' pro orientaci.
   - 'read_file' pro relevantní soubory.
   - 'write_file' (a případně 'delete_file') pro nachystání změn do draftu (NEJDE na disk).
   - 'propose_change' pro souhrn v češtině a předání klientovi k potvrzení.
   - PO 'propose_change' STOP — neprováděj další akce. Čekej na klientovo potvrzení.

7. **Soubory mimo allowlist nemůžeš editovat.** Caddyfile, .php, .sh, .git, .env — všechno blokované na úrovni nástrojů. Když nástroj vrátí chybu, omluv se klientovi a navrhni jiný postup.

8. **Pokud si nejsi jistý, zeptej se.** Lepší jedna otázka navíc než špatná změna na webu.

Stránky webu:
${SITE_CONFIG.pages.map(p => `- ${p.path} (${p.language})${p.counterpart ? ` — protějšek: ${p.counterpart}` : ""}`).join("\n")}

Editovatelné složky: ${SITE_CONFIG.content_dirs.join(", ")}`;

export async function runTurn({ userMessage, session, draft, repoRoot, uploadsStore, systemAdditions = [] }) {
  const startedAt = Date.now();
  let totalTokens = 0;
  let toolCalls = 0;

  const messages = [...session.messages];
  messages.push({ role: "user", content: userMessage });

  const ctx = {
    repoRoot,
    draft,
    siteConfig: SITE_CONFIG,
    uploadsStore,
  };

  const systemBlocks = [
    { type: "text", text: SYSTEM_PROMPT_CS, cache_control: { type: "ephemeral" } },
    ...systemAdditions.map(s => ({ type: "text", text: s })),
  ];

  let assistantTextOut = "";
  let proposeResult = null;

  // Agent loop.
  while (true) {
    if (Date.now() - startedAt > MAX_WALL_MS) {
      throw budgetError("wall-clock time", `${MAX_WALL_MS / 1000}s`);
    }
    if (toolCalls > MAX_TOOL_CALLS) {
      throw budgetError("tool calls", MAX_TOOL_CALLS);
    }
    if (totalTokens > MAX_TOKENS) {
      throw budgetError("tokens", MAX_TOKENS);
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemBlocks,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    if (response.usage) {
      totalTokens += (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0);
    }

    // Collect text + tool_use blocks.
    const assistantBlocks = response.content;
    messages.push({ role: "assistant", content: assistantBlocks });

    const textBlock = assistantBlocks.find(b => b.type === "text");
    if (textBlock) assistantTextOut = textBlock.text;

    const toolUses = assistantBlocks.filter(b => b.type === "tool_use");
    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      // Model is done.
      break;
    }

    // Run tools, append results.
    const toolResults = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      const result = await runTool(tu.name, tu.input, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.is_error,
      });
      if (tu.name === "propose_change" && !result.is_error) {
        proposeResult = JSON.parse(result.content);
      }
    }
    messages.push({ role: "user", content: toolResults });

    // If propose_change ran, we stop the loop — the client must confirm
    // before any further work happens.
    if (proposeResult) {
      // Let the model produce one final assistant text after the tool result
      // so the chat has the right "I'll do X, confirm?" message rendered.
      const finalResp = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemBlocks,
        tools: TOOL_DEFINITIONS,
        messages,
      });
      if (finalResp.usage) {
        totalTokens += (finalResp.usage.input_tokens || 0) + (finalResp.usage.output_tokens || 0);
      }
      messages.push({ role: "assistant", content: finalResp.content });
      const lastText = finalResp.content.find(b => b.type === "text");
      if (lastText) assistantTextOut = lastText.text;
      break;
    }
  }

  return {
    assistantText: assistantTextOut,
    messages,
    proposeResult,
    budget: { tokens: totalTokens, toolCalls, wallMs: Date.now() - startedAt },
  };
}

function budgetError(kind, limit) {
  const err = new Error(`Per-turn budget exceeded: ${kind} > ${limit}`);
  err.code = "BUDGET_EXCEEDED";
  return err;
}
