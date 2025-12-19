// ==UserScript==
// @name         DroqsDB Overseas Stock Reporter
// @namespace    https://droqsdb.com/
// @version      1.3.4
// @description  Collects overseas shop stock+prices and uploads to droqsdb.com
// @author       Droq
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/page.php?sid=travel
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";

  // ---- UI badge (only visible during work) ----
  let badgeEl = null;
  let hideTimer = null;

  function ensureBadge() {
    if (badgeEl) return badgeEl;

    badgeEl = document.createElement("div");
    badgeEl.style.position = "fixed";
    badgeEl.style.right = "10px";
    badgeEl.style.bottom = "10px";
    badgeEl.style.zIndex = "999999";
    badgeEl.style.padding = "8px 10px";
    badgeEl.style.borderRadius = "10px";
    badgeEl.style.fontSize = "12px";
    badgeEl.style.fontFamily = "Arial, sans-serif";
    badgeEl.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)";
    badgeEl.style.background = "rgba(0,0,0,0.85)";
    badgeEl.style.color = "#fff";
    badgeEl.style.display = "none";
    badgeEl.textContent = "DroqsDB: idle";

    document.body.appendChild(badgeEl);
    return badgeEl;
  }

  function showBadge(text) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    el.textContent = text;
    el.style.display = "block";
  }

  function hideBadgeSoon(ms = 2000) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      el.style.display = "none";
    }, ms);
  }

  // ---- Utilities ----
  function normText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function parseMoney(s) {
    const t = normText(s).replace(/[$,]/g, "");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function parseIntSafe(s) {
    const t = normText(s).replace(/[,]/g, "");
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  // ---- Country detection ----
  function getCountryName() {
    // Desktop + TornPDA typically have a main heading with the country name
    // Common patterns: "Mexico" appears in h1/h2, or in the travel location header.
    const candidates = [];

    const h1 = document.querySelector("h1");
    if (h1) candidates.push(normText(h1.textContent));

    const h2 = document.querySelector("h2");
    if (h2) candidates.push(normText(h2.textContent));

    // Torn classic travel page: left/top header includes country as plain text in a container
    const titleLike = document.querySelector(".title, .header, .travel-title, .content-title");
    if (titleLike) candidates.push(normText(titleLike.textContent));

    // As fallback, look for a single large breadcrumb/title near the top of content
    const anyBig = Array.from(document.querySelectorAll("div, span"))
      .slice(0, 80)
      .map((el) => normText(el.textContent))
      .filter(Boolean);

    for (const c of candidates) {
      if (KNOWN_COUNTRIES.has(c)) return c;
    }
    for (const t of anyBig) {
      if (KNOWN_COUNTRIES.has(t)) return t;
    }

    return null;
  }

  const KNOWN_COUNTRIES = new Set([
    "Mexico",
    "Cayman Islands",
    "Canada",
    "Hawaii",
    "United Kingdom",
    "Argentina",
    "Switzerland",
    "Japan",
    "China",
    "UAE",
    "South Africa",
  ]);

  // ---- Shop table extraction ----
  const SHOP_NAMES = ["General Store", "Arms Dealer", "Black Market"];

  function findShopSections() {
    // Approach:
    // Find headers that match shop names. For each header, find the next <table> after it.
    const sections = [];

    // Gather likely header nodes
    const textNodes = Array.from(document.querySelectorAll("div, h3, h4, h5, span"))
      .filter((el) => el.children.length === 0) // leaf-ish
      .map((el) => ({ el, text: normText(el.textContent) }))
      .filter((x) => SHOP_NAMES.includes(x.text));

    for (const { el, text } of textNodes) {
      // find next table after header
      let cur = el;
      let table = null;

      // walk forward in DOM siblings / parent siblings
      for (let i = 0; i < 20 && cur; i++) {
        if (cur.nextElementSibling) {
          cur = cur.nextElementSibling;
        } else {
          cur = cur.parentElement;
          continue;
        }

        if (!cur) break;
        if (cur.tagName === "TABLE") {
          table = cur;
          break;
        }
        const t = cur.querySelector && cur.querySelector("table");
        if (t) {
          table = t;
          break;
        }
      }

      if (table) sections.push({ shop: text, table });
    }

    // De-dupe by table reference
    const seen = new Set();
    return sections.filter((s) => {
      if (seen.has(s.table)) return false;
      seen.add(s.table);
      return true;
    });
  }

  function parseTableRows(shop, table) {
    const out = [];
    const rows = Array.from(table.querySelectorAll("tr"));
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 4) continue;

      // Torn travel tables generally: [icon] [name] [type] [cost] [stock] ...
      // TornPDA table: [icon] [name] [stock] [cost] [buy]
      const cellTexts = tds.map((td) => normText(td.textContent));

      // Detect name/stock/cost by heuristics
      let name = null;
      let cost = null;
      let stock = null;

      // If there's a money-looking cell, that's cost
      for (const txt of cellTexts) {
        if (txt.includes("$")) {
          const m = parseMoney(txt);
          if (m !== null) {
            cost = m;
            break;
          }
        }
      }

      // Stock is usually a plain number cell (often near cost)
      // Pick the largest-ish integer cell that isn't the cost
      const nums = cellTexts
        .map((t) => parseIntSafe(t))
        .filter((n) => n !== null && n >= 0);

      // Name: first non-empty text that isn't purely numeric and isn't "BUY"
      for (const txt of cellTexts) {
        if (!txt) continue;
        if (txt.toUpperCase() === "BUY") continue;
        if (/^\$[\d,]+$/.test(txt)) continue;
        if (/^[\d,]+$/.test(txt)) continue;
        if (txt.length < 2) continue;
        name = txt;
        break;
      }

      // Stock heuristic: choose a number cell that isn't cost and isn't tiny like "0/29"
      if (nums.length) {
        // If TornPDA, stock is often one of the earliest numeric cells
        stock = nums[0];
        // But if nums[0] is suspiciously small and there are other candidates, choose max
        if (nums.length > 1 && stock !== null && stock <= 5) {
          stock = Math.max(...nums);
        }
      }

      if (!name || cost === null || stock === null) continue;

      out.push({
        name,
        stock,
        cost,
        shop,
      });
    }
    return out;
  }

  function collectAllItems() {
    const sections = findShopSections();

    // If headers aren't found (some layouts), fallback: find ANY tables inside main content
    if (!sections.length) {
      const tables = Array.from(document.querySelectorAll("table"));
      // best effort: treat as unknown shop
      const items = [];
      for (const t of tables) items.push(...parseTableRows("General Store", t));
      return items;
    }

    const items = [];
    for (const s of sections) {
      items.push(...parseTableRows(s.shop, s.table));
    }
    return items;
  }

  // ---- Upload (GM_xmlhttpRequest preferred, fetch fallback for TornPDA) ----
  async function uploadReport(country, items) {
    const payload = JSON.stringify({ country, items });

    // GM_xmlhttpRequest path
    if (typeof GM_xmlhttpRequest === "function") {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: API_URL,
          headers: { "Content-Type": "application/json" },
          data: payload,
          timeout: 20000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) resolve(true);
            else reject(new Error(`HTTP ${res.status}`));
          },
          onerror: () => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    // fetch fallback (works better in TornPDA / webviews)
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  }

  // ---- Run logic ----
  let lastSignature = null;
  async function tryScanAndUpload() {
    const url = location.href;
    if (!url.includes("page.php?sid=travel")) return;

    const country = getCountryName();
    if (!country) return;

    const items = collectAllItems();
    if (!items.length) {
      showBadge(`DroqsDB: ${country}\nNo items found`);
      hideBadgeSoon(2500);
      return;
    }

    // Prevent spam uploads: compute a signature based on names+cost+stock+shop
    const sig = country + "::" + items.map((i) => `${i.shop}|${i.name}|${i.stock}|${i.cost}`).join(";");
    if (sig === lastSignature) return;
    lastSignature = sig;

    showBadge(`DroqsDB: scanning...\n${country}\nItems: ${items.length}`);

    try {
      showBadge(`DroqsDB: uploading...\n${country}\nItems: ${items.length}`);
      await uploadReport(country, items);
      showBadge(`DroqsDB: uploaded ✓\n${country}\nItems: ${items.length}`);
      hideBadgeSoon(2000);
    } catch (e) {
      showBadge(`DroqsDB: upload failed\n${country}\n${String(e.message || e)}`);
      hideBadgeSoon(3500);
    }
  }

  // Initial attempt + observe DOM changes (travel page loads content dynamically)
  tryScanAndUpload();

  const obs = new MutationObserver(() => {
    // debounce-ish: let DOM settle
    if (window.__droqsdb_scan_timer) clearTimeout(window.__droqsdb_scan_timer);
    window.__droqsdb_scan_timer = setTimeout(tryScanAndUpload, 350);
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
