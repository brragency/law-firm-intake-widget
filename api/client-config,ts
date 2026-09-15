// api/client-config.ts
//
// Publicly callable endpoint the widget hits to get a client's branding and
// intake questions. Only returns safe, public fields — never the CRM webhook
// URL or anything sensitive; that stays server-side in api/leads.ts.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const clientId = req.query.client_id as string;
  if (!clientId) {
    return res.status(400).json({ error: "Missing client_id" });
  }

  const { data, error } = await supabase
    .from("clients")
    .select("client_id, firm_name, primary_color, logo_url, practice_areas")
    .eq("client_id", clientId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Unknown client" });
  }

  // Cache at the edge/CDN for an hour — branding rarely changes minute-to-minute.
  // Browsers/widget still layer their own longer localStorage cache on top of this.
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  return res.status(200).json(data);
}