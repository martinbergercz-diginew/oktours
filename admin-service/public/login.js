// Login page: email+password login, plus a "forgot password" view that
// requests a reset link.

const loginForm = document.getElementById("login-form");
const forgotForm = document.getElementById("forgot-form");
const loginErr = document.getElementById("login-error");
const forgotMsg = document.getElementById("forgot-msg");

document.getElementById("show-forgot").onclick = () => {
  loginForm.hidden = true;
  forgotForm.hidden = false;
  loginErr.textContent = "";
  document.getElementById("forgot-email").focus();
};
document.getElementById("show-login").onclick = () => {
  forgotForm.hidden = true;
  loginForm.hidden = false;
  forgotMsg.textContent = "";
  forgotMsg.className = "login-error";
  document.getElementById("email").focus();
};

loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  loginErr.textContent = "";
  const btn = loginForm.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Přihlášení se nezdařilo.");
    location.href = "/admin/";
  } catch (err) {
    loginErr.textContent = err.message;
    document.getElementById("password").value = "";
    document.getElementById("password").focus();
  } finally {
    btn.disabled = false;
  }
});

forgotForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  forgotMsg.textContent = "";
  forgotMsg.className = "login-error";
  const btn = forgotForm.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await fetch("/admin/api/request-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("forgot-email").value.trim() }),
    });
    // Always a neutral message — no account enumeration.
    forgotMsg.className = "login-ok";
    forgotMsg.textContent = "Pokud účet s tímto e-mailem existuje, poslali jsme na něj odkaz pro obnovení hesla.";
  } catch {
    forgotMsg.textContent = "Něco se nepovedlo. Zkus to prosím znovu.";
  } finally {
    btn.disabled = false;
  }
});
