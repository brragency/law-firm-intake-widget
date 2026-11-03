// api/leads.ts
//
// Flow:
//   1. Validate the incoming lead.
//   2. Store it in Supabase first — this is the source of truth, independent
//      of whether the CRM call below succeeds.
//   3. In parallel: email the firm's intake team (clients.alert_emails) and
//      forward it to the firm's CRM via their Zapier/Make webhook
//      (clients.crm_webhook_url). Neither can fail the visitor's submission.
//
// Environment variables (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (server-side only — never expose to the client)
//   RESEND_API_KEY              (for the email alerts; without it they're skipped)
//   ALERT_FROM_EMAIL            (optional sender, see api/_lib/alert-email.ts)

import { createClient } from "@supabase/supabase-js";
import { sanitizeAnswers, triage } from "./_lib/triage";
import { sendAlertEmail } from "./_lib/alert-email";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

type LeadPayload = {
  clientId: string;
  primaryArea: string | null;
  subType: string | null;
  detail1: string | null;
  detail2: string | null;
  description: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  callPreference: "now" | "later" | null;
  submittedAt: string;
};

function isValidLead(body: any): body is LeadPayload {
  return (
    body &&
    typeof body.clientId === "string" &&
    typeof body.firstName === "string" && body.firstName.trim() !== "" &&
    typeof body.lastName === "string" && body.lastName.trim() !== "" &&
    typeof body.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) &&
    typeof body.phone === "string" && body.phone.trim() !== ""
  );
}

export default async function handler(req: any, res: any) {
  // The widget runs on each firm's own website, so the browser treats this as
  // a cross-origin request and checks these headers first. Without them it
  // blocks the submission before it ever reaches the code below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;

  if (!isValidLead(body)) {
    return res.status(400).json({ error: "Invalid lead payload" });
  }

  // Priority label for the intake team. Older payloads without answers still
  // get one from the case type alone.
  const answers = sanitizeAnswers((body as any).answers);
  if (!answers.incident && body.primaryArea) answers.incident = String(body.primaryArea).slice(0, 64);
  const { priority, reasons } = triage(answers);

  // 1. Store first — this must succeed, or we tell the client something went wrong.
  const { data, error: dbError } = await supabase
    .from("leads")
    .insert([
      {
        client_id: body.clientId,
        primary_area: body.primaryArea,
        sub_type: body.subType,
        detail_1: body.detail1,
        detail_2: body.detail2,
        description: body.description,
        first_name: body.firstName,
        last_name: body.lastName,
        email: body.email,
        phone: body.phone,
        call_preference: body.callPreference,
        submitted_at: body.submittedAt,
        crm_forwarded: false,
        priority,
      },
    ])
    .select()
    .single();

  if (dbError) {
    console.error("Supabase insert failed:", dbError);
    return res.status(500).json({ error: "Failed to store lead" });
  }

  // 2. Look up this firm's alert emails and CRM webhook (stored in `clients`).
  const { data: clientRow } = await supabase
    .from("clients")
    .select("firm_name, crm_webhook_url, alert_emails")
    .eq("client_id", body.clientId)
    .single();

  const crmWebhookUrl = clientRow?.crm_webhook_url;
  const alertEmails: string[] = Array.isArray(clientRow?.alert_emails) ? clientRow.alert_emails : [];

  // 3a. Forward to CRM. If this fails, the lead is still safely stored above —
  //     log it so it can be manually resent.
  async function forwardToCrm() {
    if (!crmWebhookUrl) return;
    try {
      const webhookRes = await fetch(crmWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, priority, priorityReasons: reasons }),
        signal: AbortSignal.timeout(8000),
      });

      if (webhookRes.ok) {
        await supabase.from("leads").update({ crm_forwarded: true }).eq("id", data.id);
      } else {
        console.error("CRM webhook responded with", webhookRes.status);
      }
    } catch (webhookErr) {
      console.error("CRM webhook forward failed:", webhookErr);
    }
  }

  // 3b. Email the firm's intake team.
  async function emailIntakeTeam() {
    if (!alertEmails.length) return;
    const origin = req.headers?.origin;
    const result = await sendAlertEmail(
      {
        id: data.id,
        firmName: clientRow?.firm_name || "your firm",
        firstName: body.firstName.trim(),
        lastName: body.lastName.trim(),
        phone: body.phone,
        email: body.email.trim(),
        callPreference: body.callPreference,
        caseType: answers.incidentLabel || String(body.primaryArea || "Injury case").replace(/[_-]+/g, " "),
        description: body.description,
        priority,
        reasons,
        website: typeof origin === "string" ? origin.slice(0, 200) : null,
      },
      alertEmails
    );
    if (result.sent) {
      await supabase.from("leads").update({ alert_emailed_at: new Date().toISOString() }).eq("id", data.id);
    } else if (result.error) {
      console.error("Alert email failed for lead", data.id, result.error);
    }
  }

  // Run both at once. Neither is surfaced to the visitor — the lead is safe in Supabase.
  await Promise.allSettled([forwardToCrm(), emailIntakeTeam()]);

  return res.status(200).json({ ok: true });
}