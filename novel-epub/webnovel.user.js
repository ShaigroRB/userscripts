// ==UserScript==
// @name         Webnovel Chapter Capture → EPUB
// @namespace    https://github.com/local/webnovel-epub
// @version      1.0
// @description  Capture webnovel.com chapters as they load into the reader (including ones appended by ←/→ navigation), then export an EPUB or a ZIP.
// @match        https://www.webnovel.com/book/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // How long auto-advance waits after capturing a chapter before pressing →.
  const ADVANCE_DELAY_MS = 1500;

  // The reader keeps every chapter it has loaded in the page: each one is a
  // `.chapter_content[data-cid]` block inside `.j_contentWrap`, and pressing
  // → appends the next one after a short delay. So rather than "capture the
  // current chapter", we capture every chapter block present and watch the
  // DOM for new ones.
  const CHAPTER_SELECTOR = ".chapter_content[data-cid]";
  const PARAGRAPH_SELECTOR = ".cha-words .cha-paragraph p";

  // -----------------------------------------------------------------------
  // Identify the current novel
  // -----------------------------------------------------------------------

  // URL: /book/<slug>_<bookId>/<chapter-slug>_<chapterId>
  function bookMatch() {
    return location.pathname.match(/\/book\/([^/]+?)_(\d+)(?:\/|$)/);
  }

  function bookId() {
    const m = bookMatch();
    return m ? m[2] : "unknown";
  }

  function novelSlug() {
    const m = bookMatch();
    return m ? m[1] : "unknown-novel";
  }

  function novelName() {
    // Several reader buttons carry the clean book name.
    const el = document.querySelector("[data-bookname]");
    if (el && el.dataset.bookname) return el.dataset.bookname.trim();
    const og = document.querySelector('meta[property="og:title"]');
    let name = og ? og.content : document.title;
    // "<Chapter> - <Book> - Webnovel"-ish titles: keep it simple, drop the site suffix.
    name = name.replace(/\s*[-–—|]\s*webnovel.*$/i, "").trim();
    return name || novelSlug().replace(/-/g, " ");
  }

  // Per-novel storage key (book id is stable even if the slug changes)
  function storeKey() {
    return `webnovel_capture::${bookId()}`;
  }

  // store = { name, seq, chapters: { [cid]: { num, seq, title, html } } }
  function loadStore() {
    const raw = GM_getValue(storeKey(), null);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    return { name: novelName(), seq: 0, chapters: {} };
  }

  function saveStore(store) {
    GM_setValue(storeKey(), JSON.stringify(store));
  }

  // Chapters sorted by their "Chapter N" number, falling back to capture order.
  function sortedChapters(store) {
    return Object.values(store.chapters).sort((a, b) => {
      if (a.num !== null && b.num !== null && a.num !== b.num) return a.num - b.num;
      return a.seq - b.seq;
    });
  }

  function chapterLabel(c) {
    return c.num !== null ? String(c.num) : `#${c.seq}`;
  }

  // -----------------------------------------------------------------------
  // Read a chapter block
  // -----------------------------------------------------------------------

  function parseChapterNum(title) {
    const m = (title || "").match(/chapter\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function chapterTitle(el) {
    // data-chaptername is clean ("Chapter 10: Leave It to Me"), whereas the
    // <h1> often doubles the prefix ("Chapter 10: Chapter 10: Leave It to Me").
    let t = (el.dataset.chaptername || "").trim();
    if (!t) {
      const h1 = el.querySelector(".cha-tit h1");
      t = h1 ? h1.textContent.trim() : "";
    }
    return t.replace(/^(chapter\s*\d+\s*:\s*)\1/i, "$1") || "Untitled chapter";
  }

  function isLocked(el) {
    return el.dataset.islock === "1";
  }

  // Returns { cid, title, num, html } or null if there's no prose yet.
  function readChapter(el) {
    const paras = Array.from(el.querySelectorAll(PARAGRAPH_SELECTOR));
    if (paras.length === 0) return null;
    const title = chapterTitle(el);
    const html = paras
      .map((p) => p.innerHTML.trim())
      .filter((s) => s.length > 0)
      .map((s) => `<p>${s}</p>`)
      .join("\n");
    return { cid: el.dataset.cid, title, num: parseChapterNum(title), html };
  }

  // -----------------------------------------------------------------------
  // Capture
  // -----------------------------------------------------------------------

  // Captures every loaded, unlocked chapter on the page that isn't stored yet.
  // Returns { added: [...], locked: [...] }.
  function captureAll() {
    const store = loadStore();
    store.name = store.name || novelName();
    const added = [];
    const locked = [];

    for (const el of document.querySelectorAll(CHAPTER_SELECTOR)) {
      if (isLocked(el)) {
        locked.push(chapterTitle(el));
        continue;
      }
      if (store.chapters[el.dataset.cid]) continue;
      const ch = readChapter(el);
      if (!ch) continue;
      store.seq = (store.seq || 0) + 1;
      store.chapters[ch.cid] = { num: ch.num, seq: store.seq, title: ch.title, html: ch.html };
      added.push(ch);
    }

    if (added.length) saveStore(store);
    return { added, locked };
  }

  // The last chapter block in the DOM, i.e. the furthest one loaded.
  function lastChapterEl() {
    const all = document.querySelectorAll(CHAPTER_SELECTOR);
    return all.length ? all[all.length - 1] : null;
  }

  // -----------------------------------------------------------------------
  // Auto-advance: press → and wait for a new chapter block
  // -----------------------------------------------------------------------

  const NEW_CHAPTER_TIMEOUT_MS = 20000;

  let advanceTimer = null;
  let waitTimer = null;
  let waitingForCid = null; // cid of the last chapter when we pressed →

  function pressRight() {
    // Many sites read e.keyCode / e.which (jQuery), which a synthetic
    // KeyboardEvent leaves at 0 — so pin them on the instance.
    for (const target of [document, document.body]) {
      const ev = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(ev, "keyCode", { get: () => 39 });
      Object.defineProperty(ev, "which", { get: () => 39 });
      target.dispatchEvent(ev);
      if (target === document) break; // body bubbles to document; one is enough
    }
  }

  function cancelAdvance(panel) {
    const wasActive = advanceTimer !== null || waitTimer !== null;
    clearTimeout(advanceTimer);
    clearTimeout(waitTimer);
    advanceTimer = waitTimer = null;
    waitingForCid = null;
    if (panel && wasActive) setStatus(panel, "Auto-advance cancelled.", "info");
  }

  function scheduleAdvance(panel) {
    if (advanceTimer !== null || waitTimer !== null) return;
    const last = lastChapterEl();
    if (!last) return;
    if (isLocked(last)) {
      setStatus(panel, `Stopped: "${chapterTitle(last)}" is locked.`, "err");
      return;
    }

    setStatus(panel, `Auto-advancing in ${(ADVANCE_DELAY_MS / 1000).toFixed(1)}s…`, "info");
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      waitingForCid = last.dataset.cid;
      pressRight();
      setStatus(panel, "Waiting for next chapter…", "info");
      waitTimer = setTimeout(() => {
        waitTimer = null;
        waitingForCid = null;
        setStatus(panel, "No new chapter appeared — reached the end? Auto-advance stopped.", "info");
      }, NEW_CHAPTER_TIMEOUT_MS);
    }, ADVANCE_DELAY_MS);
  }

  // Called after every capture pass. If we were waiting on → and a newer
  // chapter is now the last one, chain the next press.
  function onChaptersChanged(panel) {
    if (!advanceEnabled(panel)) return;
    const last = lastChapterEl();
    if (!last) return;
    if (waitingForCid !== null) {
      if (last.dataset.cid === waitingForCid) return; // still loading
      clearTimeout(waitTimer);
      waitTimer = null;
      waitingForCid = null;
    }
    // Only advance once the furthest chapter has actually been captured
    // (or is locked, which scheduleAdvance reports).
    const store = loadStore();
    if (store.chapters[last.dataset.cid] || isLocked(last)) scheduleAdvance(panel);
  }

  function advanceEnabled(panel) {
    return panel.querySelector(".wc-advance").checked;
  }

  // -----------------------------------------------------------------------
  // Export: downloads
  // -----------------------------------------------------------------------

  function triggerDownload(blob, filename) {
    if (typeof GM_download === "function") {
      try {
        const url = URL.createObjectURL(blob);
        GM_download({
          url,
          name: filename,
          onload: () => URL.revokeObjectURL(url),
          onerror: (e) => {
            console.error("[webnovel] GM_download error, falling back to anchor:", e);
            URL.revokeObjectURL(url);
            anchorDownload(blob, filename);
          },
        });
        return;
      } catch (e) {
        console.error("[webnovel] GM_download threw, falling back to anchor:", e);
      }
    }
    anchorDownload(blob, filename);
  }

  function anchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ---------------------------------------------------------------------
  // Pure-JS store-only ZIP encoder (JSZip's async generation can hang in
  // userscript sandboxes). All entries are STORED, which the epub mimetype
  // entry requires anyway.
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

  // entries: [{ name: string, data: Uint8Array }]
  function buildZipBytes(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const data = e.data;
      const crc = crc32(data);
      const size = data.length;

      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true); // store
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true); // 1980-01-01
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
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + data.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const ch of central) {
      chunks.push(ch);
      cdSize += ch.length;
    }

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
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }

  function buildArchiveBlob(textEntries, mimeType) {
    const enc = new TextEncoder();
    const entries = textEntries.map((e) => ({ name: e.name, data: enc.encode(e.text) }));
    return new Blob([buildZipBytes(entries)], { type: mimeType });
  }

  function exportRange(chapters) {
    return `${chapterLabel(chapters[0])}–${chapterLabel(chapters[chapters.length - 1])}`;
  }

  function downloadZip(panel) {
    const store = loadStore();
    const chapters = sortedChapters(store);
    if (chapters.length === 0) {
      setStatus(panel, "Nothing captured yet.", "err");
      return;
    }
    try {
      const metadata = {
        name: store.name,
        bookId: bookId(),
        chapters: chapters.map((c, i) => ({ file: `chapter_${i + 1}.html`, num: c.num, title: c.title })),
      };
      const entries = [
        { name: "metadata.json", text: JSON.stringify(metadata, null, 2) },
        ...chapters.map((c, i) => ({ name: `chapter_${i + 1}.html`, text: c.html })),
      ];
      triggerDownload(buildArchiveBlob(entries, "application/zip"), `${novelSlug()}.zip`);
      setStatus(panel, `Exported ${chapters.length} chapters (${exportRange(chapters)}).`, "ok");
    } catch (e) {
      console.error("[webnovel] downloadZip failed:", e);
      setStatus(panel, "ZIP export failed (see console).", "err");
    }
  }

  // -----------------------------------------------------------------------
  // Export: EPUB
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

  // Re-serialize captured HTML through an XML document so strict epub
  // readers get well-formed XHTML (entities, void tags, etc.).
  function toXhtmlBody(fragment) {
    const doc = new DOMParser().parseFromString(`<div id="wc-wrap">${fragment}</div>`, "text/html");
    const wrap = doc.getElementById("wc-wrap");
    wrap.querySelectorAll("script, style, button, iframe, input, i.icon").forEach((n) => n.remove());

    const xmlDoc = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "body", null);
    const body = xmlDoc.documentElement;
    for (const node of Array.from(wrap.childNodes)) body.appendChild(xmlDoc.importNode(node, true));
    let inner = new XMLSerializer().serializeToString(body);
    inner = inner.replace(/^<body[^>]*>/, "").replace(/<\/body>$/, "");
    return inner.trim() ? inner : "<p>[No content captured]</p>";
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
      manifestItems.push(`    <item id="${id}" href="${c.file}" media-type="application/xhtml+xml"/>`);
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
    const lis = chapters.map((c) => `        <li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`).join("\n");
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
    const store = loadStore();
    const captured = sortedChapters(store);
    if (captured.length === 0) {
      setStatus(panel, "Nothing captured yet.", "err");
      return;
    }
    try {
      const title = (panel.querySelector(".wc-title-input").value || store.name || "Novel").trim();
      const author = (panel.querySelector(".wc-author-input").value || "Unknown").trim();
      const uid = `urn:uuid:webnovel-${bookId()}-${chapterLabel(captured[0])}-${chapterLabel(captured[captured.length - 1])}`;

      const chapters = captured.map((c, i) => ({
        file: `chapter_${String(i + 1).padStart(4, "0")}.xhtml`,
        title: c.title,
        xhtml: chapterXhtml(c.title, toXhtmlBody(c.html)),
      }));

      // Order matters: mimetype MUST be first.
      const entries = [
        { name: "mimetype", text: "application/epub+zip" },
        { name: "META-INF/container.xml", text: containerXml() },
        { name: "OEBPS/style.css", text: EPUB_CSS },
        { name: "OEBPS/content.opf", text: contentOpf(title, author, uid, chapters) },
        { name: "OEBPS/nav.xhtml", text: navXhtml(title, chapters) },
        { name: "OEBPS/toc.ncx", text: tocNcx(title, uid, chapters) },
        ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, text: c.xhtml })),
      ];

      triggerDownload(buildArchiveBlob(entries, "application/epub+zip"), `${novelSlug()}.epub`);
      setStatus(panel, `Built epub: ${chapters.length} chapters (${exportRange(captured)}).`, "ok");
    } catch (e) {
      console.error("[webnovel] downloadEpub failed:", e);
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
    const status = panel.querySelector(".wc-status");
    status.textContent = msg;
    status.style.color = kind === "err" ? "#c0392b" : kind === "ok" ? "#27ae60" : "#555";
  }

  function refreshPanel(panel) {
    const chapters = sortedChapters(loadStore());
    panel.querySelector(".wc-info").textContent =
      chapters.length === 0 ? "No chapters captured." : `${chapters.length} captured (${exportRange(chapters)})`;
    const last = lastChapterEl();
    panel.querySelector(".wc-current").textContent = `On page: ${
      document.querySelectorAll(CHAPTER_SELECTOR).length
    } chapter(s)${last ? `, last: ${chapterTitle(last)}` : ""}`;
  }

  function buildPanel() {
    // Shadow root so the site's CSS can't reach in.
    const host = document.createElement("div");
    host.id = "webnovel-capture-host";
    host.style.cssText = "all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .wc-panel {
        box-sizing: border-box;
        background: #ffffff;
        border: 1px solid #ccc;
        border-radius: 8px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.18);
        padding: 12px 14px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #222;
        width: 240px;
      }
      .wc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
      .wc-title { font-weight: 600; color: #222; }
      .wc-toggle { cursor: pointer; border: none; background: none; font: inherit; color: #777; padding: 0 2px; }
      .wc-panel.collapsed .wc-body { display: none; }
      .wc-panel.collapsed .wc-head { margin-bottom: 0; }
      .wc-current, .wc-info { color: #555; margin-bottom: 2px; }
      .wc-info { margin-bottom: 8px; }
      .wc-check {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 8px; cursor: pointer; color: #222;
      }
      .wc-fields { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .wc-fields input[type="text"] {
        box-sizing: border-box; width: 100%;
        padding: 5px 6px; font: inherit;
        border: 1px solid #bbb; border-radius: 4px;
        background: #fff; color: #222;
      }
      .wc-fields label { font-size: 11px; color: #777; margin-bottom: -3px; }
      .wc-buttons { display: flex; flex-direction: column; gap: 6px; }
      .wc-buttons button {
        box-sizing: border-box;
        padding: 6px; cursor: pointer;
        background: #f4f4f4; color: #222;
        border: 1px solid #bbb; border-radius: 4px;
        font: inherit;
      }
      .wc-buttons button:hover { background: #e8e8e8; }
      .wc-buttons .wc-clear { color: #c0392b; border-color: #e0b4ae; }
      .wc-status { margin-top: 8px; min-height: 1.2em; color: #555; }
    `;
    root.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "wc-panel";
    panel.innerHTML = `
      <div class="wc-head">
        <div class="wc-title">webnovel → epub</div>
        <button class="wc-toggle" title="Collapse">▾</button>
      </div>
      <div class="wc-body">
        <div class="wc-current"></div>
        <div class="wc-info"></div>
        <label class="wc-check">
          <input type="checkbox" class="wc-auto"> Auto-capture loaded chapters
        </label>
        <label class="wc-check">
          <input type="checkbox" class="wc-advance"> Auto-advance (press →)
        </label>
        <div class="wc-fields">
          <label>Title</label>
          <input type="text" class="wc-title-input" placeholder="(auto-detected)">
          <label>Author</label>
          <input type="text" class="wc-author-input" placeholder="Unknown">
        </div>
        <div class="wc-buttons">
          <button class="wc-capture">Capture loaded chapters</button>
          <button class="wc-epub">Download EPUB</button>
          <button class="wc-zip">Download ZIP</button>
          <button class="wc-clear">Clear all</button>
        </div>
        <div class="wc-status"></div>
      </div>
    `;
    root.appendChild(panel);

    panel.querySelector(".wc-capture").addEventListener("click", () => runCapture(panel, true));
    panel.querySelector(".wc-epub").addEventListener("click", () => downloadEpub(panel));
    panel.querySelector(".wc-zip").addEventListener("click", () => downloadZip(panel));
    panel.querySelector(".wc-clear").addEventListener("click", () => clearStore(panel));

    const toggle = panel.querySelector(".wc-toggle");
    const setCollapsed = (c) => {
      panel.classList.toggle("collapsed", c);
      toggle.textContent = c ? "▸" : "▾";
      GM_setValue("webnovel_capture_collapsed", c);
    };
    setCollapsed(GM_getValue("webnovel_capture_collapsed", false));
    toggle.addEventListener("click", () => setCollapsed(!panel.classList.contains("collapsed")));

    // Title prefilled from the page; author persisted across loads.
    panel.querySelector(".wc-title-input").value = loadStore().name || novelName();
    const authorInput = panel.querySelector(".wc-author-input");
    authorInput.value = GM_getValue(`webnovel_capture_author::${bookId()}`, "");
    authorInput.addEventListener("change", () =>
      GM_setValue(`webnovel_capture_author::${bookId()}`, authorInput.value)
    );

    const autoBox = panel.querySelector(".wc-auto");
    autoBox.checked = GM_getValue("webnovel_capture_auto", true);
    autoBox.addEventListener("change", () => {
      GM_setValue("webnovel_capture_auto", autoBox.checked);
      if (autoBox.checked) runCapture(panel, false);
    });

    // Unticking auto-advance cancels a pending → press; ticking it starts one.
    const advBox = panel.querySelector(".wc-advance");
    advBox.checked = GM_getValue("webnovel_capture_advance", false);
    advBox.addEventListener("change", () => {
      GM_setValue("webnovel_capture_advance", advBox.checked);
      if (advBox.checked) {
        if (!autoBox.checked) {
          autoBox.checked = true;
          GM_setValue("webnovel_capture_auto", true);
        }
        runCapture(panel, false);
      } else {
        cancelAdvance(panel);
      }
    });

    return panel;
  }

  // -----------------------------------------------------------------------
  // Capture loop
  // -----------------------------------------------------------------------

  function runCapture(panel, manual) {
    const { added, locked } = captureAll();
    refreshPanel(panel);
    if (added.length) {
      const names = added.map((c) => (c.num !== null ? c.num : c.title)).join(", ");
      setStatus(panel, `Captured chapter${added.length > 1 ? "s" : ""} ${names}.`, "ok");
    } else if (manual) {
      setStatus(
        panel,
        locked.length ? `Nothing new (locked: ${locked.join(", ")}).` : "Nothing new to capture.",
        locked.length ? "err" : "info"
      );
    }
    onChaptersChanged(panel);
  }

  (function init() {
    const panel = buildPanel();
    refreshPanel(panel);

    const autoOn = () => panel.querySelector(".wc-auto").checked;
    if (autoOn()) runCapture(panel, false);

    // New chapters get appended to the reader with a delay, and their
    // paragraphs may fill in after the block itself appears — debounce a
    // capture pass on any DOM change. (The panel lives in a shadow root, so
    // its own updates don't trigger this.)
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (autoOn()) runCapture(panel, false);
        else refreshPanel(panel);
      }, 400);
    }).observe(document.body, { childList: true, subtree: true });
  })();
})();
