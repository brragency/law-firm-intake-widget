// api/_lib/triage.ts
//
// Turns the widget's answers into a priority label for the intake team:
//
//   high      -> wrongful death, trucks/commercial vehicles, hospital stays, etc.
//   standard  -> a real injury case worth a prompt call
//   low       -> property damage only, caller mostly at fault, etc.
//
// Every point that moves the score adds a plain-English reason, so the alert
// email can say *why* a lead was marked high priority.
//
// Pure functions, no I/O. Files under api/_lib are shared code: Vercel does
// not turn folders starting with "_" into endpoints.

export type Track = "vehicle" | "truck" | "premises" | "work" | "general";
export type Priority = "high" | "standard" | "low";

export type Answers = {
  incident?: string;
  incidentLabel?: string;
  track?: Track;
  injury?: "self" | "family" | "fatal" | "none";
  treatment?: "hospital" | "er" | "doctor" | "none";
  commercial?: "yes" | "no" | "unsure";
  fault?: "other" | "shared" | "self";
  location?: "business" | "rental" | "government" | "private_home" | "other";
  thirdParty?: "yes" | "no" | "unsure";
  when?: "week" | "month" | "six_months" | "year" | "two_years" | "older";
};

export type TriageResult = { priority: Priority; score: number; reasons: string[] };

const TRACKS: Track[] = ["vehicle", "truck", "premises", "work", "general"];

/** Same rule the widget uses to pick follow-up questions. */
export function inferTrack(incident: string | undefined): Track {
  const v = (incident ?? "").toLowerCase();
  if (/truck|18|semi|tractor|big.?rig|commercial/.test(v)) return "truck";
  if (/car|auto|mva|motor|vehicle|rideshare|uber|lyft|pedestrian|bike|bicycl|cycl|bus|crash/.test(v)) return "vehicle";
  if (/slip|fall|trip|premises/.test(v)) return "premises";
  if (/work|job|construct|comp/.test(v)) return "work";
  return "general";
}

const TREATMENT: Record<NonNullable<Answers["treatment"]>, [number, string]> = {
  hospital: [35, "Hospital stay or surgery"],
  er: [20, "ER visit"],
  doctor: [12, "Doctor, urgent care or chiro"],
  none: [0, "No treatment yet"],
};

// [months since incident: lower, upper], points, label
const WHEN: Record<NonNullable<Answers["when"]>, [number, number, number, string]> = {
  week: [0, 0.25, 5, "Happened in the last 7 days"],
  month: [0.25, 1, 3, "Happened in the last 30 days"],
  six_months: [1, 6, 0, "Happened 1-6 months ago"],
  year: [6, 12, 0, "Happened 6-12 months ago"],
  two_years: [12, 24, 0, "Happened 1-2 years ago"],
  older: [24, Number.POSITIVE_INFINITY, 0, "Happened over 2 years ago"],
};

export function triage(a: Answers, solYears = 2): TriageResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  const track = a.track && TRACKS.includes(a.track) ? a.track : inferTrack(a.incident);
  const incident = (a.incident ?? "").toLowerCase();

  if (track === "truck") add(30, "Truck or commercial vehicle");
  if (track === "vehicle") {
    if (/rideshare|uber|lyft/.test(incident)) add(12, "Rideshare");
    if (!/motor/.test(incident) && /pedestrian|walk|bike|bicycl|cyclist/.test(incident)) add(10, "Pedestrian or cyclist");
    if (/motor/.test(incident)) add(8, "Motorcycle");
    if (a.commercial === "yes") add(30, "Commercial vehicle involved");
    else if (a.commercial === "unsure") add(8, "Commercial vehicle possible");
  }

  let propertyOnly = false;
  if (a.injury === "none") {
    propertyOnly = true;
    reasons.push("No injuries (property damage only)");
  } else if (a.injury === "fatal") {
    add(60, "Wrongful death");
  } else if (a.injury === "family") {
    reasons.push("Submitted by a family member");
  }

  if (a.treatment && TREATMENT[a.treatment]) {
    const [points, label] = TREATMENT[a.treatment];
    add(points, label);
  }

  if (track === "vehicle" || track === "truck") {
    if (a.fault === "other") add(15, "Other driver at fault");
    else if (a.fault === "shared") add(3, "Fault unclear or shared");
    else if (a.fault === "self") add(-25, "Says they were mostly at fault");
  }

  if (track === "premises") {
    if (a.location === "business") add(8, "Business property");
    else if (a.location === "rental") add(5, "Rental property");
    else if (a.location === "government") add(5, "Government property (notice deadlines can be short)");
    else if (a.location === "private_home") reasons.push("Private home");
  }

  if (track === "work") {
    if (a.thirdParty === "yes") add(15, "Third party involved (beyond workers' comp)");
    else if (a.thirdParty === "unsure") add(4, "Possible third party");
    else if (a.thirdParty === "no") reasons.push("Employer only (workers' comp)");
  }

  if (a.when && WHEN[a.when]) {
    const [lower, upper, points, label] = WHEN[a.when];
    add(points, label);
    const solMonths = solYears * 12;
    if (lower >= solMonths) reasons.push("Check the filing deadline");
    else if (upper > solMonths - 3) add(10, "Filing deadline may be close");
  }

  let priority: Priority = score >= 50 ? "high" : score >= 20 ? "standard" : "low";
  if (propertyOnly) priority = "low";
  if (a.injury === "fatal") priority = "high";
  return { priority, score, reasons };
}

/** Keeps only known answer keys and values from the browser. */
export function sanitizeAnswers(input: unknown): Answers {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = src[key];
    return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const text = (key: string, max: number) =>
    typeof src[key] === "string" ? (src[key] as string).trim().slice(0, max) || undefined : undefined;

  const out: Answers = {
    incident: text("incident", 64),
    incidentLabel: text("incidentLabel", 80),
    track: pick("track", TRACKS),
    injury: pick("injury", ["self", "family", "fatal", "none"] as const),
    treatment: pick("treatment", ["hospital", "er", "doctor", "none"] as const),
    commercial: pick("commercial", ["yes", "no", "unsure"] as const),
    fault: pick("fault", ["other", "shared", "self"] as const),
    location: pick("location", ["business", "rental", "government", "private_home", "other"] as const),
    thirdParty: pick("thirdParty", ["yes", "no", "unsure"] as const),
    when: pick("when", ["week", "month", "six_months", "year", "two_years", "older"] as const),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Answers;
}
