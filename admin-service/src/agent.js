// Claude API agent loop. Hand-rolled (no Agent SDK) so we control which
// tools exist. Enforces per-turn budget: 20 tool calls, 100K tokens, 120s.

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS, runTool } from "./tools/index.js";
import { SITE_CONFIG } from "./site-config.js";

// Sized for real-world HTML edits on this site: index.html is ~52KB (~13K
// tokens) and most edits read CS + EN versions. Worst-case one turn:
// read CS (~13K) + read EN (~13K) + write CS (~13K) + write EN (~13K) +
// propose_change + system prompt + accumulating history → ~80-120K total.
// Budget set with headroom; tighten later if abused.
const MAX_TOOL_CALLS = 30;
const MAX_TOKENS = 250_000;
const MAX_WALL_MS = 180_000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT_CS = `Jsi asistent pro správu webu cestovní kanceláře OK TOURS (oktours.cz). Klient (česky mluvící, ne-technický) ti píše požadavky a ty editaci provádíš sám.

Tvá pravidla:

1. **Plánuj v duchu, mluv česky.** Před každou změnou si v duchu rozmysli, co přesně uděláš. S klientem komunikuj jen česky, srozumitelně, bez technického žargonu (žádné "commit", "soubor", "tag" — místo toho "uložím", "úprava", "stránka").

2. **Vždy edituj všechny jazykové varianty.** Web má českou (index.html) a anglickou (index-en.html) verzi. Když měníš obsah viditelný uživatelům (jméno, popis, kontakt, položku menu, atd.), uprav OBĚ verze. Pokud jedna jazyková mutace chybí (klient zadal jen česky), použij nástroj 'translate' pro přibližný překlad — klient ho schválí ve fázi potvrzení.

3. **Drž se nejmenší možné změny.** Neměň HTML strukturu, neměň CSS, neměň layout. Jen text, obrázky a PDF.

4. **Žádné mazání bez potvrzení.** Pokud máš smazat tým, sekci, PDF nebo obrázek, nastav 'is_destructive: true' v 'propose_change' — klient uvidí varování.

5. **Strukturální požadavky předej vývojáři.** Pokud klient chce přidat nový typ sekce, změnit layout, barvy nebo restyle, je to mimo tvé možnosti. Odpověz: "To je strukturální/designová změna, kterou musí udělat vývojář (Martin). Mám mu poslat zprávu s tímto požadavkem?" Když klient potvrdí (např. "ano"), zavolej nástroj 'notify_developer' s jasným, srozumitelným popisem požadavku — teprve to Martinovi opravdu odešle e-mail. Po úspěšném odeslání klientovi potvrď, že zpráva BYLA odeslána. NIKDY netvrď, že jsi zprávu odeslal nebo že ji odešleš, aniž bys zavolal 'notify_developer' — žádný jiný způsob jak Martina kontaktovat nemáš.

6. **KAŽDÝ editační požadavek MUSÍ skončit voláním 'propose_change'.** Nikdy se klienta neptej "mám to udělat?" v textu — místo toho zavolej 'propose_change' s českým souhrnem a klient klikne na tlačítko. Postup:
   - 'list_pages' pro orientaci (rychlejší než list_files).
   - 'read_file' pro relevantní soubory — ideálně jen JEDNOU pro každou stránku, ne opakovaně.
   - **Pro JAKOUKOLIV úpravu existující stránky (index.html, index-en.html, dlouhodobe-pronajmy.html) MUSÍŠ použít 'edit_text_in_file'.** Nikdy ne write_file na tyto soubory. Tyto soubory mají 50+ KB, a kdybys přes write_file poslal jen kus obsahu, smázal bys většinu webu (smoke test to chytí, ale je to zbytečné selhání).
   - **'write_file' použij JEN když opravdu vytváříš NOVÝ soubor** (např. nový obrázek, nové PDF, nová sekce která ještě neexistuje). Když existující soubor přepisuješ přes write_file, MUSÍŠ poslat KOMPLETNÍ obsah — všechny znaky, nic nezkracovat, nic neshrnovat.
   - 'propose_change' pro souhrn v češtině a předání klientovi k potvrzení.
   - PO 'propose_change' STOP — neprováděj další akce. Čekej na klientovo potvrzení.

   Pokud si nejsi jistý CO klient chce změnit, zeptej se v textu BEZ volání write_file/edit_text. Pokud víš co změnit, rovnou udělej edit_text_in_file + propose_change v jedné odpovědi — nečekej na další "ok".

   **NIKDY nečte stejný soubor dvakrát za sebou.** Když jsi ho už přečetl, máš jeho obsah v kontextu. Plýtvání tokeny = rychle dojde rozpočet.

7. **Soubory mimo allowlist nemůžeš editovat.** Caddyfile, .php, .sh, .git, .env — všechno blokované na úrovni nástrojů. Když nástroj vrátí chybu, omluv se klientovi a navrhni jiný postup.

8. **Pokud si nejsi jistý, zeptej se.** Lepší jedna otázka navíc než špatná změna na webu.

9. **Nahrané soubory zůstávají ve složce 'uploads/'.** Když klient nahraje obrázek nebo PDF, je uložený jako 'uploads/nazev.jpg' (resp. .pdf). Odkazuj se na něj přímo touto cestou, např. \`<img src="uploads/nazev.jpg">\`. NEPŘESOUVEJ nahraný soubor do jiné složky (logos/, sections/, team/…) a NEMAŽ ho — přesouvací nástroj neexistuje a soubor v 'uploads/' funguje úplně stejně. Nástroj 'list_uploads' ti ukáže, co klient nahrál. Cesta 'uploads/...' je plně funkční pro obrázky i odkazy.

Stránky webu:
${SITE_CONFIG.pages.map(p => `- ${p.path} (${p.language})${p.counterpart ? ` — protějšek: ${p.counterpart}` : ""}`).join("\n")}

Editovatelné složky: ${SITE_CONFIG.content_dirs.join(", ")}`;

