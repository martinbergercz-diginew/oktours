// Reset-password page: takes the one-time token from the URL and sets a
// new password.

const form = document.getElementById("reset-form");
const msg = document.getElementById("reset-msg");
const token = new URLSearchParams(location.search).get("token") || "";

if (!token) {
  msg.textContent = "Odkaz je neplatný — chybí token. Vyžádej si nový na přihlašovací stránce.";
  form.querySelector("button").disabled = true;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  msg.textContent = "";
  msg.className = "login-error";
  const pw1 = document.getElementById("pw1").value;
  const pw2 = document.getElementById("pw2").value;
  if (pw1 !== pw2) {
    msg.textContent = "Hesla se neshodují.";
    return;
  }
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/admin/api/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: pw1 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Nastavení hesla se nezdařilo.");
    msg.className = "login-ok";
    msg.textContent = "Heslo nastaveno. Přesměrovávám na přihlášení…";
    setTimeout(() => { location.href = "/admin/login"; }, 1500);
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
});
