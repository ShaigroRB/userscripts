// ==UserScript==
// @name         Allow use of left & right key on qimanwha.com
// @namespace    http://tampermonkey.net/
// @version      2025-07-10
// @description  try to take over the world!
// @author       You
// @match        https://qimanhwa.com/series/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=tampermonkey.net
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // Your code here...
  document.addEventListener("keydown", (evt) => {
    if (evt.code === "ArrowRight") {
      document.querySelector('button[title="Next chapter"]').click();
    }
    if (evt.code === "ArrowLeft") {
      document.querySelector('button[title="Previous chapter"]').click();
    }
  });
})();
