// ==UserScript==
// @name         Allow use of left & right key on asurascans
// @namespace    http://tampermonkey.net/
// @version      2025-07-10
// @description  try to take over the world!
// @author       You
// @match        https://asuracomic.net/series/*/chapter/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tampermonkey.net
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  const nodes = document.querySelector(
    ".flex.items-center.gap-x-3.flex-row.w-full",
  ).childNodes;

  // Your code here...
  document.addEventListener("keydown", (evt) => {
    if (evt.code === "ArrowRight") {
      nodes[1].click();
    }
    if (evt.code === "ArrowLeft") {
      nodes[0].click();
    }
  });
})();
