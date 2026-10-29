// widget.js — branching intake widget (v2, intake only)
//
// Floating button + pop-up (default):
//   <script src="https://law-firm-intake-widget.vercel.app/widget.js" data-client="smith-law" async></script>
//
// Inline, in place of a firm's static contact form:
//   <div id="case-review"></div>
//   <script src="https://law-firm-intake-widget.vercel.app/widget.js" data-client="smith-law" data-mount="#case-review" async></script>
//
// Open it from any existing button or link on the firm's site:
//   <a href="#" data-intake-open>Start my free case review</a>      or      window.IntakeWidget.open()
//
// What it does:
//   1. Reads the firm's ID off its own <script> tag, and works out the API
//      address from where widget.js itself was loaded (no domain to edit).
//   2. Fetches that firm's branding and practice areas from /api/client-config
//      (cached in localStorage for 6 hours, same as v1).
//   3. Asks one question per screen. Tapping an answer moves straight to the
//      next question, and the questions branch by case type: vehicle,
//      truck, premises, workplace.
//   4. Submits ONE lead to /api/leads in the same format v1 used, so the API,
//      the Supabase `leads` table and each firm's CRM webhook are unchanged.
//      The answers fill sub_type / detail_1 / detail_2, and `description`
//      gets a readable case summary for the intake team.
//
// Everything renders inside a shadow root, so the firm's own CSS can't break it.

