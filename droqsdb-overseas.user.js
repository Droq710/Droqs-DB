// ==UserScript==
// @name         DroqsDB Overseas Stock Reporter
// @namespace    https://droqsdb.com/
// @version      1.3.5
// @description  Collects overseas shop stock+prices and uploads to droqsdb.com
// @author       Droq
// @match        https://www.torn.com/page.php?sid=travel*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";

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

  const SHOP_NAMES = ["General Store", "Arms Dealer", "Black Market"];

  // ---------------- Badge ----------------
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
    badgeEl.style.whiteSpace = "pre-line";
    badgeEl.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)";
    badgeEl.style.background = "rgba(0,0,0,0.85)";
    badgeEl.style.color = "#fff";
    badgeEl.style.display = "none";
    badgeEl.textContent = "DroqsDB: idle";

    (document.body || document.documentElement).appendChild(badgeEl);
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

  // ---------------- Utils ----------------
  function normText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function parseMoneyFromText(text) {
    const t = normText(text);
    // matches: $1,234 or $1234
    const m = t.match(/\$[\s]*([\d,]+)/);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function parseStockFromText(text) {
    const t = normText(text).toLowerCase();

    // common patterns like: "Stock: 12", "12 in stock", "12 Stock"
    const m1 = t.match(/stock[:\s]*([\d,]+)/i);
    if (m1) {
      const n = Number(String(m1[1]).replace(/,/g, ""));
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    const m2 = t.match(/([\d,]+)\s*in\s*stock/i);
    if (m2) {
      const n = Number(String(m2[1]).replace(/,/g, ""));
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    // fallback: pick a reasonable integer present in text
    const nums = Array.from(t.matchAll(/\b(\d{1,3}(?:,\d{3})*)\b/g)).map((x) =>
      Number(String(x[1]).replace(/,/g, ""))
    );
    const candidates = nums.filter((n) => Number.isFinite(n) && n >= 0 && n <= 100000);
    if (!candidates.length) return null;

    // choose the largest as stock tends to be larger than random labels
    return Math.trunc(Math.max(...candidates));
  }

  function looksLikeRow(el) {
    if (!el) return false;
    const text = normText(el.innerText || el.textContent || "");
    if (!text) return false;
    if (!text.includes("$")) return false; // must have price
    return true;
  }

  function pickNameFromRowText(text) {
    const t = normText(text);
    if (!t) return null;

    // remove obvious labels
    const cleaned = t
      .replace(/\bBUY\b/gi, " ")
      .replace(/\bStock\b/gi, " ")
      .replace(/\bIn Stock\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    // take text before first $ if possible
    const beforeDollar = cleaned.split("$")[0].trim();
    if (beforeDollar && beforeDollar.length >= 2 && beforeDollar.length <= 60) {
      // Often "Item Name 123" could appear, strip trailing numbers
      return beforeDollar.replace(/\s+\d+$/g, "").trim();
    }

    // fallback: first "line-ish" token
    const parts = cleaned.split(" ").filter(Boolean);
    if (!parts.length) return null;
    const guess = parts.slice(0, 6).join(" ").trim();
    return guess.length >= 2 ? guess : null;
  }

  function categoryForShop(shop) {
    if (SHOP_NAMES.includes(shop)) return shop;
    return "Uncategorized";
  }

  // ---------------- Country detection ----------------
  function getCountryName() {
    // First: exact matches from common headings
    const headingCandidates = [];

    const h1 = document.querySelector("h1");
    if (h1) headingCandidates.push(normText(h1.textContent));

    const h2 = document.querySelector("h2");
    if (h2) headingCandidates.push(normText(h2.textContent));

    const titleLike = document.querySelector(".title, .header, .travel-title, .content-title");
    if (titleLike) headingCandidates.push(normText(titleLike.textContent));

    for (const c of headingCandidates) {
      if (KNOWN_COUNTRIES.has(c)) return c;
    }

    // Broader scan near top of page
    const topText = Array.from(document.querySelectorAll("h1,h2,h3,div,span"))
      .slice(0, 120)
      .map((el) => normText(el.textContent))
      .filter(Boolean);

    for (const t of topText) {
      if (KNOWN_COUNTRIES.has(t)) return t;
    }

    return null;
  }

  // ---------------- Shop section detection ----------------
  function findShopAnchors() {
    // Find elements whose text includes each shop name.
    const all = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,div,span,button,a"));
    const anchors = [];

    for (const shop of SHOP_NAMES) {
      const shopLower = shop.toLowerCase();
      const el = all.find((n) => normText(n.textContent).toLowerCase() === shopLower)
        || all.find((n) => normText(n.textContent).toLowerCase().includes(shopLower));

      if (el) anchors.push({ shop, el });
    }

    return anchors;
  }

  function nearestSectionRoot(el) {
    // Walk up to a container that likely holds the list of items for that shop
    let cur = el;
    for (let i = 0; i < 10 && cur; i++) {
      const parent = cur.parentElement;
      if (!parent) break;

      // if parent contains multiple "$" occurrences, it's likely the whole section
      const txt = normText(parent.innerText || parent.textContent || "");
      const dollarCount = (txt.match(/\$/g) || []).length;

      if (dollarCount >= 2) return parent;
      cur = parent;
    }
    return el.parentElement || el;
  }

  function collectRowsFromRoot(root) {
    if (!root) return [];

    // Preferred: table rows if they exist
    const trs = Array.from(root.querySelectorAll("tr")).filter(looksLikeRow);
    if (trs.length) return trs;

    // Otherwise: common row containers
    const candidates = Array.from(root.querySelectorAll("li, .row, .item, .item-row, .content, div"))
      .filter((el) => {
        // avoid gigantic container divs
        if (el.querySelectorAll("div,span,a,button,li,tr").length > 120) return false;
        return looksLikeRow(el);
      });

    // Keep only those that look like a single item (has a Buy button OR not too long)
    return candidates.filter((el) => {
      const t = normText(el.innerText || el.textContent || "");
      const buyish = /buy/i.test(t) || !!el.querySelector("button, a");
      return buyish || t.length < 220;
    });
  }

  function parseRow(shop, rowEl) {
    const text = normText(rowEl.innerText || rowEl.textContent || "");
    if (!text || !text.includes("$")) return null;

    const cost = parseMoneyFromText(text);
    const stock = parseStockFromText(text);
    const name = pickNameFromRowText(text);

    if (!name || cost === null || stock === null) return null;

    return {
      name,
      stock,
      cost,
      shop,
      category: categoryForShop(shop),
    };
  }

  function collectAllItems() {
    const anchors = findShopAnchors();

    // If we can't find shop anchors, we are probably not on the shop view
    if (!anchors.length) return [];

    const allItems = [];
    const seen = new Set();

    for (const { shop, el } of anchors) {
      const root = nearestSectionRoot(el);
      const rows = collectRowsFromRoot(root);

      for (const row of rows) {
        const parsed = parseRow(shop, row);
        if (!parsed) continue;

        const key = `${parsed.shop}::${parsed.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push(parsed);
      }
    }

    return allItems;
  }

  // ---------------- Upload ----------------
  async function uploadReport(country, items) {
    const payload = JSON.stringify({ country, items });

    // Prefer GM_xmlhttpRequest (bypasses page CSP, best for Torn + TornPDA)
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

    // Fallback (may be blocked by CSP in some environments)
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      mode: "cors",
      credentials: "omit",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  }

  // ---------------- Run loop ----------------
  let lastSignature = null;

  async function tryScanAndUpload() {
    if (!location.href.includes("page.php?sid=travel")) return;

    showBadge("DroqsDB: loaded\nScanning…");

    const country = getCountryName();
    if (!country) {
      showBadge("DroqsDB: scanning…\nCountry not detected");
      hideBadgeSoon(2000);
      return;
    }

    const items = collectAllItems();

    if (!items.length) {
      showBadge(`DroqsDB: ${country}\nNo shop items detected`);
      hideBadgeSoon(2500);
      return;
    }

    // signature: prevents spam uploads
    const sig =
      country +
      "::" +
      items
        .map((i) => `${i.shop}|${i.name}|${i.stock}|${i.cost}`)
        .join(";");

    if (sig === lastSignature) {
      showBadge(`DroqsDB: ${country}\nNo changes detected`);
      hideBadgeSoon(1500);
      return;
    }
    lastSignature = sig;

    showBadge(`DroqsDB: ${country}\nUploading…\nItems: ${items.length}`);

    try {
      await uploadReport(country, items);
      showBadge(`DroqsDB: ${country}\nUploaded ✓\nItems: ${items.length}`);
      hideBadgeSoon(2000);
    } catch (e) {
      showBadge(`DroqsDB: ${country}\nUpload failed\n${String(e.message || e)}`);
      hideBadgeSoon(3500);
    }
  }

  // Initial run + MutationObserver (page updates dynamically)
  tryScanAndUpload();

  const obs = new MutationObserver(() => {
    if (window.__droqsdb_scan_timer) clearTimeout(window.__droqsdb_scan_timer);
    window.__droqsdb_scan_timer = setTimeout(tryScanAndUpload, 500);
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
