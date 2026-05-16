// Single-file vanilla JS chat app. Talks to /admin/api/*.
// No framework.

const messagesEl = document.querySelector("#messages");
const composerEl = document.querySelector("#composer");
const inputEl = document.querySelector("#input");
const sendEl = document.querySelector("#send");
const uploadEl = document.querySelector("#upload");
const statePillEl = document.querySelector("#state-pill");
const historyListEl = document.querySelector("#history-list");
const historyEl = document.querySelector("#history");
const historyToggleEl = document.querySelector("#history-toggle");
const publishToggleEl = document.querySelector("#publish-toggle");
const confirmToggleEl = document.querySelector("#confirm-toggle");

let pendingSquashChoice = null;

// Publish mode: "preview" (edit → náhled → publish) or "direct" (edit →
// straight to live). Persisted so it survives reloads.
let publishMode = localStorage.getItem("oktours_publish_mode") || "preview";

// Confirm mode: "ask" (show the Ano/Ne prompt before applying) or "auto"
// (apply proposed changes without asking). Destructive changes always ask.
let confirmMode = localStorage.getItem("oktours_confirm_mode") || "ask";

// ---- Markdown (tiny subset: the model uses **bold**, `code`, *italic*,
// and "- " bullets — nothing else needs rendering) ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/^[ \t]*[-*] +/gm, "• ");
  return html;
}