// Maps a tool call to a short, plain-Czech progress line shown live in
// the chat UI while the turn runs.
function toolStepText(name, input) {
  switch (name) {
    case "list_files": return "Prohlížím soubory webu";
    case "list_pages": return "Zjišťuji stránky webu";
    case "list_uploads": return "Kontroluji nahrané soubory";
    case "read_file": return `Čtu stránku ${input?.path || ""}`.trim();
    case "write_file": return `Připravuji soubor ${input?.path || ""}`.trim();
    case "edit_text_in_file": return `Upravuji ${input?.path || ""}`.trim();
    case "delete_file": return `Odstraňuji ${input?.path || ""}`.trim();
    case "translate": return "Překládám text do druhého jazyka";
    case "notify_developer": return "Posílám zprávu vývojáři";
    case "propose_change": return "Připravuji shrnutí změny";
    default: return "Pracuji na změně";
  }
}

export async function runTurn({ userMessage, session, draft, repoRoot, uploadsStore, systemAdditions = [], onEvent }) {
  const startedAt = Date.now();
  let totalTokens = 0;
  let toolCalls = 0;
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  emit({ text: "Přemýšlím nad požadavkem" });

  // Defensively drop any trailing assistant message whose tool_use blocks
  // aren't followed by a matching tool_result user message. This prevents
  // a corrupted history (e.g. from a crashed prior turn) from poisoning
  // every subsequent API call with 400 errors.
  const messages = sanitizeMessages([...session.messages]);
  messages.push({ role: "user", content: userMessage });

  const ctx = {
    repoRoot,
    draft,
    siteConfig: SITE_CONFIG,
    uploadsStore,
    userMessage,
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
      max_tokens: 16384,
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

    // If the model produced no tool_use blocks at all, we're done.
    // (We intentionally ignore stop_reason here — if there are tool_use
    // blocks we MUST run them and produce paired tool_result blocks,
    // otherwise the conversation becomes unbalanced and future API calls
    // reject with "tool_use ids without tool_result".)
    if (toolUses.length === 0) {
      break;
    }

    // Run tools, append results. ALWAYS run every tool_use we received.
    const toolResults = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      emit({ text: toolStepText(tu.name, tu.input) });
      const result = await runTool(tu.name, tu.input, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: result.is_error,
      });
      if (tu.name === "propose_change" && !result.is_error) {
        try { proposeResult = JSON.parse(result.content); }
        catch { /* should not happen — runTool always JSON.stringifies */ }
      }
    }
    messages.push({ role: "user", content: toolResults });

    // If propose_change ran, the agent is done with this turn — the
    // client must confirm before any more tools fire. We do NOT make a
    // second API call (that risks more tool_use blocks we'd have to
    // discard); instead we surface the propose_change summary directly
    // as the assistant text the UI renders.
    if (proposeResult) {
      assistantTextOut = proposeResult.summary_cs || assistantTextOut;
      break;
    }
  }

  return {
    assistantText: assistantTextOut,
    messages: sanitizeMessages(messages),
    proposeResult,
    budget: { tokens: totalTokens, toolCalls, wallMs: Date.now() - startedAt },
  };
}

// Trim any tool_use blocks at the very tail that aren't followed by a
// corresponding tool_result, so we never persist an unbalanced state.
// Returns a defensive copy.
function sanitizeMessages(messages) {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  // Walk back from the end, dropping trailing assistant tool_use that
  // isn't paired with a user tool_result.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.role !== "assistant" || !Array.isArray(last.content)) break;
    const hasUnpairedToolUse = last.content.some(b => b.type === "tool_use");
    const nextIsResults = false;   // last is the final entry, so by definition no next
    if (hasUnpairedToolUse && !nextIsResults) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

function budgetError(kind, limit) {
  const err = new Error(`Per-turn budget exceeded: ${kind} > ${limit}`);
  err.code = "BUDGET_EXCEEDED";
  err.budgetKind = kind;
  err.budgetLimit = limit;
  return err;
}
