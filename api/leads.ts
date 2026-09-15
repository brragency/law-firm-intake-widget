// api/leads.ts
//
// Flow:
//   1. Validate the incoming lead.
//   2. Store it in Supabase first — this is the source of truth, independent
//      of whether the CRM call below succeeds.
//   3. Forward it to the client's CRM via a Zapier/Make webhook. Using a
//      webhook here (instead of a hand-built integration per CRM) means
//      onboarding a client with a different CRM is a Zapier config change,
//      not new code.
//
// Required environment variables (set in Vercel project settings):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (server-side only — never expose to the client)
//   CRM_WEBHOOK_URL             (the Zapier/Make "Catch Hook" URL for this client)

import { createClient } from "@supabase/supabase-js";

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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;

  if (!isValidLead(body)) {
    return res.status(400).json({ error: "Invalid lead payload" });
  }

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
      },
    ])
    .select()
    .single();

  if (dbError) {
    console.error("Supabase insert failed:", dbError);
    return res.status(500).json({ error: "Failed to store lead" });
  }

  // 2. Look up this client's own CRM webhook (each firm can route to a
  //    different CRM via their own Zapier/Make hook, stored in `clients`).
  const { data: clientRow } = await supabase
    .from("clients")
    .select("crm_webhook_url")
    .eq("client_id", body.clientId)
    .single();

  const crmWebhookUrl = clientRow?.crm_webhook_url;

  // 3. Forward to CRM. If this fails, the lead is still safely stored above —
  //    log it so it can be manually resent, but don't fail the whole request
  //    on the visitor's end just because the CRM hiccuped.
  if (crmWebhookUrl) {
    try {
      const webhookRes = await fetch(crmWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (webhookRes.ok) {
        await supabase.from("leads").update({ crm_forwarded: true }).eq("id", data.id);
      } else {
        console.error("CRM webhook responded with", webhookRes.status);
      }
    } catch (webhookErr) {
      console.error("CRM webhook forward failed:", webhookErr);
      // Intentionally not surfaced to the visitor — the lead is safe in Supabase.
    }
  }

  return res.status(200).json({ ok: true });
}