// ==UserScript==
// @name         DroqsDB Overseas Stock Reporter
// @namespace    https://droqsdb.com/
// @version      1.4.3
// @description  Collects overseas shop stock+prices and uploads to droqsdb.com (Desktop + TornPDA iOS fallback)
// @author       Droq
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://torn.com/page.php?sid=travel*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";

  // Keep this OFF by default. If you ever need to debug a user’s issue,
  // temporarily set true and it will show extra badge info.
  const DEBUG = false;

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

  // ---------------- Badge (ONLY during upload / debug) ----------------
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
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }

  function showBadge(text) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    el.textContent = text;
    el.style.display = "block";
  }

  function hideBadgeSoon(ms = 1200) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      el.style.display = "none";
      el.textContent = "";
    }, ms);
  }

  function debugBadge(text) {
    if (!DEBUG) return;
    showBadge(text);
    hideBadgeSoon(1800);
  }

  // ---------------- Utils ----------------
  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  // Supports:
  //  - $20,000,000
  //  - $20m / $20M
  //  - $1.1m
  //  - $950k
  //  - $2.5b
  function parseMoney(text) {
    const t = norm(text).replace(/\u00A0/g, " "); // nbsp safety
    const m = t.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*([kKmMbB]))?/);
    if (!m) return null;

    let n = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;

    const suffix = (m[2] || "").toLowerCase();
    if (suffix === "k") n *= 1e3;
    else if (suffix === "m") n *= 1e6;
    else if (suffix === "b") n *= 1e9;

    // prices should be integers in Torn, round just in case (e.g. $1.1m)
    n = Math.round(n);
    return Number.isFinite(n) ? n : null;
  }

  function parseIntSafe(text) {
    const t = norm(text).replace(/,/g, "");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  function isValidName(name) {
    const n = norm(name);
    if (n.length < 2 || n.length > 80) return false;
    if (n.startsWith("$")) return false;
    if (!/[A-Za-z]/.test(n)) return false;     // must contain letters
    if (/^[\d\s,$-]+$/.test(n)) return false;  // reject numeric/currency-only
    return true;
  }

  function normalizeShop(shopText) {
    const t = norm(shopText).toLowerCase();
    if (!t) return null;
    if (t.includes("general")) return "General Store";
    if (t.includes("arms")) return "Arms Dealer";
    if (t.includes("black")) return "Black Market";
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect?.();
    if (!r) return true;
    return r.width > 0 && r.height > 0;
  }

  // ---------------- Country detection ----------------
  function getCountryName() {
    // Use the info banner text: "You are in Mexico and have $."
    const pageText = norm(document.body?.innerText || "");
    const m = pageText.match(/You are in\s+([A-Za-z ]+?)\s+and have\b/i);
    if (m) {
      const candidate = norm(m[1]);
      if (KNOWN_COUNTRIES.has(candidate)) return candidate;
    }

    // Backup: exact header match
    const headers = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map((el) => norm(el.textContent))
      .filter(Boolean);

    for (const h of headers) {
      if (KNOWN_COUNTRIES.has(h)) return h;
    }

    return null;
  }

  // ---------------- Scrape (STRICT desktop DOM — unchanged) ----------------
  function getShopHeadersStrict() {
    // <h5 class="shopHeader___.">General Store</h5>
    return Array.from(document.querySelectorAll('h5[class*="shopHeader"]'))
      .map((el) => ({ el, text: norm(el.textContent) }))
      .filter((h) => SHOP_NAMES.includes(h.text));
  }

  function getRowsBetweenStrict(startEl, endEl) {
    // We will walk the DOM in document order from startEl to endEl and collect rows.
    // Row container looks like: <div class="row___wHVtu"> . </div>
    const rows = [];

    let node = startEl;

    // helper: next node in DOM order
    const nextNode = (n) => {
      if (n.firstElementChild) return n.firstElementChild;
      while (n) {
        if (n.nextElementSibling) return n.nextElementSibling;
        n = n.parentElement;
      }
      return null;
    };

    // Move to the next node after header
    node = nextNode(startEl);

    while (node && node !== endEl) {
      if (
        node.nodeType === 1 &&
        node.classList &&
        Array.from(node.classList).some((c) => c.startsWith("row___"))
      ) {
        rows.push(node);
      }
      node = nextNode(node);
    }

    return rows;
  }

  function extractItemFromRowStrict(rowEl, shop) {
    // Name:
    const nameBtn = rowEl.querySelector('button[class*="itemNameButton"]');
    const name = nameBtn ? norm(nameBtn.textContent) : null;
    if (!isValidName(name)) return null;

    // Cost:
    const priceEl = rowEl.querySelector('span[class*="displayPrice"]');
    const cost = priceEl ? parseMoney(priceEl.textContent) : null;

    // Stock:
    const stockEl = rowEl.querySelector('div[data-tt-content-type="stock"]');
    let stock = null;
    if (stockEl) {
      // contains srOnly + number, but textContent ends in the number
      const raw = norm(stockEl.textContent);
      const mm = raw.match(/(\d[\d,]*)\s*$/);
      stock = mm ? parseIntSafe(mm[1]) : parseIntSafe(raw);
    }

    if (cost === null || stock === null) return null;

    return {
      name,
      stock,
      cost,
      shop,
      category: shop, // exactly matches the 3 headers
    };
  }

  function collectItemsStrict() {
    const shopHeaders = getShopHeadersStrict();
    if (!shopHeaders.length) return [];

    const allItems = [];
    const seen = new Set();

    for (let i = 0; i < shopHeaders.length; i++) {
      const { el: headerEl, text: shopText } = shopHeaders[i];
      const shop = normalizeShop(shopText);
      if (!shop) continue;

      const endEl = shopHeaders[i + 1]?.el || null;
      const rows = getRowsBetweenStrict(headerEl, endEl);

      for (const row of rows) {
        const item = extractItemFromRowStrict(row, shop);
        if (!item) continue;

        const key = `${item.shop}::${item.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push(item);
      }
    }

    return allItems;
  }

  // ---------------- TornPDA fallback scraper (iOS-friendly) ----------------
  //
  // Strategy:
  // 1) Try to find clickable “cards” and parse text (fast).
  // 2) If parsing is incomplete, open the item modal (tap) and parse modal text (reliable).
  //
  // IMPORTANT: This only runs if STRICT returned 0 items (so desktop remains unaffected).
  //

  function findShopHeaderElementsLoose() {
    // Find visible elements whose text is exactly one of the shop names
    const candidates = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span"))
      .map((el) => {
        const text = norm(el.textContent);
        return { el, text };
      })
      .filter((x) => SHOP_NAMES.includes(x.text))
      .filter((x) => isVisible(x.el));

    // Deduplicate by same element/text
    const out = [];
    const seen = new Set();
    for (const x of candidates) {
      const key = x.text + "::" + (x.el.tagName || "") + "::" + (x.el.id || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
    return out;
  }

  function getClickableCandidatesBetween(startEl, endEl) {
    // Walk DOM order from startEl to endEl and collect clickable/tappable elements
    // that contain a $price and some digits (stock).
    const items = [];
    const seen = new Set();

    const nextNode = (n) => {
      if (n.firstElementChild) return n.firstElementChild;
      while (n) {
        if (n.nextElementSibling) return n.nextElementSibling;
        n = n.parentElement;
      }
      return null;
    };

    let node = nextNode(startEl);

    while (node && node !== endEl) {
      if (node.nodeType === 1) {
        const tag = node.tagName?.toLowerCase?.() || "";
        const isClickable =
          tag === "button" ||
          tag === "a" ||
          node.getAttribute?.("role") === "button" ||
          typeof node.onclick === "function";

        if (isClickable && isVisible(node)) {
          const txt = norm(node.innerText || node.textContent || "");
          // Heuristic: must contain $number (or $number+k/m/b) and at least one digit group
          if (/\$\s*[\d,]+(?:\.\d+)?\s*[kKmMbB]?/.test(txt) && /\d[\d,]*/.test(txt)) {
            // Avoid capturing huge containers (page wrappers)
            if (txt.length > 0 && txt.length < 400) {
              const key = tag + "::" + txt;
              if (!seen.has(key)) {
                seen.add(key);
                items.push(node);
              }
            }
          }
        }
      }
      node = nextNode(node);
    }

    return items;
  }

  function parseCardTextLoose(text) {
    const t = norm(text);

    // cost: first $xxx (supports k/m/b)
    const cost = parseMoney(t);

    // stock: try common patterns
    let stock = null;

    // e.g. "Stock 1,234" or "Stock: 1,234"
    let m = t.match(/\bStock\b\s*:?[\s]*([\d,]+)/i);
    if (m) stock = parseIntSafe(m[1]);

    // e.g. "Available 1,234"
    if (stock === null) {
      m = t.match(/\bAvailable\b\s*:?[\s]*([\d,]+)/i);
      if (m) stock = parseIntSafe(m[1]);
    }

    // e.g. "1,234 in stock"
    if (stock === null) {
      m = t.match(/([\d,]+)\s+in\s+stock\b/i);
      if (m) stock = parseIntSafe(m[1]);
    }

    // name: best effort — take text before first $ and strip obvious labels
    let name = null;
    const idx = t.indexOf("$");
    if (idx > 1) {
      const before = norm(t.slice(0, idx));
      // take first "line" chunk
      name = norm(before.split("  ")[0] || before);
    } else {
      // fallback: first chunk with letters
      const chunks = t.split(" ").filter(Boolean);
      const firstFew = chunks.slice(0, 6).join(" ");
      if (/[A-Za-z]/.test(firstFew)) name = norm(firstFew);
    }

    // sanitize name (remove shop words/labels if accidentally included)
    if (name) {
      name = name.replace(/\b(General Store|Arms Dealer|Black Market|Stock|Available)\b/gi, "").trim();
      name = norm(name);
    }

    return {
      name: isValidName(name) ? name : null,
      cost: Number.isFinite(cost) ? cost : null,
      stock: Number.isFinite(Number(stock)) ? stock : null,
    };
  }

  function findOpenModal() {
    // Look for dialog-ish container, or a visible overlay with lots of text including $ and Stock/Available
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible);

    if (dialogs.length) {
      // pick the largest visible one
      dialogs.sort((a, b) => (b.getBoundingClientRect().height * b.getBoundingClientRect().width) - (a.getBoundingClientRect().height * a.getBoundingClientRect().width));
      return dialogs[0];
    }

    // Fallback: sometimes modal has no ARIA roles; search for visible container with modal-ish traits
    const possibles = Array.from(document.querySelectorAll("div"))
      .filter(isVisible)
      .filter((el) => {
        const txt = norm(el.innerText || "");
        if (txt.length < 20 || txt.length > 2000) return false;
        if (!/\$\s*[\d,]+(?:\.\d+)?\s*[kKmMbB]?/.test(txt)) return false;
        if (!/\b(Stock|Available|in stock)\b/i.test(txt)) return false;
        // modal often contains a close button text
        if (/\bClose\b/i.test(txt) || /\bBack\b/i.test(txt) || /×/.test(txt)) return true;
        return false;
      });

    if (!possibles.length) return null;

    possibles.sort((a, b) => (b.getBoundingClientRect().height * b.getBoundingClientRect().width) - (a.getBoundingClientRect().height * a.getBoundingClientRect().width));
    return possibles[0];
  }

  function tryCloseModal(modalEl) {
    if (!modalEl) return false;

    // Try close buttons inside modal
    const closeBtn =
      modalEl.querySelector('button[aria-label*="close" i]') ||
      modalEl.querySelector('button[title*="close" i]') ||
      Array.from(modalEl.querySelectorAll("button,a,[role=button]")).find((el) => {
        const txt = norm(el.innerText || el.textContent || "");
        return /^close$/i.test(txt) || /^back$/i.test(txt) || txt === "×" || txt === "✕";
      });

    if (closeBtn) {
      closeBtn.click();
      return true;
    }

    // Fallback: tap outside (dispatch click on backdrop if exists)
    // try nearest ancestor that looks like overlay and click it
    let p = modalEl.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      const style = window.getComputedStyle(p);
      const txt = norm(p.innerText || "");
      if (style && style.position === "fixed" && txt.length > 0) {
        p.click();
        return true;
      }
      p = p.parentElement;
    }

    return false;
  }

  async function parseViaModal(itemEl) {
    // Click item to open modal
    itemEl.click();

    // Wait for modal to appear
    let modal = null;
    for (let i = 0; i < 12; i++) {
      await sleep(120);
      modal = findOpenModal();
      if (modal) break;
    }
    if (!modal) return null;

    const text = norm(modal.innerText || modal.textContent || "");

    // name: prefer heading-like first line
    let name = null;
    const heading = modal.querySelector("h1,h2,h3,h4,h5,h6");
    if (heading) name = norm(heading.textContent);

    if (!isValidName(name)) {
      // fallback: first chunk that looks like an item name
      const firstLine = norm(text.split("\n").map(norm).filter(Boolean)[0] || "");
      if (isValidName(firstLine)) name = firstLine;
    }

    // cost & stock from modal text (supports k/m/b)
    const cost = parseMoney(text);

    let stock = null;
    let m = text.match(/\bStock\b\s*:?[\s]*([\d,]+)/i);
    if (m) stock = parseIntSafe(m[1]);

    if (stock === null) {
      m = text.match(/\bAvailable\b\s*:?[\s]*([\d,]+)/i);
      if (m) stock = parseIntSafe(m[1]);
    }

    if (stock === null) {
      m = text.match(/([\d,]+)\s+in\s+stock\b/i);
      if (m) stock = parseIntSafe(m[1]);
    }

    // Close modal
    tryCloseModal(modal);
    await sleep(120);

    if (!isValidName(name) || cost === null || stock === null) return null;

    return { name, cost, stock };
  }

  async function collectItemsTornPDA() {
    const headers = findShopHeaderElementsLoose();
    if (!headers.length) {
      debugBadge("DroqsDB: TornPDA fallback\nNo shop headers found");
      return [];
    }

    const allItems = [];
    const seen = new Set();

    // Try to get items per shop section by walking DOM between headers
    for (let i = 0; i < headers.length; i++) {
      const headerEl = headers[i].el;
      const shop = normalizeShop(headers[i].text);
      if (!shop) continue;

      const endEl = headers[i + 1]?.el || null;

      const candidates = getClickableCandidatesBetween(headerEl, endEl);

      // First pass: parse from card text
      const parsed = [];
      for (const el of candidates) {
        const txt = norm(el.innerText || el.textContent || "");
        const p = parseCardTextLoose(txt);

        if (p.name && p.cost !== null && p.stock !== null) {
          parsed.push({ el, ...p });
        } else if (p.name) {
          // keep as maybe, modal can fix
          parsed.push({ el, ...p });
        }
      }

      // Second pass: if too incomplete, use modal for missing fields (cap to avoid long loops)
      let completedCount = 0;
      for (const p of parsed) {
        let name = p.name;
        let cost = p.cost;
        let stock = p.stock;

        if (!name || cost === null || stock === null) {
          // Use modal (most reliable on iOS TornPDA)
          const modalData = await parseViaModal(p.el);
          if (modalData) {
            name = modalData.name;
            cost = modalData.cost;
            stock = modalData.stock;
          }
        }

        if (!name || cost === null || stock === null) continue;

        const key = `${shop}::${name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push({
          name,
          stock,
          cost,
          shop,
          category: shop,
        });

        completedCount++;
        // Gentle pacing so we don’t overwhelm the WebView
        if (completedCount % 5 === 0) await sleep(180);
      }
    }

    // Safety: avoid uploading junk if something went wrong
    // If we found < 5 items total, treat it as failure (prevents bad uploads).
    if (allItems.length < 5) {
      debugBadge(`DroqsDB: TornPDA fallback\nToo few items (${allItems.length}) — abort`);
      return [];
    }

    return allItems;
  }

  // ---------------- Upload ----------------
  async function uploadReport(country, items) {
    const payload = JSON.stringify({ country, items });

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
  let isBusy = false;

  async function collectItemsSmart() {
    // 1) Try strict (desktop)
    const strictItems = collectItemsStrict();
    if (strictItems.length) {
      debugBadge(`DroqsDB: strict OK\nItems: ${strictItems.length}`);
      return { items: strictItems, mode: "strict" };
    }

    // 2) TornPDA fallback (only if strict found nothing)
    const fallbackItems = await collectItemsTornPDA();
    if (fallbackItems.length) {
      debugBadge(`DroqsDB: fallback OK\nItems: ${fallbackItems.length}`);
      return { items: fallbackItems, mode: "tornpda" };
    }

    return { items: [], mode: "none" };
  }

  async function scanAndMaybeUpload() {
    if (isBusy) return;
    isBusy = true;

    try {
      // Only run on travel page (already matched, but keep safe)
      if (!location.href.includes("page.php?sid=travel")) return;

      const country = getCountryName();
      if (!country) return; // no badge, no noise

      const { items, mode } = await collectItemsSmart();
      if (!items.length) return; // no badge, no noise

      const sig =
        country +
        "::" +
        items
          .map((i) => `${i.shop}|${i.name}|${i.stock}|${i.cost}`)
          .join(";");

      if (sig === lastSignature) return; // no badge, no noise
      lastSignature = sig;

      // Badge ONLY during upload
      showBadge(`DroqsDB Uploading…\n${country}\nItems: ${items.length}\nMode: ${mode}`);

      try {
        await uploadReport(country, items);
        showBadge(`DroqsDB Uploaded ✓\n${country}\nItems: ${items.length}\nMode: ${mode}`);
        hideBadgeSoon(900);
      } catch (e) {
        showBadge(`DroqsDB Upload Failed\n${country}\n${String(e.message || e)}`);
        hideBadgeSoon(2000);
      }
    } finally {
      isBusy = false;
    }
  }

  // Run once after load, then observe changes (React-style UI updates)
  scanAndMaybeUpload();

  const obs = new MutationObserver(() => {
    if (window.__droqsdb_scan_timer) clearTimeout(window.__droqsdb_scan_timer);
    window.__droqsdb_scan_timer = setTimeout(scanAndMaybeUpload, 650);
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
