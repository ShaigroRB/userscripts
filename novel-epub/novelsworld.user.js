// ==UserScript==
// @name         Novelsworld Chapter Capture → EPUB
// @namespace    https://github.com/local/novelsworld-epub
// @version      1.0
// @description  Capture the prose of novelsworld.org chapters as you read them, then export a ZIP or EPUB for offline reading.
// @match        https://novelsworld.org/novel/*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Scoping to <article> is required: a bare ".max-w-none" also matches
  // comment bodies elsewhere on the page (they share Tailwind's .prose class).
  const PROSE_SELECTOR = "article div.max-w-none";

  // -----------------------------------------------------------------------
  // Identify the current novel + chapter
  // -----------------------------------------------------------------------

  function novelSlug() {
    // URL: https://novelsworld.org/novel/<slug>/chapter-N-<title-slug>
    const m = location.pathname.match(/\/novel\/([^/]+)\//);
    return m ? m[1] : "unknown-novel";
  }

  function novelName() {
    // The novel-title <h1> is the one nested inside the breadcrumb link back
    // to /novel/<slug> — the page has a second <h1> for the chapter heading
    // itself, so this distinguishes them reliably.
    const h1 = document.querySelector('a[href*="/novel/"] h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();

    // Fallback: document.title is "Chapter N: Title - Novel Name | Novel Worlds"
    let name = document.title.replace(/\s*\|\s*Novel Worlds\s*$/i, "").trim();
    const dashParts = name.split(/\s+-\s+/);
    if (dashParts.length > 1) name = dashParts[dashParts.length - 1];
    return name || novelSlug();
  }

  function currentChapterNum() {
    // The URL slug's title portion is inconsistent (sometimes just the number,
    // sometimes the full chapter title), so parse the chapter number that
    // always immediately follows "chapter-".
    const m = location.pathname.match(/chapter-(\d+)-/i);
    if (m) return parseInt(m[1], 10);

    // Fallback: the visible "Ch. N: Title" label near the top of the chapter.
    const label = document.body.textContent.match(/\bCh\.\s*(\d+)\s*:/i);
    return label ? parseInt(label[1], 10) : null;
  }

  // Per-novel storage key
  function storeKey() {
    return `novelsworld_capture::${novelSlug()}`;
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
  // Wait for prose to load. novelsworld.org shows a ~0.5s loading-skeleton
  // state (title/content/nav all show loaders) before the real chapter
  // content mounts, so we poll rather than assume it's there immediately.
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
        setTimeout(check, 300);
      };
      check();
    });
  }

  // -----------------------------------------------------------------------
  // Capture
  // -----------------------------------------------------------------------

  // Clean the captured fragment before storing it:
  //  - <br> tags are redundant here (paragraphs already separate lines) and
  //    just add noise / risk of double line breaks when rendered.
  //  - Inline `style` attributes come from the site's own reading-settings
  //    (color, font, line-height, etc. — see the site's reader theming) and
  //    would otherwise override our own epub/reader styling.
  // Operates on a clone so the live page is never touched.
  function cleanCapturedElement(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.remove());
    clone
      .querySelectorAll("[style]")
      .forEach((node) => node.removeAttribute("style"));
    return clone.innerHTML;
  }

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
    store.chapters[num] = cleanCapturedElement(el);
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
    // The Next/Prev controls are icon-only buttons; their accessible label
    // lives in a visually-hidden <span class="sr-only"> child, e.g.
    // <a href="..."><svg/><span class="sr-only">Next chapter</span></a>
    for (const a of document.querySelectorAll('a[href*="/chapter-"]')) {
      if (/next chapter/i.test(a.textContent) && a.href !== location.href) {
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
    setStatus(
      panel,
      `Auto-advancing in ${(delayMs / 1000).toFixed(0)}s…`,
      "info",
    );
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      console.debug(
        "[novelsworld] auto-advance: clicking next link ->",
        next.href,
      );
      next.click();
    }, delayMs);
  }

  // -----------------------------------------------------------------------
  // SPA navigation detection
  // -----------------------------------------------------------------------
  // novelsworld.org is a Next.js app: clicking "Next chapter" (or pressing the
  // arrow-key shortcut the site binds) navigates via the History API without
  // a full page reload. A userscript's @match only runs once per real page
  // load, so without this, capture/advance would only ever fire for the
  // first chapter you land on. Patching pushState/replaceState plus
  // listening for popstate lets us re-run our per-chapter logic on every
  // client-side route change too.

  function installNavigationWatcher(onNavigate) {
    const patch = (fnName) => {
      const orig = history[fnName];
      history[fnName] = function (...args) {
        const ret = orig.apply(this, args);
        window.dispatchEvent(new Event("novelsworld-capture:locationchange"));
        return ret;
      };
    };
    patch("pushState");
    patch("replaceState");
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("novelsworld-capture:locationchange")),
    );

    let debounceTimer = null;
    window.addEventListener("novelsworld-capture:locationchange", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onNavigate, 50);
    });
  }

  // -----------------------------------------------------------------------
  // Per-chapter handler: runs on the initial load AND on every subsequent
  // SPA navigation, so auto-capture and auto-advance keep working chapter
  // after chapter.
  // -----------------------------------------------------------------------

  let lastHandledKey = null;

  async function handleChapterLoad(panel) {
    const key = location.pathname + location.search;
    if (key === lastHandledKey) {
      console.debug(
        "[novelsworld] handleChapterLoad: already handled",
        key,
        "- skipping",
      );
      return;
    }
    lastHandledKey = key;
    console.debug(
      "[novelsworld] handleChapterLoad: new chapter detected ->",
      key,
    );

    // A pending advance from a previous chapter (e.g. the user navigated
    // manually while it was ticking down) is no longer relevant.
    cancelAdvance(panel);
    refreshPanel(panel);

    const autoCapture = GM_getValue("novelsworld_capture_auto", true);
    const autoAdvance = GM_getValue("novelsworld_capture_advance", false);

    let ready = true;

    if (autoCapture) {
      setStatus(panel, "Waiting for content…", "info");
      ready = await captureCurrent(panel);
    } else if (autoAdvance) {
      // Auto-advance without auto-capture still needs to wait for the page
      // (and its next-chapter link) to finish loading before we can advance.
      setStatus(panel, "Waiting for content…", "info");
      const el = await waitForProse();
      ready = !!el;
      if (!ready) setStatus(panel, "Content didn't load.", "err");
      refreshPanel(panel);
    }

    if (autoAdvance && ready) {
      scheduleAdvance(panel);
    }
  }

  // -----------------------------------------------------------------------
  // Export ZIP
  // -----------------------------------------------------------------------

  function triggerDownload(blob, filename) {
    console.debug(
      "[novelsworld] triggerDownload:",
      filename,
      "blob size:",
      blob && blob.size,
    );

    // Preferred path: GM_download (most reliable in userscript managers).
    if (typeof GM_download === "function") {
      try {
        const url = URL.createObjectURL(blob);
        GM_download({
          url,
          name: filename,
          onload: () => {
            console.debug("[novelsworld] GM_download onload OK");
            URL.revokeObjectURL(url);
          },
          onerror: (e) => {
            console.error(
              "[novelsworld] GM_download error, falling back to anchor:",
              e,
            );
            URL.revokeObjectURL(url);
            anchorDownload(blob, filename);
          },
        });
        return;
      } catch (e) {
        console.error(
          "[novelsworld] GM_download threw, falling back to anchor:",
          e,
        );
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
      console.debug(
        "[novelsworld] anchorDownload: clicking anchor for",
        filename,
      );
      a.click();
      // Delay cleanup slightly so the browser can start the download.
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      console.error("[novelsworld] anchorDownload failed:", e);
    }
  }

  function sortedChapterNums(store) {
    return Object.keys(store.chapters)
      .map(Number)
      .sort((a, b) => a - b);
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

  // Build a downloadable Blob from {name, text} entries.
  function buildArchiveBlob(textEntries, mimeType) {
    const enc = new TextEncoder();
    const entries = textEntries.map((e) => ({
      name: e.name,
      data: e.data instanceof Uint8Array ? e.data : enc.encode(e.text),
    }));
    console.debug(
      "[novelsworld] buildZipBytes: encoding",
      entries.length,
      "entries...",
    );
    const bytes = buildZipBytes(entries);
    console.debug("[novelsworld] buildZipBytes: done,", bytes.length, "bytes");
    return new Blob([bytes], { type: mimeType });
  }

  function downloadZip(panel) {
    console.debug("[novelsworld] downloadZip clicked");
    const store = loadStore();
    const nums = sortedChapterNums(store);
    console.debug("[novelsworld] captured chapters:", nums);

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
        ...nums.map((num) => ({
          name: `chapter_${num}.html`,
          text: store.chapters[num],
        })),
      ];
      const blob = buildArchiveBlob(entries, "application/zip");
      console.debug("[novelsworld] zip blob ready, size:", blob.size);
      triggerDownload(blob, `${novelSlug()}.zip`);

      setStatus(
        panel,
        `Exported ${nums.length} chapters (${metadata.first}\u2013${metadata.last}).`,
        "ok",
      );
    } catch (e) {
      console.error("[novelsworld] downloadZip failed:", e);
      setStatus(panel, "ZIP export failed (see console).", "err");
    }
  }

  // -----------------------------------------------------------------------
  // Export EPUB
  // -----------------------------------------------------------------------

  const EPUB_CSS = [
    // "body { font-family: Georgia, serif; line-height: 1.7; margin: 1em 2em; color: #1a1a1a; }",
    "h1, h2, h3 { font-family: sans-serif; margin-top: 2em; color: #111; }",
    // "p { margin: 0.4em 0; text-indent: 1.2em; }",
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
      "text/html",
    );
    const wrap = doc.getElementById("uc-wrap");

    // Title: first <p>/<hN> matching "Chapter N"
    let title = `Chapter ${num}`;
    const re = new RegExp(`\\bchapter\\s*${num}\\b`, "i");
    for (const tag of wrap.querySelectorAll("p, h1, h2, h3")) {
      let t = (tag.textContent || "").trim();
      if (re.test(t)) {
        // novelsworld stores a literal markdown "#" heading marker in the
        // text rather than rendering an actual <hN> — strip it for display.
        t = t.replace(/^#+\s*/, "");
        title = t;
        break;
      }
    }

    // Strip stray non-prose tags
    wrap
      .querySelectorAll("input, script, style, button, iframe")
      .forEach((n) => n.remove());

    // Defensive cleanup for chapters captured before this cleaning was added
    // to captureCurrent — new captures are already clean, this is a no-op
    // for them. Strips redundant <br> (paragraphs already separate lines)
    // and leftover inline styles from the site's reading-settings theming.
    wrap.querySelectorAll("br").forEach((br) => br.remove());
    wrap
      .querySelectorAll("[style]")
      .forEach((node) => node.removeAttribute("style"));

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
      null,
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
        `    <item id="${id}" href="${c.file}" media-type="application/xhtml+xml"/>`,
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
      .map(
        (c) => `        <li><a href="${c.file}">${xmlEscape(c.title)}</a></li>`,
      )
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
          `    </navPoint>`,
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
    console.debug("[novelsworld] downloadEpub clicked");
    const store = loadStore();
    const nums = sortedChapterNums(store);
    console.debug("[novelsworld] captured chapters:", nums);

    if (nums.length === 0) {
      setStatus(panel, "Nothing captured yet.", "err");
      return;
    }

    try {
      const title = (
        panel.querySelector(".uc-title-input").value ||
        store.name ||
        "Novel"
      ).trim();
      const author = (
        panel.querySelector(".uc-author-input").value || "Unknown"
      ).trim();
      const uid = `urn:uuid:novelsworld-${novelSlug()}-${nums[0]}-${nums[nums.length - 1]}`;

      const chapters = nums.map((num, i) => {
        const { title: chTitle, xhtmlBody } = buildChapterXhtmlBody(
          store.chapters[num],
          num,
        );
        return {
          file: `chapter_${String(i + 1).padStart(4, "0")}.xhtml`,
          title: chTitle,
          xhtml: chapterXhtml(chTitle, xhtmlBody),
        };
      });
      console.debug("[novelsworld] built", chapters.length, "chapter docs");

      // Order matters: mimetype MUST be first. All entries are stored.
      const entries = [
        { name: "mimetype", text: "application/epub+zip" },
        { name: "META-INF/container.xml", text: containerXml() },
        { name: "OEBPS/style.css", text: EPUB_CSS },
        {
          name: "OEBPS/content.opf",
          text: contentOpf(title, author, uid, chapters),
        },
        { name: "OEBPS/nav.xhtml", text: navXhtml(title, chapters) },
        { name: "OEBPS/toc.ncx", text: tocNcx(title, uid, chapters) },
        ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, text: c.xhtml })),
      ];

      const blob = buildArchiveBlob(entries, "application/epub+zip");
      console.debug("[novelsworld] epub blob ready, size:", blob.size);
      triggerDownload(blob, `${novelSlug()}.epub`);

      setStatus(
        panel,
        `Built epub: ${chapters.length} chapters (${nums[0]}\u2013${nums[nums.length - 1]}).`,
        "ok",
      );
    } catch (e) {
      console.error("[novelsworld] downloadEpub failed:", e);
      setStatus(panel, "EPUB export failed (see console).", "err");
    }
  }

  function clearCurrentChapter(panel) {
    const num = currentChapterNum();
    if (num === null) {
      setStatus(panel, "Could not determine chapter number.", "err");
      return;
    }

    const store = loadStore();
    if (!(num in store.chapters)) {
      setStatus(panel, `Chapter ${num} wasn't captured.`, "info");
      return;
    }

    delete store.chapters[num];
    saveStore(store);
    refreshPanel(panel);
    setStatus(panel, `Cleared chapter ${num}.`, "ok");
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
    status.style.color =
      kind === "err" ? "#c0392b" : kind === "ok" ? "#27ae60" : "#555";
  }

  function refreshPanel(panel) {
    const store = loadStore();
    const nums = Object.keys(store.chapters)
      .map(Number)
      .sort((a, b) => a - b);
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
    host.id = "novelsworld-capture-host";
    host.style.cssText =
      "all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;";
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
      <div class="uc-title">novelsworld → epub capture</div>
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
        <button class="uc-clear-current">Clear this chapter</button>
        <button class="uc-epub">Download EPUB</button>
        <button class="uc-zip">Download ZIP</button>
        <button class="uc-clear">Clear all</button>
      </div>
      <div class="uc-status"></div>
    `;
    root.appendChild(panel);

    panel
      .querySelector(".uc-capture")
      .addEventListener("click", () => captureCurrent(panel));
    panel
      .querySelector(".uc-clear-current")
      .addEventListener("click", () => clearCurrentChapter(panel));
    panel
      .querySelector(".uc-epub")
      .addEventListener("click", () => downloadEpub(panel));
    panel
      .querySelector(".uc-zip")
      .addEventListener("click", () => downloadZip(panel));
    panel
      .querySelector(".uc-clear")
      .addEventListener("click", () => clearStore(panel));

    // Prefill title with the detected novel name; persist author across loads.
    const titleInput = panel.querySelector(".uc-title-input");
    titleInput.value = loadStore().name || novelName();
    const authorInput = panel.querySelector(".uc-author-input");
    authorInput.value = GM_getValue("novelsworld_capture_author", "");
    authorInput.addEventListener("change", () =>
      GM_setValue("novelsworld_capture_author", authorInput.value),
    );

    // Persist auto-capture preference
    const autoBox = panel.querySelector(".uc-auto");
    autoBox.checked = GM_getValue("novelsworld_capture_auto", true);
    autoBox.addEventListener("change", () =>
      GM_setValue("novelsworld_capture_auto", autoBox.checked),
    );

    // Persist auto-advance preference; unticking cancels a pending jump.
    const advBox = panel.querySelector(".uc-advance");
    advBox.checked = GM_getValue("novelsworld_capture_advance", false);
    advBox.addEventListener("change", () => {
      GM_setValue("novelsworld_capture_advance", advBox.checked);
      if (!advBox.checked) cancelAdvance(panel);
    });

    return panel;
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  (async function init() {
    console.debug(
      "[novelsworld] userscript init. GM_download:",
      typeof GM_download,
      "TextEncoder:",
      typeof TextEncoder,
    );
    const panel = buildPanel();
    refreshPanel(panel);

    installNavigationWatcher(() => handleChapterLoad(panel));
    await handleChapterLoad(panel);
  })();
})();
