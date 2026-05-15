// Login page script. Posts the shared password to /admin/api/login,
// then redirects into the chat UI on success.

const form = document.getElementById("login-form");
const pwEl = document.getElementById("password");
const errEl = document.getElementById("login-error");
const btnEl = form.querySelector("button");

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  errEl.textContent = "";
  btnEl.disabled = true;
  try {
    const res = await fetch("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pwEl.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Přihlášení se nezdařilo.");
    location.href = "/admin/";
  } catch (err) {
    errEl.textContent = err.message;
    pwEl.value = "";
    pwEl.focus();
  } finally {
    btnEl.disabled = false;
  }
});
