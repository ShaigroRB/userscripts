// ==UserScript==
// @name         Allow use of left & right key on roliascans
// @namespace    http://tampermonkey.net/
// @version      2025-07-10
// @description  try to take over the world!
// @author       You
// @match        https://roliascan.com/manga/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tampermonkey.net
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Your code here...
  document.addEventListener("keydown", (evt) => {
    if (evt.code === "ArrowRight") {
      document.querySelector("a.chapter-nav-right").click();
    }
    if (evt.code === "ArrowLeft") {
      document.querySelector("a.chapter-nav-left").click();
    }
  });
})();
