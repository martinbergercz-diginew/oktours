// Email notifications to Martin on every publish-to-live.
// Uses local Postfix on the VPS via nodemailer SMTP. In DRY_RUN, logs only.

import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: parseInt(process.env.SMTP_PORT || "25", 10),
    secure: false,
    ignoreTLS: true,
  });
  return transporter;
}

export async function notifyPublish({ clientPrompt, summary, commitHash, commitLink, diff }) {
  const to = process.env.NOTIFY_EMAIL;
  if (!to) return;

  const subject = `[OK TOURS] ${summary.slice(0, 70)}`;
  const body = [
    "Klient právě publikoval změnu na oktours.cz.",
    "",
    "Klientův prompt:",
    `> ${clientPrompt}`,
    "",
    "Souhrn:",
    summary,
    "",
    `Commit: ${commitHash}`,
    `GitHub: ${commitLink}`,
    "",
    "Diff (max 200 řádků):",
    diff || "(žádný diff)",
  ].join("\n");

  if (process.env.DRY_RUN === "true") {
    console.log(`[DRY] Would send email to ${to}: ${subject}`);
    return;
  }

  await getTransporter().sendMail({
    from: `oktours-admin@${process.env.MAIL_DOMAIN || "oktours.cz"}`,
    to,
    subject,
    text: body,
  });
}

// Email Martin a request the client can't do via chat — structural /
// design changes. Sent when the agent calls the notify_developer tool.
export async function notifyDeveloper({ request, clientPrompt }) {
  const to = process.env.NOTIFY_EMAIL;
  if (!to) throw new Error("Vývojářský e-mail není nakonfigurovaný (NOTIFY_EMAIL).");

  const subject = `[OK TOURS] Požadavek na vývojáře: ${request.slice(0, 60)}`;
  const body = [
    "Klient OK TOURS poslal přes chat (oktours.cz/admin) požadavek, který",
    "musí vyřešit vývojář — strukturální nebo designová změna mimo rozsah",
    "samoobslužné správy obsahu.",
    "",
    "Požadavek:",
    request,
    ...(clientPrompt ? ["", "Klient původně napsal:", `> ${clientPrompt}`] : []),
    "",
    "— odesláno automaticky z oktours.cz/admin",
  ].join("\n");

  if (process.env.DRY_RUN === "true") {
    console.log(`[DRY] Would send developer email to ${to}: ${subject}`);
    return { sent: true, dryRun: true };
  }

  await getTransporter().sendMail({
    from: `oktours-admin@${process.env.MAIL_DOMAIN || "oktours.cz"}`,
    to,
    subject,
    text: body,
  });
  return { sent: true };
}
