// ==UserScript==
// @name         UTOON Chapter Capture → EPUB
// @namespace    https://github.com/local/utoon-epub
// @version      1.0
// @description  Capture the prose of utoon.net chapters as you read them, then export a ZIP (metadata.json + chapter_N.html) for offline epub building.
// @match        https://utoon.net/manga/*/chapter-*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const PROSE_SELECTOR = "main#reader .text-left";

  // -----------------------------------------------------------------------
  // Identify the current novel + chapter
  // -----------------------------------------------------------------------

  function novelSlug() {
    // URL: https://utoon.net/manga/<slug>/chapter-N/
    const m = location.pathname.match(/\/manga\/([^/]+)\//);
    return m ? m[1] : "unknown-novel";
  }

  function novelName() {
    // Prefer og:title, strip the " – UTOON" site suffix.
    const og = document.querySelector('meta[property="og:title"]');
    let name = og ? og.content : document.title;
    name = name.replace(/\s*[–—-]\s*UTOON.*$/i, "").trim();
    return name || novelSlug();
  }

  function currentChapterNum() {
    // Hidden input is the most reliable: <input id="wp-manga-current-chap" value="chapter-1">
    const input = document.querySelector("#wp-manga-current-chap");
    if (input && input.value) {
      const m = input.value.match(/chapter-(\d+)/i);
      if (m) return parseInt(m[1], 10);
    }
    // Fallback to the URL.
    const m = location.pathname.match(/chapter-(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Per-novel storage key
  function storeKey() {
    return `utoon_capture::${novelSlug()}`;
  }

  function loadStore() {
    const raw = GM_getValue(storeKey(), null);
    if (!raw) return { name: novelName(), chapters: {} };
    try {
      return JSON.parse(raw);
    } catch {
      return { name: novelName(), chapters: {} };
    }
  }

  function saveStore(store) {
    GM_setValue(storeKey(), JSON.stringify(store));
  }

  // -----------------------------------------------------------------------
  // Wait for prose to load (utoon hydrates content with a delay)
  // -----------------------------------------------------------------------

  function waitForProse(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(PROSE_SELECTOR);
        if (el && el.innerText.trim().length > 200) {
          resolve(el);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  // -----------------------------------------------------------------------
  // Capture
  // -----------------------------------------------------------------------

  async function captureCurrent(panel) {
    const num = currentChapterNum();
    if (num === null) {
      setStatus(panel, "Could not determine chapter number.", "err");
      return false;
    }

    const el = await waitForProse();
    if (!el) {
      setStatus(panel, `Chapter ${num}: content didn't load.`, "err");
      return false;
    }

    const store = loadStore();
    store.name = novelName();
    store.chapters[num] = el.innerHTML;
    saveStore(store);

    refreshPanel(panel);
    setStatus(panel, `Captured chapter ${num}.`, "ok");
    return true;
  }

  // -----------------------------------------------------------------------
  // Auto-advance to the next chapter
  // -----------------------------------------------------------------------

  let advanceTimer = null;

  function findNextLink() {
    // The "Next" control is an <a class="nb"> inside nav#botbar whose text is
    // "Next" and whose href points at another chapter (the Series link shares
    // the class but has no chapter- segment; Prev points backwards).
    const nav = document.querySelector("nav#botbar");
    if (!nav) return null;
    for (const a of nav.querySelectorAll("a.nb")) {
      if (a.textContent.trim().toLowerCase() === "next" && /chapter-\d+/i.test(a.href)) {
        return a;
      }
    }
    return null;
  }

  function cancelAdvance(panel) {
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
      if (panel) setStatus(panel, "Auto-advance cancelled.", "info");
    }
  }

  function scheduleAdvance(panel, delayMs = 2000) {
    const next = findNextLink();
    if (!next) {
      setStatus(panel, "No next chapter — auto-advance stopped.", "info");
      return;
    }
    setStatus(panel, `Auto-advancing in ${(delayMs / 1000).toFixed(0)}s…`, "info");
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      next.click();
    }, delayMs);
  }

  // -----------------------------------------------------------------------
  // Export ZIP
  // -----------------------------------------------------------------------

  function triggerDownload(blob, filename) {
    console.debug("[utoon] triggerDownload:", filename, "blob size:", blob && blob.size);

    // Preferred path: GM_download (most reliable in userscript managers).
    if (typeof GM_download === "function") {
      try {
        const url = URL.createObjectURL(blob);
        GM_download({
          url,
          name: filename,
          onload: () => {
            console.debug("[utoon] GM_download onload OK");
            URL.revokeObjectURL(url);
          },
          onerror: (e) => {
            console.error("[utoon] GM_download error, falling back to anchor:", e);
            URL.revokeObjectURL(url);
            anchorDownload(blob, filename);
          },
        });
        return;
      } catch (e) {
        console.error("[utoon] GM_download threw, falling back to anchor:", e);
      }
    }

    anchorDownload(blob, filename);
  }

  function anchorDownload(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      console.debug("[utoon] anchorDownload: clicking anchor for", filename);
      a.click();
      // Delay cleanup slightly so the browser can start the download.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      console.error("[utoon] anchorDownload failed:", e);
    }
  }

  function sortedChapterNums(store) {
    return Object.keys(store.chapters).map(Number).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------
  // Pure-JS store-only ZIP encoder.
  // JSZip's async generation relies on a scheduler (setImmediate/postMessage)
  // that doesn't run in some userscript sandboxes, causing generateAsync to
  // hang forever. Building the ZIP bytes synchronously by hand sidesteps that
  // entirely — no async, no dependency. All entries are STORED (uncompressed),
  // which is required for the epub mimetype anyway and fine for text.
  // ---------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // entries: [{ name: string, data: Uint8Array }]  — all stored, no compression
  function buildZipBytes(entries) {
    const encName = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = encName.encode(e.name);
      const data = e.data;
      const crc = crc32(data);
      const size = data.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);   // UTF-8 filename flag
      lv.setUint16(8, 0, true);        // store
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);    // 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      chunks.push(lh, data);

      const ch = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + data.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const ch of central) { chunks.push(ch); cdSize += ch.length; }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    chunks.push(eocd);

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // Build a downloadable Blob from {name, text} entries.
  function buildArchiveBlob(textEntries, mimeType) {
    const enc = new TextEncoder();
    const entries = textEntries.map((e) => ({
      name: e.name,
      data: e.data instanceof Uint8Array ? e.data : enc.encode(e.text),
    }));
    console.debug("[utoon] buildZipBytes: encoding", entries.length, "entries...");
    const bytes = buildZipBytes(entries);
    console.debug("[utoon] buildZipBytes: done,", bytes.length, "bytes");
    return new Blob([bytes], { type: mimeType });
  }

  function downloadZip(panel) {
    console.debug("[utoon] downloadZip clicked");
    const store = loadStore();
    const nums = sortedChapterNums(store);
    console.debug("[utoon] captured chapters:", nums);

    if (nums.length === 0) {
      setStatus(panel, "Nothing captured yet.", "err");
      return;
    }

    try {
      const metadata = {
        name: store.name,
        first: nums[0],
        last: nums[nums.length - 1],
      };
      const entries = [
        { name: "metadata.json", text: JSON.stringify(metadata, null, 2) },
        ...nums.map((num) => ({ name: `chapter_${num}.html`, text: store.chapters[num] })),
      ];
      const blob = buildArchiveBlob(entries, "application/zip");
      console.debug("[utoon] zip blob ready, size:", blob.size);
      triggerDownload(blob, `${novelSlug()}.zip`);

      setStatus(panel, `Exported ${nums.length} chapters (${metadata.first}\u2013${metadata.last}).`, "ok");
    } catch (e) {
      console.error("[utoon] downloadZip failed:", e);
      setStatus(panel, "ZIP export failed (see console).", "err");
    }
  }

  // -----------------------------------------------------------------------
  // Export EPUB
  // -----------------------------------------------------------------------

  const EPUB_CSS = [
    "body { font-family: Georgia, serif; line-height: 1.7; margin: 1em 2em; color: #1a1a1a; }",
    "h1, h2, h3 { font-family: sans-serif; margin-top: 2em; color: #111; }",
    "p { margin: 0.4em 0; text-indent: 1.2em; }",
    "hr { margin: 2em auto; width: 50%; border: none; border-top: 1px solid #ccc; }",
  ].join("\n");

  function xmlEscape(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // Parse a captured fragment and return { title, xhtmlBody }.
  // Re-serializing through DOMParser/XMLSerializer guarantees well-formed XHTML
  // that strict epub readers will accept.
  function buildChapterXhtmlBody(fragment, num) {
    // Wrap in a container and parse as HTML so we can clean + re-serialize.
    const doc = new DOMParser().parseFromString(
      `<div id="uc-wrap">${fragment}</div>`,
      "text/html"
    );
    const wrap = doc.getElementById("uc-wrap");

    // Title: first <p>/<hN> matching "Chapter N"
    let title = `Chapter ${num}`;
    const re = new RegExp(`\\bchapter\\s*${num}\\b`, "i");
    for (const tag of wrap.querySelectorAll("p, h1, h2, h3")) {
      const t = (tag.textContent || "").trim();
      if (re.test(t)) {
        title = t;
        break;
      }
    }

    // Strip stray non-prose tags
    wrap.querySelectorAll("input, script, style, button, iframe").forEach((n) => n.remove());

    // Trim from an "End of Chapter" marker onwards
    const endRe = /end of chapter/i;
    const children = Array.from(wrap.children);
    for (let i = 0; i < children.length; i++) {
      if (endRe.test(children[i].textContent || "")) {
        for (let j = i; j < children.length; j++) children[j].remove();
        break;
      }
    }

    // Re-serialize the cleaned nodes as XHTML via an XML document.
    const xmlDoc = document.implementation.createDocument(
      "http://www.w3.org/1999/xhtml",
      "body",
      null
    );
    const body = xmlDoc.documentElement;
    for (const node of Array.from(wrap.childNodes)) {
      body.appendChild(xmlDoc.importNode(node, true));
    }
    let inner = new XMLSerializer().serializeToString(body);
    // Strip the wrapping <body ...> ... </body> the serializer adds.
    inner = inner.replace(/^<body[^>]*>/, "").replace(/<\/body>$/, "");
    if (!inner.trim()) inner = "<p>[No content captured]</p>";

    return { title, xhtmlBody: inner };
  }

  function chapterXhtml(title, bodyInner) {
    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml">\n` +
      `<head>\n` +
      `  <title>${xmlEscape(title)}</title>\n` +
      `  <link rel="stylesheet" href="style.css" type="text/css"/>\n` +
      `</head>\n` +
      `<body>\n` +
      `  <h2>${xmlEscape(title)}</h2>\n` +
      `  ${bodyInner}\n` +
      `</body>\n` +
      `</html>\n`
    );
  }

  function containerXml() {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
      `  <rootfiles>\n` +
      `    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n` +
      `  </rootfiles>\n` +
      `</container>\n`
    );
  }

  function contentOpf(title, author, uid, chapters) {
    const manifestItems = [
      `    <item id="style" href="style.css" media-type="text/css"/>`,
      `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    ];
    const spineItems = [];
    chapters.forEach((c, i) => {
      const id = `chap${i + 1}`;
      manifestItems.push(
        `    <item id="${id}" href="${c.file}" media-type="application/xhtml+xml"/>`
      );
      spineItems.push(`    <itemref idref="${id}"/>`);
    });

    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n` +
      `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
      `    <dc:identifier id="bookid">${xmlEscape(uid)}</dc:identifier>\n` +
      `    <dc:title>${xmlEscape(title)}</dc:title>\n` +
      `    <dc:creator>${xmlEscape(author)}</dc:creator>\n` +
      `    <dc:language>en</dc:language>\n` +
      `    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>\n` +
      `  </metadata>\n` +
      `  <manifest>\n${manifestItems.join("\n")}\n  </manifest>\n` +
      `  <spine toc="ncx">\n${spineItems.join("\n")}\n  </spine>\n` +
      `</package>\n`
    );
  }

  function navXhtml(title, chapters) {
    const lis = chapters
      .map((c) => `        <li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`)
      .join("\n");
    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
      `<head><title>${xmlEscape(title)}</title></head>\n` +
      `<body>\n` +
      `  <nav epub:type="toc" id="toc">\n` +
      `    <h1>Contents</h1>\n` +
      `    <ol>\n${lis}\n    </ol>\n` +
      `  </nav>\n` +
      `</body>\n</html>\n`
    );
  }

  function tocNcx(title, uid, chapters) {
    const points = chapters
      .map(
        (c, i) =>
          `    <navPoint id="np${i + 1}" playOrder="${i + 1}">\n` +
          `      <navLabel><text>${xmlEscape(c.title)}</text></navLabel>\n` +
          `      <content src="${c.file}"/>\n` +
          `    </navPoint>`
      )
      .join("\n");
    return (
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
      `  <head>\n` +
      `    <meta name="dtb:uid" content="${xmlEscape(uid)}"/>\n` +
      `  </head>\n` +
      `  <docTitle><text>${xmlEscape(title)}</text></docTitle>\n` +
      `  <navMap>\n${points}\n  </navMap>\n` +
      `</ncx>\n`
    );
  }

  function downloadEpub(panel) {
    console.debug("[utoon] downloadEpub clicked");
    const store = loadStore();
    const nums = sortedChapterNums(store);
    console.debug("[utoon] captured chapters:", nums);

    if (nums.length === 0) {
      setStatus(panel, "Nothing captured yet.", "err");
      return;
    }

    try {
      const title = (panel.querySelector(".uc-title-input").value || store.name || "Novel").trim();
      const author = (panel.querySelector(".uc-author-input").value || "Unknown").trim();
      const uid = `urn:uuid:utoon-${novelSlug()}-${nums[0]}-${nums[nums.length - 1]}`;

      const chapters = nums.map((num, i) => {
        const { title: chTitle, xhtmlBody } = buildChapterXhtmlBody(store.chapters[num], num);
        return {
          file: `chapter_${String(i + 1).padStart(4, "0")}.xhtml`,
          title: chTitle,
          xhtml: chapterXhtml(chTitle, xhtmlBody),
        };
      });
      console.debug("[utoon] built", chapters.length, "chapter docs");

      // Order matters: mimetype MUST be first. All entries are stored.
      const entries = [
        { name: "mimetype", text: "application/epub+zip" },
        { name: "META-INF/container.xml", text: containerXml() },
        { name: "OEBPS/style.css", text: EPUB_CSS },
        { name: "OEBPS/content.opf", text: contentOpf(title, author, uid, chapters) },
        { name: "OEBPS/nav.xhtml", text: navXhtml(title, chapters) },
        { name: "OEBPS/toc.ncx", text: tocNcx(title, uid, chapters) },
        ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, text: c.xhtml })),
      ];

      const blob = buildArchiveBlob(entries, "application/epub+zip");
      console.debug("[utoon] epub blob ready, size:", blob.size);
      triggerDownload(blob, `${novelSlug()}.epub`);

      setStatus(panel, `Built epub: ${chapters.length} chapters (${nums[0]}\u2013${nums[nums.length - 1]}).`, "ok");
    } catch (e) {
      console.error("[utoon] downloadEpub failed:", e);
      setStatus(panel, "EPUB export failed (see console).", "err");
    }
  }

  function clearStore(panel) {
    if (!confirm("Clear all captured chapters for this novel?")) return;
    GM_deleteValue(storeKey());
    refreshPanel(panel);
    setStatus(panel, "Cleared.", "ok");
  }

  // -----------------------------------------------------------------------
  // UI panel
  // -----------------------------------------------------------------------

  function setStatus(panel, msg, kind) {
    const status = panel.querySelector(".uc-status");
    status.textContent = msg;
    status.style.color = kind === "err" ? "#c0392b" : kind === "ok" ? "#27ae60" : "#555";
  }

  function refreshPanel(panel) {
    const store = loadStore();
    const nums = Object.keys(store.chapters).map(Number).sort((a, b) => a - b);
    const info = panel.querySelector(".uc-info");
    if (nums.length === 0) {
      info.textContent = "No chapters captured.";
    } else {
      info.textContent = `${nums.length} captured (${nums[0]}–${nums[nums.length - 1]})`;
    }
    const cur = currentChapterNum();
    const curLabel = panel.querySelector(".uc-current");
    curLabel.textContent = cur !== null ? `Current: ch.${cur}` : "Current: ?";
  }

  function buildPanel() {
    // Host element holds a shadow root so the page's aggressive CSS reset
    // (e.g. `body :not(...)` rules) cannot reach inside and clobber our styles.
    const host = document.createElement("div");
    host.id = "utoon-capture-host";
    host.style.cssText = "all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;";
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .uc-panel {
        box-sizing: border-box;
        background: #ffffff;
        border: 1px solid #ccc;
        border-radius: 8px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.18);
        padding: 12px 14px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #222;
        width: 230px;
      }
      .uc-title { font-weight: 600; margin-bottom: 6px; color: #222; }
      .uc-current, .uc-info { color: #555; margin-bottom: 2px; }
      .uc-info { margin-bottom: 8px; }
      .uc-auto-label {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 8px; cursor: pointer; color: #222;
      }
      .uc-fields { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .uc-fields input[type="text"] {
        box-sizing: border-box; width: 100%;
        padding: 5px 6px; font: inherit;
        border: 1px solid #bbb; border-radius: 4px;
        background: #fff; color: #222;
      }
      .uc-fields label { font-size: 11px; color: #777; margin-bottom: -3px; }
      .uc-buttons { display: flex; flex-direction: column; gap: 6px; }
      .uc-buttons button {
        box-sizing: border-box;
        padding: 6px; cursor: pointer;
        background: #f4f4f4; color: #222;
        border: 1px solid #bbb; border-radius: 4px;
        font: inherit;
      }
      .uc-buttons button:hover { background: #e8e8e8; }
      .uc-buttons .uc-clear { color: #c0392b; border-color: #e0b4ae; }
      .uc-status { margin-top: 8px; min-height: 1.2em; color: #555; }
    `;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "uc-panel";
    panel.innerHTML = `
      <div class="uc-title">utoon → epub capture</div>
      <div class="uc-current"></div>
      <div class="uc-info"></div>
      <label class="uc-auto-label">
        <input type="checkbox" class="uc-auto" checked> Auto-capture on load
      </label>
      <label class="uc-auto-label">
        <input type="checkbox" class="uc-advance"> Auto-advance to next
      </label>
      <div class="uc-fields">
        <label>Title</label>
        <input type="text" class="uc-title-input" placeholder="(auto-detected)">
        <label>Author</label>
        <input type="text" class="uc-author-input" placeholder="Unknown">
      </div>
      <div class="uc-buttons">
        <button class="uc-capture">Capture this chapter</button>
        <button class="uc-epub">Download EPUB</button>
        <button class="uc-zip">Download ZIP</button>
        <button class="uc-clear">Clear all</button>
      </div>
      <div class="uc-status"></div>
    `;
    root.appendChild(panel);

    panel.querySelector(".uc-capture").addEventListener("click", () => captureCurrent(panel));
    panel.querySelector(".uc-epub").addEventListener("click", () => downloadEpub(panel));
    panel.querySelector(".uc-zip").addEventListener("click", () => downloadZip(panel));
    panel.querySelector(".uc-clear").addEventListener("click", () => clearStore(panel));

    // Prefill title with the detected novel name; persist author across loads.
    const titleInput = panel.querySelector(".uc-title-input");
    titleInput.value = loadStore().name || novelName();
    const authorInput = panel.querySelector(".uc-author-input");
    authorInput.value = GM_getValue("utoon_capture_author", "");
    authorInput.addEventListener("change", () =>
      GM_setValue("utoon_capture_author", authorInput.value)
    );

    // Persist auto-capture preference
    const autoBox = panel.querySelector(".uc-auto");
    autoBox.checked = GM_getValue("utoon_capture_auto", true);
    autoBox.addEventListener("change", () => GM_setValue("utoon_capture_auto", autoBox.checked));

    // Persist auto-advance preference; unticking cancels a pending jump.
    const advBox = panel.querySelector(".uc-advance");
    advBox.checked = GM_getValue("utoon_capture_advance", false);
    advBox.addEventListener("change", () => {
      GM_setValue("utoon_capture_advance", advBox.checked);
      if (!advBox.checked) cancelAdvance(panel);
    });

    return panel;
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  (async function init() {
    console.debug("[utoon] userscript init. GM_download:", typeof GM_download, "TextEncoder:", typeof TextEncoder);
    const panel = buildPanel();
    refreshPanel(panel);

    const autoCapture = GM_getValue("utoon_capture_auto", true);
    const autoAdvance = GM_getValue("utoon_capture_advance", false);

    let captured = true;
    if (autoCapture) {
      setStatus(panel, "Waiting for content…", "info");
      captured = await captureCurrent(panel);
    }

    // Advance only if we didn't just fail to capture (so a failed load is
    // visible rather than silently skipped).
    if (autoAdvance && captured) {
      scheduleAdvance(panel);
    }
  })();
})();
