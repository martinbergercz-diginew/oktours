// Single-file vanilla JS chat app. Talks to /admin/api/*.
// No framework. ~250 lines.

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const messagesEl = $("#messages");
const composerEl = $("#composer");
const inputEl = $("#input");
const sendEl = $("#send");
const uploadEl = $("#upload");
const statePillEl = $("#state-pill");
const historyListEl = $("#history-list");
const historyEl = $("#history");
const historyToggleEl = $("#history-toggle");

let pendingSquashChoice = null;

function bubble(role, text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = text;
  wrap.appendChild(bub);

  if (opts.preview) {
    const a = document.createElement("a");
    a.className = "preview-link";
    a.href = opts.preview;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `Otevřít náhled → ${opts.preview}`;
    bub.appendChild(a);
  }

  if (opts.destructive) {
    const warn = document.createElement("div");
    warn.className = "destructive";
    warn.textContent = `Tato akce viditelně odstraní obsah z živého webu. Opravdu to chceš udělat? Vrátit zpět to lze později, ale do té doby to návštěvníci uvidí.`;
    bub.appendChild(warn);
  }

  if (opts.buttons?.length) {
    const row = document.createElement("div");
    row.className = "btn-row";
    for (const b of opts.buttons) {
      const btn = document.createElement("button");
      btn.className = `btn ${b.kind || ""}`;
      btn.textContent = b.label;
      btn.onclick = async (ev) => {
        ev.preventDefault();
        row.querySelectorAll("button").forEach(x => x.disabled = true);
        try { await b.onClick(btn); } catch (err) { showError(err.message); }
      };
      row.appendChild(btn);
    }
    bub.appendChild(row);
  }

  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function showError(text) {
  bubble("system", `⚠️ ${text}`);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401) {
    // Session expired or not logged in — bounce to the login page.
    location.href = "/admin/login";
    throw new Error("Přihlášení vypršelo. Přesměrovávám na přihlášení…");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ---- Chat send ----
composerEl.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendEl.disabled = true;

  bubble("user", text);
  const thinking = bubble("system", "Zpracovávám…");

  try {
    const body = { text };
    if (pendingSquashChoice) {
      body.squashChoice = pendingSquashChoice;
      pendingSquashChoice = null;
    }
    const resp = await api("/admin/api/chat", { method: "POST", body });
    thinking.remove();
    handleResponse(resp, text);
  } catch (err) {
    thinking.remove();
    showError(err.message);
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
});

function handleResponse(resp, lastUserText) {
  switch (resp.kind) {
    case "squash_prompt":
      bubble("assistant", resp.text, {
        buttons: [
          {
            label: "Přibalit k tomu",
            kind: "btn-primary",
            onClick: async () => { pendingSquashChoice = "bundle"; inputEl.value = lastUserText; composerEl.requestSubmit(); },
          },
          {
            label: "Nejdřív zrušit předchozí",
            onClick: async () => { pendingSquashChoice = "undo_previous"; inputEl.value = lastUserText; composerEl.requestSubmit(); },
          },
        ],
      });
      break;

    case "confirm_prompt":
      bubble("assistant", resp.text, {
        destructive: resp.is_destructive,
        buttons: [
          {
            label: resp.is_destructive ? "Ano, odstranit" : "Ano, použít",
            kind: resp.is_destructive ? "btn-warn" : "btn-primary",
            onClick: confirmDraft,
          },
          { label: "Ne, zrušit", onClick: cancelDraft },
        ],
      });
      break;

    case "staged":
      bubble("assistant", resp.text, {
        preview: resp.stagingUrl,
        buttons: [
          { label: "Publikovat na živý web", kind: "btn-primary", onClick: publishLive },
          { label: "Vrátit zpět", onClick: undoStaged },
        ],
      });
      break;

    case "published":
      bubble("assistant", `✓ Publikováno na ${resp.liveUrl}`, { preview: resp.liveUrl });
      refreshHistory();
      refreshState();
      break;

    case "error":
      showError(resp.text);
      break;

    case "plain":
    default:
      bubble("assistant", resp.text);
  }
}

// ---- Action handlers ----
async function confirmDraft() {
  const thinking = bubble("system", "Aplikuji na náhled…");
  try {
    const resp = await api("/admin/api/confirm", { method: "POST", body: {} });
    thinking.remove();
    handleResponse({ kind: "staged", ...resp });
  } catch (err) {
    thinking.remove();
    showError(err.message);
  }
}

async function cancelDraft() {
  await api("/admin/api/cancel", { method: "POST", body: {} });
  bubble("system", "Zrušeno.");
}

async function publishLive() {
  const thinking = bubble("system", "Publikuji a kontroluji…");
  try {
    const resp = await api("/admin/api/publish", { method: "POST", body: {} });
    thinking.remove();
    handleResponse({ kind: "published", ...resp });
  } catch (err) {
    thinking.remove();
    showError(err.message);
  }
}

async function undoStaged() {
  await api("/admin/api/undo", { method: "POST", body: {} });
  bubble("system", "Náhled vrácen zpět.");
  refreshState();
}

// ---- Upload ----
uploadEl.addEventListener("change", async () => {
  const file = uploadEl.files?.[0];
  if (!file) return;
  bubble("user", `📎 ${file.name}`);
  const thinking = bubble("system", "Nahrávám…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const resp = await api("/admin/api/upload", { method: "POST", body: fd });
    thinking.remove();
    bubble("system", `Nahráno: ${resp.path} (${resp.size_kb} KB). Napiš teď, kam ho umístit.`);
  } catch (err) {
    thinking.remove();
    showError(err.message);
  }
  uploadEl.value = "";
});

// ---- History / state ----
async function refreshHistory() {
  try {
    const data = await api("/admin/api/history");
    historyListEl.innerHTML = "";
    if (!data.commits.length) {
      historyListEl.innerHTML = '<li class="empty">Žádné změny.</li>';
      return;
    }
    for (const c of data.commits) {
      const li = document.createElement("li");
      const when = new Date(c.date).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" });
      li.innerHTML = `
        <span class="when">${when} · ${c.short}</span>
        <span class="msg-text">${escapeHtml(c.message)}</span>
        <button class="revert" data-commit="${c.hash}">Vrátit tuto změnu</button>
      `;
      li.querySelector(".revert").onclick = async (ev) => {
        if (!confirm(`Vrátit změnu "${c.message}"?`)) return;
        ev.target.disabled = true;
        try {
          await api("/admin/api/revert", { method: "POST", body: { commit: c.hash } });
          bubble("system", `Vráceno: ${c.message}`);
          refreshHistory();
        } catch (err) {
          showError(err.message);
          ev.target.disabled = false;
        }
      };
      historyListEl.appendChild(li);
    }
  } catch (err) {
    historyListEl.innerHTML = `<li class="empty">Nelze načíst: ${err.message}</li>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function refreshState() {
  try {
    const s = await api("/admin/api/session");
    if (s.stagingAhead > 0) {
      statePillEl.textContent = `Náhled má 1 čekající změnu`;
    } else if (s.draft) {
      statePillEl.textContent = `Čeká na potvrzení`;
    } else {
      statePillEl.textContent = `Připraveno`;
    }
    // Replay UI log on first load (resume from prior session).
    if (!messagesEl.dataset.replayed && s.uiLog?.length) {
      messagesEl.dataset.replayed = "1";
      for (const entry of s.uiLog.slice(-30)) {
        if (entry.kind === "user") bubble("user", entry.text);
        else if (entry.kind === "assistant") bubble("assistant", entry.text);
        else if (entry.kind === "staged") {
          bubble("assistant", `Hotovo. Náhled: ${entry.stagingUrl}`, { preview: entry.stagingUrl });
        } else if (entry.kind === "published") {
          bubble("assistant", `✓ Publikováno na ${entry.liveUrl}`, { preview: entry.liveUrl });
        } else if (entry.kind === "system") {
          bubble("system", entry.text);
        }
      }
      if (s.draft) {
        bubble("assistant", s.draft.summary_cs, {
          destructive: s.draft.is_destructive,
          buttons: [
            { label: s.draft.is_destructive ? "Ano, odstranit" : "Ano, použít", kind: "btn-primary", onClick: confirmDraft },
            { label: "Ne, zrušit", onClick: cancelDraft },
          ],
        });
      } else if (s.stagingAhead > 0) {
        bubble("assistant", `Na náhledu je 1 čekající úprava.`, {
          preview: s.stagingUrl,
          buttons: [
            { label: "Publikovat", kind: "btn-primary", onClick: publishLive },
            { label: "Vrátit zpět", onClick: undoStaged },
          ],
        });
      }
    }
  } catch (err) {
    statePillEl.textContent = "Offline";
  }
}

historyToggleEl.onclick = () => historyEl.classList.toggle("open");

const resetBtn = document.getElementById("reset-conversation");
if (resetBtn) {
  resetBtn.onclick = async () => {
    if (!confirm("Vyresetovat konverzaci? Historie chatu se smaže (úpravy na webu zůstanou).")) return;
    try {
      await api("/admin/api/reset-conversation", { method: "POST", body: {} });
      messagesEl.innerHTML = "";
      delete messagesEl.dataset.replayed;
      bubble("system", "Konverzace vyresetována. Můžeš začít znovu.");
      refreshState();
    } catch (err) {
      showError(err.message);
    }
  };
}

const logoutBtn = document.getElementById("logout");
if (logoutBtn) {
  logoutBtn.onclick = async () => {
    try { await api("/admin/api/logout", { method: "POST", body: {} }); }
    catch { /* logout is best-effort */ }
    location.href = "/admin/login";
  };
}

inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    composerEl.requestSubmit();
  }
});

refreshState();
refreshHistory();
