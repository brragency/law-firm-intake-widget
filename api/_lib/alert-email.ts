// api/_lib/alert-email.ts
//
// Emails a new lead to the firm's intake team (clients.alert_emails) through
// Resend (https://resend.com). One HTTPS call, no SDK.
//
// Env vars (Vercel project settings):
//   RESEND_API_KEY     required to send; without it, alerts are skipped
//   ALERT_FROM_EMAIL   optional, e.g. "BRR Intake Alerts <alerts@brragency.com>"
//                      (the domain must be verified in Resend). Defaults to
//                      Resend's test sender, which only delivers to the email
//                      address that owns the Resend account.

import type { Priority } from "./triage";

export type AlertLead = {
  id: string | number;
  firmName: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  callPreference: string | null;
  caseType: string;
  description: string | null;
  priority: Priority;
  reasons: string[];
  website: string | null;
};

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High priority",
  standard: "Standard",
  low: "Low priority",
};

const PRIORITY_COLOR: Record<Priority, { bg: string; ink: string }> = {
  high: { bg: "#b42318", ink: "#ffffff" },
  standard: { bg: "#0f4c5c", ink: "#ffffff" },
  low: { bg: "#e4e7ec", ink: "#1e2a36" },
};

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function preferenceText(pref: string | null): string {
  if (pref === "later") return "a call later today";
  return "a call now";
}

export function buildAlertEmail(lead: AlertLead) {
  const name = oneLine(`${lead.firstName} ${lead.lastName}`);
  const label = PRIORITY_LABEL[lead.priority];
  const subject = oneLine(`[${label}] ${lead.caseType} - ${name}`).slice(0, 200);
  const digits = lead.phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const why = lead.reasons.slice(0, 6).join("; ");
  const details = (lead.description ?? "").trim();

  const text = [
    `New case review for ${lead.firmName}`,
    "",
    `${label.toUpperCase()}${why ? ` - ${why}` : ""}`,
    "",
    name,
    `Phone: ${lead.phone}`,
    `Email: ${lead.email}`,
    `Wants: ${preferenceText(lead.callPreference)}`,
    "",
    "Case details",
    details || "(none)",
    "",
    lead.website ? `Submitted on: ${lead.website}` : null,
    `Lead ID: ${lead.id}`,
    "",
    `Reply to this email to write to ${lead.firstName} directly.`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const color = PRIORITY_COLOR[lead.priority];
  const detailRows = details
    .split("\n")
    .map((line) => (line.trim() ? `<div style="margin:0 0 4px">${escapeHtml(line)}</div>` : `<div style="height:8px"></div>`))
    .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e2a36">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
  <div style="font-size:13px;color:#5c6774;margin-bottom:12px">New case review for ${escapeHtml(lead.firmName)}</div>
  <div style="display:inline-block;background:${color.bg};color:${color.ink};font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px">${label}</div>
  ${why ? `<div style="font-size:14px;color:#5c6774;margin:8px 0 0">${escapeHtml(why)}</div>` : ""}
  <div style="font-size:22px;font-weight:700;margin:18px 0 8px">${escapeHtml(name)}</div>
  <div style="font-size:16px;margin:0 0 4px"><a href="tel:+1${digits}" style="color:#0f4c5c;font-weight:600">${escapeHtml(lead.phone)}</a></div>
  <div style="font-size:15px;margin:0 0 4px"><a href="mailto:${escapeHtml(lead.email)}" style="color:#0f4c5c">${escapeHtml(lead.email)}</a></div>
  <div style="font-size:15px;margin:0 0 18px">Wants ${preferenceText(lead.callPreference)}</div>
  <div style="font-size:13px;font-weight:600;color:#5c6774;margin:0 0 6px">Case details</div>
  <div style="font-size:15px;line-height:1.45;background:#f3f5f7;border-radius:8px;padding:12px 14px">${detailRows || "(none)"}</div>
  <div style="font-size:12px;color:#5c6774;margin-top:18px">${lead.website ? `Submitted on ${escapeHtml(lead.website)} &middot; ` : ""}Lead ID ${escapeHtml(String(lead.id))}<br>Reply to this email to write to ${escapeHtml(lead.firstName)} directly.</div>
</div></body></html>`;

  return { subject, text, html };
}

export type SendResult = { sent: boolean; skipped?: string; error?: string };

export async function sendAlertEmail(lead: AlertLead, to: string[]): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = to.filter((addr) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)).slice(0, 10);
  if (!recipients.length) return { sent: false, skipped: "no_recipients" };
  if (!apiKey) return { sent: false, skipped: "no_api_key" };

  const { subject, text, html } = buildAlertEmail(lead);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // A retried submission never produces a second email for the same lead.
        "Idempotency-Key": `lead-alert/${lead.id}`,
      },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || "Intake Alerts <onboarding@resend.dev>",
        to: recipients,
        reply_to: lead.email,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, error: `resend ${res.status} ${detail.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (err: any) {
    return { sent: false, error: String(err?.message ?? err) };
  }
}
