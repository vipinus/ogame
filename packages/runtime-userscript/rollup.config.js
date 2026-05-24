import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const banner = `// ==UserScript==
// @name         OgameX Runtime
// @namespace    https://github.com/ddxs/ogamex
// @version      0.0.259
// @match        *://*.ogame.org/*
// @match        *://*.ogame.gameforge.com/*
// @match        *://lobby.ogame.gameforge.com/*
// @match        *://gameforge.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// @connect      127.0.0.1
// @connect      192.168.2.100
// @connect      ogame.anyfq.com
// @connect      *
// @updateURL    http://127.0.0.1:8765/ogame-runtime.user.js
// @downloadURL  http://127.0.0.1:8765/ogame-runtime.user.js
// ==/UserScript==
`;

export default {
  input: "src/main.ts",
  output: {
    file: "dist/ogame-runtime.user.js",
    format: "iife",
    banner,
    sourcemap: false,
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({ tsconfig: "./tsconfig.json" }),
  ],
};