// ---- Bubbles ----
function bubble(role, text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const bub = document.createElement("div");
  bub.className = "bubble";
  if (role === "assistant") {
    bub.innerHTML = renderMarkdown(text);
  } else {
    bub.textContent = text;
  }
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
    warn.textContent = "Tato akce viditelně odstraní obsah z živého webu. Opravdu to chceš udělat? Vrátit zpět to lze později, ale do té doby to návštěvníci uvidí.";
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

// A "working…" bubble: live elapsed-second counter + a growing list of
// step lines streamed from the server. Returns { addStep, remove }.
function thinkingBubble(label) {
  const wrap = bubble("system", label);
  const bub = wrap.querySelector(".bubble");
  const labelNode = bub.firstChild;            // text node from bubble()
  const stepsEl = document.createElement("div");
  stepsEl.className = "thinking-steps";
  bub.appendChild(stepsEl);
  const startedAt = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    labelNode.textContent = s > 0 ? `${label} · ${s} s` : `${label}…`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return {
    addStep(text) {
      const prev = stepsEl.lastElementChild;
      if (prev) prev.classList.add("done");
      const row = document.createElement("div");
      row.className = "thinking-step";
      row.textContent = text;
      stepsEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    },
    remove() { clearInterval(timer); wrap.remove(); },
  };
}

// ---- Styled confirm dialog (replaces window.confirm) ----
function confirmDialog({ title, body, confirmLabel = "Potvrdit", cancelLabel = "Zrušit", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";

    const h = document.createElement("h3");
    h.className = "modal-title";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "modal-body";
    p.textContent = body;
    const row = document.createElement("div");
    row.className = "modal-btns";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = cancelLabel;
    const ok = document.createElement("button");
    ok.className = `btn ${danger ? "btn-warn" : "btn-primary"}`;
    ok.textContent = confirmLabel;
    row.append(cancel, ok);
    card.append(h, p, row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = (val) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

// ---- API helpers ----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body && !(opts.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401) {
    location.href = "/admin/login";
    throw new Error("Přihlášení vypršelo. Přesměrovávám na přihlášení…");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// Streaming chat: reads server-sent "step" events into the thinking
// bubble and returns the final payload from the "done" event.
async function sendChatStream(body, thinking) {
  const res = await fetch("/admin/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = "/admin/login";
    throw new Error("Přihlášení vypršelo.");
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok && !ct.includes("event-stream")) {
    const d = ct.includes("json") ? await res.json().catch(() => ({})) : {};
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      let ev;
      try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (ev.type === "step") thinking.addStep(ev.text);
      else if (ev.type === "done") final = ev.payload;
    }
  }
  if (!final) throw new Error("Spojení se serverem se přerušilo. Zkus to prosím znovu.");
  return final;
}

// ---- Chat send ----
composerEl.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  sendEl.disabled = true;

  bubble("user", text);
  const thinking = thinkingBubble("Zpracovávám změnu");

  try {
    const body = { text };
    if (pendingSquashChoice) {
      body.squashChoice = pendingSquashChoice;
      pendingSquashChoice = null;
    }
    const resp = await sendChatStream(body, thinking);
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

    case "confirm_prompt": {
      const direct = publishMode === "direct";
      // Auto-apply when confirmation is off — but a destructive change
      // (removing visible content) always asks, whatever the toggle says.
      const autoApply = confirmMode === "auto" && !resp.is_destructive;
      let yesLabel;
      if (direct) yesLabel = resp.is_destructive ? "Ano, odstranit a publikovat" : "Ano, publikovat na web";
      else yesLabel = resp.is_destructive ? "Ano, odstranit" : "Ano, použít";
      bubble("assistant", resp.text, {
        destructive: resp.is_destructive,
        buttons: autoApply ? undefined : [
          { label: yesLabel, kind: resp.is_destructive ? "btn-warn" : "btn-primary", onClick: confirmDraft },
          { label: "Ne, zrušit", onClick: cancelDraft },
        ],
      });
      if (autoApply) confirmDraft();
      break;
    }

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
  const direct = publishMode === "direct";
  const thinking = thinkingBubble(direct ? "Publikuji na web" : "Aplikuji na náhled");
  try {
    const staged = await api("/admin/api/confirm", { method: "POST", body: {} });
    if (!direct) {
      thinking.remove();
      handleResponse({ kind: "staged", ...staged });
      return;
    }
    // Direct mode — chain straight into publish.
    thinking.addStep("Změna připravena, publikuji na web…");
    const published = await api("/admin/api/publish", { method: "POST", body: {} });
    thinking.remove();
    handleResponse({ kind: "published", ...published });
  } catch (err) {
    thinking.remove();
    showError(err.message);
    // In direct mode the change may already be staged even though publish
    // failed (e.g. smoke test) — surface the manual staged controls.
    if (direct) {
      try {
        const s = await api("/admin/api/session");
        if (s.stagingAhead > 0) {
          bubble("assistant", "Změna je připravená na náhledu, ale publikace na web se nezdařila. Zkontroluj náhled a zkus publikovat ručně.", {
            preview: s.stagingUrl,
            buttons: [
              { label: "Publikovat na živý web", kind: "btn-primary", onClick: publishLive },
              { label: "Vrátit zpět", onClick: undoStaged },
            ],
          });
        }
      } catch { /* ignore */ }
    }
  }
}

async function cancelDraft() {
  await api("/admin/api/cancel", { method: "POST", body: {} });
  bubble("system", "Zrušeno.");
}

async function publishLive() {
  const thinking = thinkingBubble("Publikuji a kontroluji");
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
  const thinking = thinkingBubble("Nahrávám soubor");
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
        const ok = await confirmDialog({
          title: "Vrátit změnu?",
          body: `Web se vrátí do stavu před úpravou „${c.message}". Tuto akci uvidí návštěvníci.`,
          confirmLabel: "Vrátit změnu",
          cancelLabel: "Ponechat",
          danger: true,
        });
        if (!ok) return;
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

async function refreshState() {
  try {
    const s = await api("/admin/api/session");
    if (s.stagingAhead > 0) {
      statePillEl.textContent = "Náhled má 1 čekající změnu";
    } else if (s.draft) {
      statePillEl.textContent = "Čeká na potvrzení";
    } else {
      statePillEl.textContent = "Připraveno";
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
        bubble("assistant", "Na náhledu je 1 čekající úprava.", {
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

// ---- Header toggles ----
function renderPublishToggle() {
  const direct = publishMode === "direct";
  publishToggleEl.textContent = direct ? "⚡ Publikuji rovnou na web" : "👁 Publikuji na náhled";
  publishToggleEl.classList.toggle("warn", direct);
  publishToggleEl.title = direct
    ? "Potvrzené změny se rovnou zveřejní na webu. Klikni pro režim s náhledem."
    : "Potvrzené změny se nejdřív ukážou na náhledu. Klikni pro publikování rovnou na web.";
}
if (publishToggleEl) {
  publishToggleEl.onclick = () => {
    publishMode = publishMode === "direct" ? "preview" : "direct";
    localStorage.setItem("oktours_publish_mode", publishMode);
    renderPublishToggle();
  };
  renderPublishToggle();
}

function renderConfirmToggle() {
  const auto = confirmMode === "auto";
  confirmToggleEl.textContent = auto ? "⏩ Měním bez potvrzení" : "✋ Ptám se před změnou";
  confirmToggleEl.classList.toggle("warn", auto);
  confirmToggleEl.title = auto
    ? "Navržené změny se provedou rovnou, bez dotazu. Mazání obsahu se kvůli bezpečnosti potvrzuje vždy. Klikni pro režim s dotazem."
    : "Před provedením každé změny se zeptám na potvrzení. Klikni pro provádění bez dotazu.";
}
if (confirmToggleEl) {
  confirmToggleEl.onclick = () => {
    confirmMode = confirmMode === "auto" ? "ask" : "auto";
    localStorage.setItem("oktours_confirm_mode", confirmMode);
    renderConfirmToggle();
  };
  renderConfirmToggle();
}

historyToggleEl.onclick = () => historyEl.classList.toggle("open");

const resetBtn = document.getElementById("reset-conversation");
if (resetBtn) {
  resetBtn.onclick = async () => {
    const ok = await confirmDialog({
      title: "Vyresetovat konverzaci?",
      body: "Historie chatu se smaže. Úpravy už provedené na webu zůstanou beze změny.",
      confirmLabel: "Vyresetovat",
      cancelLabel: "Ponechat",
    });
    if (!ok) return;
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

// ---- Account menu + user management ----
let currentUser = null;

async function loadMe() {
  try {
    currentUser = await api("/admin/api/me");
    document.getElementById("account-email").textContent = currentUser.email;
    if (currentUser.role === "admin") {
      document.getElementById("menu-users").hidden = false;
    }
  } catch { /* the auth gate redirects if truly unauthenticated */ }
}

const accountBtn = document.getElementById("account-btn");
const accountMenu = document.getElementById("account-menu");
accountBtn.onclick = (e) => { e.stopPropagation(); accountMenu.hidden = !accountMenu.hidden; };
document.addEventListener("click", (e) => {
  if (!accountMenu.hidden && !accountMenu.contains(e.target) && e.target !== accountBtn) {
    accountMenu.hidden = true;
  }
});
document.getElementById("menu-change-password").onclick = () => { accountMenu.hidden = true; changePasswordModal(); };
document.getElementById("menu-users").onclick = () => { accountMenu.hidden = true; usersModal(); };
document.getElementById("menu-logout").onclick = async () => {
  try { await api("/admin/api/logout", { method: "POST", body: {} }); }
  catch { /* best-effort */ }
  location.href = "/admin/login";
};

// Generic modal shell — returns { body, close }.
function openModal({ title, wide = false }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const card = document.createElement("div");
  card.className = "modal-card" + (wide ? " modal-wide" : "");
  const h = document.createElement("h3");
  h.className = "modal-title";
  h.textContent = title;
  const body = document.createElement("div");
  card.append(h, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() { overlay.remove(); document.removeEventListener("keydown", onKey); }
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener("keydown", onKey);
  return { body, close };
}

function changePasswordModal() {
  const { body, close } = openModal({ title: "Změnit heslo" });
  body.innerHTML = `
    <form class="modal-form" id="cp-form">
      <label>Stávající heslo<input type="password" id="cp-cur" autocomplete="current-password" required></label>
      <label>Nové heslo (alespoň 8 znaků)<input type="password" id="cp-new" autocomplete="new-password" required minlength="8"></label>
      <label>Nové heslo znovu<input type="password" id="cp-new2" autocomplete="new-password" required minlength="8"></label>
      <p class="modal-msg" id="cp-msg"></p>
      <div class="modal-btns">
        <button type="button" class="btn" id="cp-cancel">Zrušit</button>
        <button type="submit" class="btn btn-primary">Uložit heslo</button>
      </div>
    </form>`;
  const msg = body.querySelector("#cp-msg");
  body.querySelector("#cp-cancel").onclick = close;
  body.querySelector("#cp-form").onsubmit = async (ev) => {
    ev.preventDefault();
    msg.textContent = "";
    const n1 = body.querySelector("#cp-new").value;
    if (n1 !== body.querySelector("#cp-new2").value) { msg.textContent = "Nová hesla se neshodují."; return; }
    try {
      await api("/admin/api/change-password", {
        method: "POST",
        body: { currentPassword: body.querySelector("#cp-cur").value, newPassword: n1 },
      });
      close();
      bubble("system", "Heslo bylo změněno.");
    } catch (err) { msg.textContent = err.message; }
  };
}

function setUserPasswordModal(user) {
  const { body, close } = openModal({ title: `Nové heslo — ${user.email}` });
  body.innerHTML = `
    <form class="modal-form" id="sp-form">
      <label>Nové heslo (alespoň 8 znaků)<input type="password" id="sp-pw" autocomplete="new-password" required minlength="8"></label>
      <p class="modal-msg" id="sp-msg"></p>
      <div class="modal-btns">
        <button type="button" class="btn" id="sp-cancel">Zrušit</button>
        <button type="submit" class="btn btn-primary">Nastavit heslo</button>
      </div>
    </form>`;
  body.querySelector("#sp-cancel").onclick = close;
  const msg = body.querySelector("#sp-msg");
  body.querySelector("#sp-form").onsubmit = async (ev) => {
    ev.preventDefault();
    msg.textContent = "";
    try {
      await api(`/admin/api/users/${user.id}/password`, {
        method: "POST",
        body: { newPassword: body.querySelector("#sp-pw").value },
      });
      close();
      bubble("system", `Heslo uživatele ${user.email} bylo nastaveno.`);
    } catch (err) { msg.textContent = err.message; }
  };
}

function usersModal() {
  const { body, close } = openModal({ title: "Správa uživatelů", wide: true });
  body.innerHTML = `
    <div id="users-list" class="users-list">Načítám…</div>
    <form class="modal-form" id="add-user-form">
      <h4>Přidat uživatele</h4>
      <label>E-mail<input type="email" id="nu-email" required></label>
      <label>Role
        <select id="nu-role">
          <option value="editor">Editor — může upravovat web</option>
          <option value="admin">Administrátor — navíc spravuje uživatele</option>
        </select>
      </label>
      <label>Heslo (alespoň 8 znaků)<input type="password" id="nu-pw" required minlength="8"></label>
      <p class="modal-msg" id="nu-msg"></p>
      <div class="modal-btns">
        <button type="button" class="btn" id="users-close">Zavřít</button>
        <button type="submit" class="btn btn-primary">Přidat uživatele</button>
      </div>
    </form>`;
  body.querySelector("#users-close").onclick = close;
  const listEl = body.querySelector("#users-list");
  const nuMsg = body.querySelector("#nu-msg");

  async function render() {
    try {
      const data = await api("/admin/api/users");
      listEl.innerHTML = "";
      for (const u of data.users) {
        const isMe = u.id === data.me;
        const row = document.createElement("div");
        row.className = "user-row";
        const info = document.createElement("div");
        info.className = "user-info";
        info.innerHTML = `<span class="user-email">${escapeHtml(u.email)}${isMe ? " · vy" : ""}</span>` +
          `<span class="user-role role-${u.role}">${u.role === "admin" ? "Administrátor" : "Editor"}</span>`;
        const actions = document.createElement("div");
        actions.className = "user-actions";

        const roleBtn = document.createElement("button");
        roleBtn.className = "btn btn-small";
        roleBtn.textContent = u.role === "admin" ? "Změnit na editora" : "Povýšit na admina";
        roleBtn.onclick = async () => {
          try {
            await api(`/admin/api/users/${u.id}/role`, { method: "POST", body: { role: u.role === "admin" ? "editor" : "admin" } });
            render();
          } catch (err) { showError(err.message); }
        };

        const pwBtn = document.createElement("button");
        pwBtn.className = "btn btn-small";
        pwBtn.textContent = "Nastavit heslo";
        pwBtn.onclick = () => setUserPasswordModal(u);

        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-small btn-warn";
        delBtn.textContent = "Smazat";
        delBtn.disabled = isMe;
        delBtn.onclick = async () => {
          const ok = await confirmDialog({
            title: "Smazat uživatele?",
            body: `Účet ${u.email} bude odstraněn a tato osoba se už nepřihlásí.`,
            confirmLabel: "Smazat účet", cancelLabel: "Ponechat", danger: true,
          });
          if (!ok) return;
          try { await api(`/admin/api/users/${u.id}`, { method: "DELETE" }); render(); }
          catch (err) { showError(err.message); }
        };

        actions.append(roleBtn, pwBtn, delBtn);
        row.append(info, actions);
        listEl.appendChild(row);
      }
    } catch (err) {
      listEl.textContent = "Nelze načíst uživatele: " + err.message;
    }
  }

  body.querySelector("#add-user-form").onsubmit = async (ev) => {
    ev.preventDefault();
    nuMsg.textContent = ""; nuMsg.className = "modal-msg";
    try {
      await api("/admin/api/users", {
        method: "POST",
        body: {
          email: body.querySelector("#nu-email").value.trim(),
          role: body.querySelector("#nu-role").value,
          password: body.querySelector("#nu-pw").value,
        },
      });
      body.querySelector("#nu-email").value = "";
      body.querySelector("#nu-pw").value = "";
      nuMsg.className = "modal-ok";
      nuMsg.textContent = "Uživatel přidán.";
      render();
    } catch (err) { nuMsg.textContent = err.message; }
  };

  render();
}

inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    composerEl.requestSubmit();
  }
});

loadMe();
refreshState();
refreshHistory();
