// widget.js
//
// Usage on a client's site:
//   <script src="https://yourdomain.com/widget.js" data-client="smith-law"></script>
//
// What it does:
//   1. Reads the client's ID off its own <script> tag.
//   2. Fetches that client's branding/questions from /api/client-config,
//      caching the result in localStorage so repeat visits (and multiple
//      page loads on the same site) don't refetch every time.
//   3. Renders a floating button that opens the intake modal on click.
//   4. Submits completed intakes to /api/leads, tagged with this client_id.

(function () {
    const CONFIG_CACHE_HOURS = 6; // how long to trust a cached config before refetching
    const API_BASE = "https://yourdomain.com"; // replace with your production domain
  
    // Find our own <script> tag to read the data-client attribute off it.
    const currentScript =
      document.currentScript ||
      (function () {
        const scripts = document.getElementsByTagName("script");
        return scripts[scripts.length - 1];
      })();
  
    const clientId = currentScript.getAttribute("data-client");
    if (!clientId) {
      console.error("[intake-widget] Missing data-client attribute on script tag.");
      return;
    }
  
    const cacheKey = `intake-widget-config:${clientId}`;
  
    function getCachedConfig() {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (!raw) return null;
        const { config, fetchedAt } = JSON.parse(raw);
        const ageHours = (Date.now() - fetchedAt) / (1000 * 60 * 60);
        if (ageHours > CONFIG_CACHE_HOURS) return null;
        return config;
      } catch {
        return null; // localStorage unavailable or corrupted — just refetch
      }
    }
  
    function setCachedConfig(config) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ config, fetchedAt: Date.now() }));
      } catch {
        // Non-fatal if storage is full/blocked — widget still works, just refetches next time.
      }
    }
  
    async function fetchConfig() {
      const cached = getCachedConfig();
      if (cached) return cached;
  
      const res = await fetch(`${API_BASE}/api/client-config?client_id=${encodeURIComponent(clientId)}`);
      if (!res.ok) throw new Error("Failed to load intake widget config");
      const config = await res.json();
      setCachedConfig(config);
      return config;
    }
  
    function injectStyles(primaryColor) {
      const style = document.createElement("style");
      style.textContent = `
        .intake-widget-launcher {
          position: fixed; bottom: 24px; right: 24px; z-index: 999999;
          background: ${primaryColor}; color: #fff; border: none; border-radius: 999px;
          padding: 14px 22px; font-family: system-ui, sans-serif; font-size: 15px;
          font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.2);
        }
        .intake-widget-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999998;
          display: flex; align-items: center; justify-content: center;
        }
        .intake-widget-modal {
          background: #fff; border-radius: 12px; padding: 32px; max-width: 480px;
          width: 90%; font-family: system-ui, sans-serif; max-height: 85vh; overflow-y: auto;
        }
        .intake-widget-modal h2 { margin-top: 0; color: ${primaryColor}; }
        .intake-widget-modal input, .intake-widget-modal select, .intake-widget-modal textarea {
          width: 100%; padding: 10px; margin-bottom: 12px; border: 1px solid #ccc;
          border-radius: 6px; font-size: 14px; box-sizing: border-box;
        }
        .intake-widget-submit {
          background: ${primaryColor}; color: #fff; border: none; border-radius: 6px;
          padding: 12px 20px; font-weight: 600; cursor: pointer; width: 100%;
        }
        .intake-widget-close {
          position: absolute; top: 12px; right: 16px; background: none; border: none;
          font-size: 20px; cursor: pointer; color: #666;
        }
      `;
      document.head.appendChild(style);
    }
  
    function buildModal(config) {
      const overlay = document.createElement("div");
      overlay.className = "intake-widget-overlay";
      overlay.style.display = "none";
  
      const areaOptions = (config.practice_areas || [])
        .map((a) => `<option value="${a.value}">${a.label}</option>`)
        .join("");
  
      overlay.innerHTML = `
        <div class="intake-widget-modal" style="position: relative;">
          <button class="intake-widget-close" aria-label="Close">&times;</button>
          <h2>${config.logo_url ? `<img src="${config.logo_url}" alt="${config.firm_name}" style="height:28px;vertical-align:middle;margin-right:8px;">` : ""}Tell us about your case</h2>
          <form id="intake-widget-form">
            <select name="primary_area" required>
              <option value="">What kind of case is this?</option>
              ${areaOptions}
            </select>
            <textarea name="description" placeholder="Briefly describe what happened" rows="3" required></textarea>
            <input type="text" name="first_name" placeholder="First name" required />
            <input type="text" name="last_name" placeholder="Last name" required />
            <input type="email" name="email" placeholder="Email" required />
            <input type="tel" name="phone" placeholder="Phone" required />
            <button type="submit" class="intake-widget-submit">Submit</button>
            <p id="intake-widget-status" style="font-size:13px;margin-top:8px;"></p>
          </form>
        </div>
      `;
  
      document.body.appendChild(overlay);
  
      overlay.querySelector(".intake-widget-close").addEventListener("click", () => {
        overlay.style.display = "none";
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.style.display = "none";
      });
  
      const form = overlay.querySelector("#intake-widget-form");
      const status = overlay.querySelector("#intake-widget-status");
  
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {
          clientId: config.client_id,
          primaryArea: fd.get("primary_area"),
          subType: null,
          detail1: null,
          detail2: null,
          description: fd.get("description"),
          firstName: fd.get("first_name"),
          lastName: fd.get("last_name"),
          email: fd.get("email"),
          phone: fd.get("phone"),
          callPreference: null,
          submittedAt: new Date().toISOString(),
        };
  
        status.textContent = "Submitting...";
        try {
          const res = await fetch(`${API_BASE}/api/leads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) throw new Error("Submit failed");
          form.innerHTML = "";
          status.textContent = "Thanks! We'll be in touch shortly.";
        } catch {
          status.textContent = "Something went wrong — please call us directly.";
        }
      });
  
      return overlay;
    }
  
    function buildLauncher(overlay) {
      const btn = document.createElement("button");
      btn.className = "intake-widget-launcher";
      btn.textContent = "Start Your Case Review";
      btn.addEventListener("click", () => {
        overlay.style.display = "flex";
      });
      document.body.appendChild(btn);
    }
  
    fetchConfig()
      .then((config) => {
        injectStyles(config.primary_color || "#1a1a2e");
        const overlay = buildModal(config);
        buildLauncher(overlay);
      })
      .catch((err) => {
        console.error("[intake-widget] Failed to initialize:", err);
      });
  })();