(function () {
  "use strict";
  if (window.__intakeWidgetLoaded) return;
  window.__intakeWidgetLoaded = true;

  // ------------------------------------------------------------ setup

  const currentScript =
    document.currentScript ||
    (function () {
      const scripts = document.querySelectorAll("script[data-client]");
      return scripts[scripts.length - 1];
    })();
  if (!currentScript) return;

  const clientId = currentScript.getAttribute("data-client");
  if (!clientId) {
    console.error("[intake-widget] Missing data-client attribute on script tag.");
    return;
  }

  let API_BASE;
  try {
    API_BASE = (currentScript.getAttribute("data-api") || new URL(currentScript.src, location.href).origin).replace(/\/+$/, "");
  } catch (e) {
    console.error("[intake-widget] Could not work out the API address.", e);
    return;
  }

  const MOUNT_SELECTOR = currentScript.getAttribute("data-mount");
  const LAUNCHER_ATTR = currentScript.getAttribute("data-launcher");
  const CONFIG_CACHE_HOURS = 6;
  const CACHE_KEY = "intake-widget-config:v2:" + clientId;
  const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ------------------------------------------------------------ config

  function getCachedConfig() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.fetchedAt > CONFIG_CACHE_HOURS * 3600000) return null;
      return cached.config;
    } catch (e) {
      return null; // storage blocked or corrupted: just refetch
    }
  }

  function setCachedConfig(config) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ config: config, fetchedAt: Date.now() }));
    } catch (e) {
      /* non-fatal: the widget still works, it just refetches next time */
    }
  }

  async function fetchConfig() {
    const cached = getCachedConfig();
    if (cached) return cached;
    const res = await fetch(API_BASE + "/api/client-config?client_id=" + encodeURIComponent(clientId));
    if (!res.ok) throw new Error("Failed to load intake widget config (" + res.status + ")");
    const config = await res.json();
    setCachedConfig(config);
    return config;
  }

  // ------------------------------------------------------------ helpers

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (let i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach(function (c) {
        if (c == null || c === false) return;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return el;
  }

  function icon(path, size) {
    const s = size || 20;
    const wrap = document.createElement("span");
    wrap.className = "iw-icon";
    wrap.innerHTML =
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
    return wrap;
  }
  const ICON_BACK = '<path d="M15 18l-6-6 6-6"/>';
  const ICON_CLOSE = '<path d="M18 6L6 18M6 6l12 12"/>';

  function phoneDigits(value) {
    let d = String(value || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d;
  }
  function formatPhone(value) {
    const d = phoneDigits(value).slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return "(" + d.slice(0, 3) + ") " + d.slice(3);
    return "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
  }
  function isUsPhone(digits) {
    return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) && !/^[2-9]11/.test(digits);
  }
  // Same rule the API uses, so anything that passes here passes there.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function safeColor(value, fallback) {
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value || "") ? value : fallback;
  }
  function hexToRgb(hex) {
    let c = hex.replace("#", "");
    if (c.length === 3) c = c.split("").map(function (x) { return x + x; }).join("");
    return [0, 2, 4].map(function (i) { return parseInt(c.slice(i, i + 2), 16); });
  }
  function luminance(hex) {
    const rgb = hexToRgb(hex).map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // Tint of the accent on white, e.g. for the selected-answer background.
  function tint(hex, amount) {
    const rgb = hexToRgb(hex).map(function (v) { return Math.round(255 + (v - 255) * amount); });
    return "rgb(" + rgb.join(",") + ")";
  }
  function rgba(hex, alpha) {
    return "rgba(" + hexToRgb(hex).join(",") + "," + alpha + ")";
  }

  // ---------------------------------------------------- question graph

  // Used when a firm has no practice_areas set in Supabase.
  const DEFAULT_AREAS = [
    { value: "car_accident", label: "Car accident" },
    { value: "truck_accident", label: "Truck or 18-wheeler accident" },
    { value: "motorcycle_accident", label: "Motorcycle accident" },
    { value: "rideshare_accident", label: "Uber or Lyft accident" },
    { value: "pedestrian_bicycle", label: "Hit as a pedestrian or cyclist" },
    { value: "slip_and_fall", label: "Slip, trip or fall" },
    { value: "workplace_injury", label: "Injured at work" },
    { value: "other_injury", label: "Something else" },
  ];

  // Picks the follow-up questions from the practice area's value, so a firm
  // can name its areas freely. Add "track": "vehicle" (or truck / premises /
  // work / general) to a practice_areas item to force a branch.
  function inferTrack(value) {
    const v = String(value || "").toLowerCase();
    if (/truck|18|semi|tractor|big.?rig|commercial/.test(v)) return "truck";
    if (/car|auto|mva|motor|vehicle|rideshare|uber|lyft|pedestrian|bike|bicycl|cycl|bus|crash/.test(v)) return "vehicle";
    if (/slip|fall|trip|premises/.test(v)) return "premises";
    if (/work|job|construct|comp/.test(v)) return "work";
    return "general";
  }

  let areas = DEFAULT_AREAS;

  // Answers on the current path: { stepId: { value, label, short } }
  let picks = {};
  let history = [];
  let stepId = "incident";
  let contact = { firstName: "", lastName: "", phone: "", email: "", callPreference: "now", notes: "" };
  let completed = false;

  function track() {
    return picks.incident ? picks.incident.track : "general";
  }
  function isVehicle() {
    return track() === "vehicle" || track() === "truck";
  }
  function incidentValue() {
    return picks.incident ? String(picks.incident.value) : "";
  }
  function isRideshare() {
    return /rideshare|uber|lyft/i.test(incidentValue());
  }
  function isPedestrian() {
    const v = incidentValue();
    // "motorcycle" contains "cycl", so rule motor vehicles out first.
    return !/motor/i.test(v) && /pedestrian|walk|bike|bicycl|cyclist/i.test(v);
  }

  function afterTreatment() {
    switch (track()) {
      case "truck":
        return "fault";
      case "vehicle":
        return isRideshare() ? "fault" : "commercial";
      case "premises":
        return "location";
      case "work":
        return "thirdParty";
      default:
        return "when";
    }
  }

  // `short` is what lands in the lead record and the case summary.
  const STEPS = {
    incident: {
      title: "Case type",
      prompt: function () { return "What happened?"; },
      hint: function () { return "Free case review. It takes about a minute."; },
      options: function () {
        return areas.map(function (a) {
          return { value: a.value, label: a.label, short: a.label, track: a.track || inferTrack(a.value) };
        });
      },
      next: function () { return "injury"; },
    },
    injury: {
      title: "Injury",
      prompt: function () { return isVehicle() ? "Was anyone hurt?" : "Who was hurt?"; },
      options: function () {
        if (isVehicle()) {
          return [
            { value: "self", label: "Yes, I was hurt", short: "Caller injured" },
            { value: "family", label: "Yes, a family member was hurt", short: "Family member injured" },
            { value: "fatal", label: "A family member passed away", short: "Wrongful death" },
            { value: "none", label: "No one was hurt, just vehicle damage", short: "No injuries (property damage only)" },
          ];
        }
        return [
          { value: "self", label: "I was", short: "Caller injured" },
          { value: "family", label: "A family member", short: "Family member injured" },
          { value: "fatal", label: "A family member passed away", short: "Wrongful death" },
        ];
      },
      next: function () {
        const v = picks.injury && picks.injury.value;
        if (v === "none") return "when";
        if (v === "fatal") return afterTreatment();
        return "treatment";
      },
    },
    treatment: {
      title: "Medical care",
      prompt: function () { return "What medical care has been needed so far?"; },
      options: function () {
        return [
          { value: "hospital", label: "Hospital stay or surgery", short: "Hospital stay or surgery" },
          { value: "er", label: "Emergency room visit", short: "ER visit" },
          { value: "doctor", label: "Doctor, urgent care or chiropractor", short: "Doctor, urgent care or chiro" },
          { value: "none", label: "None yet", short: "No treatment yet" },
        ];
      },
      next: afterTreatment,
    },
    commercial: {
      title: "Commercial vehicle",
      prompt: function () { return "Was a commercial vehicle involved?"; },
      hint: function () { return "Semi-trucks, delivery vans, work trucks, buses and company cars all count."; },
      options: function () {
        return [
          { value: "yes", label: "Yes", short: "Commercial vehicle involved" },
          { value: "no", label: "No", short: "No commercial vehicle" },
          { value: "unsure", label: "Not sure", short: "Commercial vehicle: not sure" },
        ];
      },
      next: function () { return "fault"; },
    },
    fault: {
      title: "Fault",
      prompt: function () { return "Who caused the crash?"; },
      options: function () {
        return [
          { value: "other", label: isPedestrian() ? "The driver" : "The other driver", short: "Other driver at fault" },
          { value: "shared", label: "It's unclear, or we both did", short: "Fault unclear or shared" },
          { value: "self", label: "Mostly me", short: "Caller mostly at fault" },
        ];
      },
      next: function () { return "when"; },
    },
    location: {
      title: "Location",
      prompt: function () { return "Where did it happen?"; },
      options: function () {
        return [
          { value: "business", label: "A store, restaurant or other business", short: "Business property" },
          { value: "rental", label: "An apartment or rental property", short: "Rental property" },
          { value: "government", label: "Government property, like a sidewalk or public building", short: "Government property" },
          { value: "private_home", label: "Someone's home", short: "Private home" },
          { value: "other", label: "Somewhere else", short: "Other location" },
        ];
      },
      next: function () { return "when"; },
    },
    thirdParty: {
      title: "Third party",
      prompt: function () { return "Was anyone besides your employer involved?"; },
      hint: function () { return "Another driver, a contractor or faulty equipment, for example."; },
      options: function () {
        return [
          { value: "yes", label: "Yes", short: "Third party involved" },
          { value: "no", label: "No", short: "Employer only" },
          { value: "unsure", label: "Not sure", short: "Third party: not sure" },
        ];
      },
      next: function () { return "when"; },
    },
    when: {
      title: "When",
      prompt: function () { return "When did it happen?"; },
      options: function () {
        return [
          { value: "week", label: "In the last week", short: "Last 7 days" },
          { value: "month", label: "In the last month", short: "Last 30 days" },
          { value: "six_months", label: "1 to 6 months ago", short: "1-6 months ago" },
          { value: "year", label: "6 to 12 months ago", short: "6-12 months ago" },
          { value: "two_years", label: "1 to 2 years ago", short: "1-2 years ago" },
          { value: "older", label: "More than 2 years ago", short: "Over 2 years ago" },
        ];
      },
      next: function () { return "contact"; },
    },
    contact: { type: "contact", next: function () { return "details"; } },
    details: { type: "details", next: function () { return "done"; } },
    done: { type: "done" },
  };

  /** The question steps on the current branch, in order. */
  function questionPath() {
    const path = [];
    let id = "incident";
    while (id && STEPS[id] && !STEPS[id].type && path.length < 12) {
      path.push(id);
      if (!picks[id]) break;
      id = STEPS[id].next();
    }
    return path;
  }

  /** Every screen the visitor will see from here, for the progress bar. */
  function predictedScreens() {
    const screens = [];
    let id = "incident";
    while (id && id !== "done" && screens.length < 14) {
      screens.push(id);
      id = STEPS[id].next();
    }
    return screens;
  }

  /** Builds the request body in the exact shape api/leads.ts expects. */
  function buildPayload(config) {
    // Only answers on the current branch count. If someone went back and
    // changed an answer, the questions they no longer see are left out.
    const answered = questionPath().filter(function (id) { return picks[id]; });
    const get = function (id) { return answered.indexOf(id) !== -1 ? picks[id].short : null; };
    const branchDetails = ["commercial", "fault", "location", "thirdParty"].map(get).filter(Boolean);

    const summary = answered.map(function (id) { return STEPS[id].title + ": " + picks[id].short; });
    summary.push("Best way to reach: " + (contact.callPreference === "later" ? "Call later today" : "Call now"));
    if (contact.notes) summary.push("", "In their words: " + contact.notes);

    const answers = {};
    answered.forEach(function (id) { answers[id] = picks[id].value; });

    return {
      clientId: config.client_id || clientId,
      primaryArea: picks.incident ? String(picks.incident.value) : null,
      subType: get("injury"),
      detail1: get("treatment"),
      detail2: branchDetails.length ? branchDetails.join("; ") : null,
      description: summary.join("\n"),
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: formatPhone(contact.phone),
      callPreference: contact.callPreference === "later" ? "later" : "now",
      submittedAt: new Date().toISOString(),
      // Extra detail for the CRM webhook only; the database insert ignores it.
      answers: answers,
    };
  }

  function resetForm() {
    picks = {};
    history = [];
    stepId = "incident";
    contact = { firstName: "", lastName: "", phone: "", email: "", callPreference: "now", notes: "" };
    completed = false;
  }

  // ------------------------------------------------------------ styles

  function styles(accent, accentInk) {
    return `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.iw {
  /* Wipe anything inherited from the firm's own page (letter-spacing,
     text-transform, line-height...), then set our own. */
  all: initial;
  display: block;
  --accent: ${accent};
  --accent-ink: ${accentInk};
  --accent-wash: ${tint(accent, 0.08)};
  --accent-ring: ${rgba(accent, 0.4)};
  --ink: #1e2a36;
  --muted: #5c6774;
  --line: #d8dee5;
  --wash: #f3f5f7;
  --danger: #b42318;
  --serif: Charter, "Bitstream Charter", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.45;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  text-align: left;
}
button { font: inherit; color: inherit; }
button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible {
  outline: 3px solid var(--accent-ring);
  outline-offset: 2px;
}

.iw-launcher {
  position: fixed; bottom: 20px; z-index: 2147483000;
  border: 0; border-radius: 999px; padding: 15px 22px; cursor: pointer;
  background: var(--accent); color: var(--accent-ink);
  font-weight: 600; font-size: 16px; line-height: 1;
  box-shadow: 0 8px 24px rgba(16, 24, 32, 0.22), 0 1px 3px rgba(16, 24, 32, 0.18);
}
.iw-launcher.is-right { right: 20px; }
.iw-launcher.is-left { left: 20px; }

.iw-scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(16, 24, 32, 0.4); }

.iw-panel {
  position: fixed; right: 24px; bottom: 24px; z-index: 2147483002;
  width: 420px; max-width: calc(100vw - 32px);
  max-height: 700px; max-height: min(700px, calc(100vh - 48px));
  display: flex; flex-direction: column; overflow: hidden;
  background: #ffffff; border-radius: 16px;
  box-shadow: 0 24px 64px rgba(16, 24, 32, 0.3);
}
.iw-panel.is-left { right: auto; left: 24px; }
.iw-panel.is-opening { animation: iw-rise 180ms ease-out; }
@keyframes iw-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

.iw-panel.is-inline {
  position: relative; right: auto; bottom: auto; z-index: auto;
  width: 100%; max-width: 560px; max-height: none;
  border: 1px solid var(--line); border-radius: 14px; box-shadow: none;
}

.iw-progress { height: 3px; background: var(--wash); flex: none; }
.iw-progress > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width 240ms ease; }

.iw-head { display: flex; align-items: center; gap: 4px; min-height: 52px; padding: 6px 8px 0; flex: none; }
.iw-back, .iw-close {
  display: inline-flex; align-items: center; gap: 2px; min-height: 40px; padding: 0 10px;
  background: none; border: 0; border-radius: 8px; cursor: pointer; color: var(--muted); font-size: 15px;
}
.iw-back:hover, .iw-close:hover { color: var(--ink); background: var(--wash); }
.iw-close { width: 40px; padding: 0; justify-content: center; }
.iw-brand { flex: 1; display: flex; justify-content: center; align-items: center; min-width: 0; }
.iw-brand img { max-height: 26px; max-width: 160px; object-fit: contain; }
.iw-brand span { font-size: 14px; font-weight: 600; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.iw-spacer { width: 40px; flex: none; }

.iw-body { padding: 8px 24px 24px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.iw-step.is-entering { animation: iw-fade 160ms ease-out; }
@keyframes iw-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.iw-prompt {
  font-family: var(--serif); font-size: 1.55rem; line-height: 1.2; font-weight: 700;
  letter-spacing: -0.01em; margin: 6px 0 6px; color: var(--ink); outline: none;
}
.iw-hint { margin: 0 0 18px; font-size: 15px; color: var(--muted); }
.iw-prompt + .iw-options, .iw-prompt + form { margin-top: 18px; }

.iw-options { display: grid; gap: 8px; }
.iw-option {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  width: 100%; min-height: 54px; padding: 13px 16px; text-align: left; font-size: 16px;
  background: #ffffff; border: 1px solid var(--line); border-radius: 10px; cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.iw-option:hover { border-color: var(--accent); }
.iw-dot { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--line); transition: border 120ms ease; }
.iw-option[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-wash); box-shadow: inset 0 0 0 1px var(--accent); }
.iw-option[aria-pressed="true"] .iw-dot { border: 5px solid var(--accent); }

.iw-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.iw-field { display: block; margin-bottom: 14px; min-width: 0; }
.iw-label { display: block; margin-bottom: 6px; font-size: 14px; font-weight: 600; }
.iw-optional { font-weight: 400; color: var(--muted); }
.iw-input {
  display: block; width: 100%; padding: 12px 14px; font: inherit; font-size: 16px; color: var(--ink);
  background: #ffffff; border: 1px solid var(--line); border-radius: 10px; margin: 0;
}
.iw-input:focus { border-color: var(--accent); outline: 2px solid var(--accent-ring); outline-offset: 0; }
.iw-input[aria-invalid="true"] { border-color: var(--danger); }
textarea.iw-input { resize: vertical; min-height: 84px; }
.iw-field-error { margin: 6px 0 0; font-size: 14px; color: var(--danger); }

.iw-pref { border: 0; margin: 0 0 14px; padding: 0; min-width: 0; }
.iw-pref legend { padding: 0; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
.iw-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.iw-pill { position: relative; }
.iw-pill input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.iw-pill span { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 999px; font-size: 15px; background: #ffffff; }
.iw-pill input:checked + span { border-color: var(--accent); background: var(--accent-wash); box-shadow: inset 0 0 0 1px var(--accent); }
.iw-pill input:focus-visible + span { outline: 3px solid var(--accent-ring); outline-offset: 2px; }

.iw-primary {
  display: flex; align-items: center; justify-content: center; width: 100%; min-height: 54px; margin-top: 6px;
  border: 0; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: 600;
  background: var(--accent); color: var(--accent-ink);
}
.iw-primary[disabled] { opacity: 0.65; cursor: progress; }
.iw-error { margin: 12px 0 0; font-size: 14px; color: var(--danger); }
.iw-fineprint { margin: 14px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); }
.iw-done-text { margin: 0 0 18px; font-size: 16px; }

@media (max-width: 600px) {
  .iw-panel:not(.is-inline) {
    left: 0; right: 0; bottom: 0; width: 100%; max-width: none;
    max-height: 92vh; max-height: 92dvh;
    border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom);
  }
  .iw-panel.is-opening:not(.is-inline) { animation: iw-sheet 220ms ease-out; }
  .iw-body { padding: 6px 20px 22px; }
  .iw-prompt { font-size: 1.4rem; }
  .iw-row { grid-template-columns: 1fr; }
}
@keyframes iw-sheet { from { transform: translateY(100%); } to { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .iw-panel.is-opening, .iw-step.is-entering { animation: none !important; }
  .iw-progress > span, .iw-option, .iw-dot { transition: none; }
}
`;
  }

  // ------------------------------------------------------------ widget

  function createWidget(config) {
    const firmName = config.firm_name || "our firm";
    if (Array.isArray(config.practice_areas)) {
      const valid = config.practice_areas.filter(function (a) { return a && a.value && a.label; });
      if (valid.length) areas = valid;
    }

    const accent = safeColor(config.primary_color, "#1a1a2e");
    const accentInk = contrast(accent, "#ffffff") >= contrast(accent, "#1e2a36") ? "#ffffff" : "#1e2a36";

    const mountTarget = MOUNT_SELECTOR ? document.querySelector(MOUNT_SELECTOR) : null;
    if (MOUNT_SELECTOR && !mountTarget) {
      console.warn("[intake-widget] data-mount element not found (" + MOUNT_SELECTOR + "); showing the floating button instead.");
    }
    const inline = !!mountTarget;
    const showLauncher = LAUNCHER_ATTR ? LAUNCHER_ATTR !== "false" : !inline;
    const side = currentScript.getAttribute("data-position") === "left" ? "is-left" : "is-right";

    const host = h("div", { "data-intake-widget-host": clientId });
    const root = host.attachShadow({ mode: "open" });
    root.append(h("style", { text: styles(accent, accentInk) }));
    const shell = h("div", { class: "iw" });
    root.append(shell);

    // ---- chrome
    const progressFill = h("span");
    const backBtn = h("button", { class: "iw-back", type: "button", onclick: goBack }, icon(ICON_BACK, 18), "Back");
    const brand = h(
      "div",
      { class: "iw-brand" },
      config.logo_url ? h("img", { src: config.logo_url, alt: firmName }) : h("span", { text: firmName })
    );
    const closeBtn = inline
      ? h("span", { class: "iw-spacer" })
      : h("button", { class: "iw-close", type: "button", "aria-label": "Close", onclick: close }, icon(ICON_CLOSE, 20));
    const body = h("div", { class: "iw-body" });
    const panel = h(
      "section",
      inline
        ? { class: "iw-panel is-inline", role: "region", "aria-label": "Case review form" }
        : { class: "iw-panel " + side, role: "dialog", "aria-modal": "true", "aria-labelledby": "iw-title", hidden: true },
      h("div", { class: "iw-progress", "aria-hidden": "true" }, progressFill),
      h("div", { class: "iw-head" }, backBtn, brand, closeBtn),
      body
    );
    const scrim = inline ? null : h("div", { class: "iw-scrim", hidden: true, onclick: close });
    const launcher = showLauncher
      ? h("button", { class: "iw-launcher " + side, type: "button", onclick: function () { open(); } }, "Free case review")
      : null;

    if (scrim) shell.append(scrim);
    shell.append(panel);
    if (launcher) shell.append(launcher);
    if (inline) mountTarget.append(host);
    else document.body.append(host);

    let isOpen = inline;
    let busy = false;
    let lastFocus = null;
    let prevOverflow = "";

    // ---- open / close / navigation
    function open(trigger) {
      if (inline) {
        panel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
        return;
      }
      if (isOpen) return;
      isOpen = true;
      lastFocus = trigger || document.activeElement;
      scrim.hidden = false;
      panel.hidden = false;
      if (launcher) launcher.hidden = true;
      panel.classList.remove("is-opening");
      void panel.offsetWidth; // restart the animation
      panel.classList.add("is-opening");
      prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      render(true);
    }

    function close() {
      if (inline || !isOpen) return;
      isOpen = false;
      scrim.hidden = true;
      panel.hidden = true;
      if (launcher) launcher.hidden = false;
      document.documentElement.style.overflow = prevOverflow;
      if (completed) resetForm();
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function goBack() {
      if (!history.length || busy) return;
      stepId = history.pop();
      render(true);
    }

    function advance(nextId) {
      history.push(stepId);
      stepId = nextId;
      render(true);
    }

    panel.addEventListener("keydown", function (e) {
      if (inline) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab") {
        const focusables = Array.prototype.filter.call(
          panel.querySelectorAll("button, input, textarea, a[href]"),
          function (el) { return !el.disabled && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden"; }
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && root.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && root.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // ---- rendering
    function prompt(text) {
      return h("h2", { class: "iw-prompt", id: "iw-title", tabindex: "-1", text: text });
    }

    function render(moveFocus) {
      const step = STEPS[stepId] || STEPS.incident;
      const screens = predictedScreens();
      const index = stepId === "done" ? screens.length : Math.max(0, screens.indexOf(stepId));
      progressFill.style.width = Math.round((index / screens.length) * 100) + "%";
      backBtn.style.visibility = history.length && stepId !== "done" ? "visible" : "hidden";

      let content;
      if (step.type === "contact") content = renderContact();
      else if (step.type === "details") content = renderDetails();
      else if (step.type === "done") content = renderDone();
      else content = renderChoice(stepId, step);

      content.classList.add("iw-step");
      if (moveFocus && !reduceMotion) content.classList.add("is-entering");
      body.replaceChildren(content);
      body.scrollTop = 0;

      if (moveFocus) {
        const heading = content.querySelector(".iw-prompt");
        if (heading) heading.focus({ preventScroll: true });
      }
    }

    function renderChoice(id, step) {
      const current = picks[id] ? picks[id].value : null;
      const hint = step.hint ? step.hint() : null;
      return h(
        "div",
        null,
        prompt(step.prompt()),
        hint ? h("p", { class: "iw-hint", text: hint }) : null,
        h(
          "div",
          { class: "iw-options", role: "group", "aria-labelledby": "iw-title" },
          step.options().map(function (opt) {
            const btn = h(
              "button",
              { class: "iw-option", type: "button", "aria-pressed": current === opt.value ? "true" : "false" },
              h("span", { text: opt.label }),
              h("span", { class: "iw-dot", "aria-hidden": "true" })
            );
            btn.addEventListener("click", function () {
              if (busy) return;
              busy = true;
              body.querySelectorAll(".iw-option").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
              btn.setAttribute("aria-pressed", "true");
              // Changing the case type starts the follow-up questions over;
              // re-picking the same one keeps what they already answered.
              if (id === "incident" && (!picks.incident || picks.incident.value !== opt.value)) picks = {};
              picks[id] = opt;
              // A short beat so the tap visibly registers before the next question.
              setTimeout(function () {
                busy = false;
                advance(step.next());
              }, reduceMotion ? 0 : 140);
            });
            return btn;
          })
        )
      );
    }

    function field(opts) {
      const id = "iw-" + opts.name;
      const input = h(opts.multiline ? "textarea" : "input", {
        class: "iw-input",
        id: id,
        name: opts.name,
        type: opts.multiline ? null : opts.type || "text",
        inputmode: opts.inputmode,
        autocomplete: opts.autocomplete,
        rows: opts.multiline ? 3 : null,
        maxlength: opts.maxlength,
        "aria-describedby": id + "-error",
      });
      input.value = opts.value || "";
      const error = h("p", { class: "iw-field-error", id: id + "-error", hidden: true });
      input.addEventListener("input", function () {
        if (!error.hidden) {
          error.hidden = true;
          input.setAttribute("aria-invalid", "false");
        }
      });
      const wrap = h(
        "div",
        { class: "iw-field" },
        h("label", { class: "iw-label", for: id }, opts.label, opts.optional ? h("span", { class: "iw-optional", text: " (optional)" }) : null),
        input,
        error
      );
      return { wrap: wrap, input: input, error: error };
    }

    function setFieldError(f, message) {
      f.error.textContent = message || "";
      f.error.hidden = !message;
      f.input.setAttribute("aria-invalid", message ? "true" : "false");
    }

    function renderContact() {
      const first = field({ name: "firstName", label: "First name", autocomplete: "given-name", value: contact.firstName, maxlength: 80 });
      const last = field({ name: "lastName", label: "Last name", autocomplete: "family-name", value: contact.lastName, maxlength: 80 });
      const phone = field({
        name: "phone",
        label: "Mobile phone",
        type: "tel",
        inputmode: "tel",
        autocomplete: "tel-national",
        value: contact.phone ? formatPhone(contact.phone) : "",
        maxlength: 20,
      });
      phone.input.addEventListener("input", function () {
        // Only reformat when typing at the end, so editing the middle doesn't jump the cursor.
        if (phone.input.selectionStart === phone.input.value.length) phone.input.value = formatPhone(phone.input.value);
      });
      const email = field({
        name: "email",
        label: "Email",
        type: "email",
        inputmode: "email",
        autocomplete: "email",
        value: contact.email,
        maxlength: 200,
      });

      const submit = h("button", { class: "iw-primary", type: "submit", text: "Continue" });
      const form = h("form", { novalidate: true }, h("div", { class: "iw-row" }, first.wrap, last.wrap), phone.wrap, email.wrap, submit);

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        const values = {
          firstName: first.input.value.trim(),
          lastName: last.input.value.trim(),
          phone: phoneDigits(phone.input.value),
          email: email.input.value.trim(),
        };
        const errors = [
          [first, values.firstName ? "" : "Enter your first name."],
          [last, values.lastName ? "" : "Enter your last name."],
          [phone, isUsPhone(values.phone) ? "" : "Enter a 10-digit US phone number."],
          [email, EMAIL_RE.test(values.email) ? "" : "Enter a valid email, like name@example.com."],
        ];
        errors.forEach(function (pair) { setFieldError(pair[0], pair[1]); });
        const firstBad = errors.find(function (pair) { return pair[1]; });
        if (firstBad) {
          firstBad[0].input.focus();
          return;
        }
        Object.assign(contact, values);
        advance("details");
      });

      return h(
        "div",
        null,
        prompt("Where can we reach you?"),
        h("p", { class: "iw-hint", text: "Our intake team uses this to follow up about your case." }),
        form
      );
    }

    function renderDetails() {
      const prefs = [
        { value: "now", label: "Call me now" },
        { value: "later", label: "Call me later today" },
      ];
      const pref = h(
        "fieldset",
        { class: "iw-pref" },
        h("legend", { text: "When should we call?" }),
        h(
          "div",
          { class: "iw-pills" },
          prefs.map(function (p) {
            const input = h("input", { type: "radio", name: "callPreference", value: p.value });
            input.checked = (contact.callPreference || "now") === p.value;
            return h("label", { class: "iw-pill" }, input, h("span", { text: p.label }));
          })
        )
      );
      const notes = field({
        name: "notes",
        label: "Anything else we should know?",
        multiline: true,
        value: contact.notes,
        optional: true,
        maxlength: 2000,
      });

      const formError = h("p", { class: "iw-error", role: "alert", hidden: true });
      const submit = h("button", { class: "iw-primary", type: "submit", text: "Send my case review" });
      const form = h(
        "form",
        { novalidate: true },
        pref,
        notes.wrap,
        submit,
        formError,
        h("p", {
          class: "iw-fineprint",
          text: "Sending this form doesn't create an attorney-client relationship. If this is a medical emergency, call 911.",
        })
      );

      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        if (busy) return;
        const checked = form.querySelector('input[name="callPreference"]:checked');
        contact.callPreference = checked ? checked.value : "now";
        contact.notes = notes.input.value.trim();

        busy = true;
        submit.disabled = true;
        submit.textContent = "Sending...";
        formError.hidden = true;
        const ok = await postLead(buildPayload(config));
        busy = false;
        submit.disabled = false;
        submit.textContent = "Send my case review";

        if (ok) {
          completed = true;
          advance("done");
          return;
        }
        formError.textContent = "Your case review didn't send. Check your connection and try again, or call " + firmName + " directly.";
        formError.hidden = false;
      });

      return h(
        "div",
        null,
        prompt("Last step, " + (contact.firstName || "thanks") + "."),
        h("p", { class: "iw-hint", text: "Then we'll send your case review to " + firmName + "." }),
        form
      );
    }

    function renderDone() {
      const followUp =
        contact.callPreference === "later"
          ? "Our intake team will call you later today."
          : "Expect a call from our intake team shortly.";
      return h(
        "div",
        null,
        prompt("Your case review was sent."),
        h("p", { class: "iw-done-text", text: firmName + " has your information. " + followUp }),
        inline ? null : h("button", { class: "iw-primary", type: "button", onclick: close, text: "Close" })
      );
    }

    async function postLead(payload) {
      const controller = window.AbortController ? new AbortController() : null;
      const timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;
      try {
        const res = await fetch(API_BASE + "/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        });
        if (!res.ok) console.error("[intake-widget] Submit failed with status " + res.status);
        return res.ok;
      } catch (err) {
        console.error("[intake-widget] Submit failed:", err);
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (inline) render(false);
    return { open: open, close: close };
  }

  // ------------------------------------------------------------ boot

  let api = null;
  let pendingOpen = null;
  window.IntakeWidget = {
    open: function () {
      if (api) api.open();
      else pendingOpen = true;
    },
    close: function () {
      if (api) api.close();
    },
  };

  document.addEventListener("click", function (e) {
    const trigger = e.target && e.target.closest ? e.target.closest("[data-intake-open]") : null;
    if (!trigger) return;
    e.preventDefault();
    if (api) api.open(trigger);
    else pendingOpen = trigger;
  });

  function boot() {
    fetchConfig()
      .then(function (config) {
        api = createWidget(config);
        if (pendingOpen) api.open(pendingOpen === true ? null : pendingOpen);
      })
      .catch(function (err) {
        console.error("[intake-widget] Failed to initialize:", err);
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
