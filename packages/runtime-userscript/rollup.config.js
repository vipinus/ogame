import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const banner = `// ==UserScript==
// @name         OgameX Runtime
// @namespace    https://github.com/ddxs/ogamex
// @version      0.0.1
// @match        *://*.ogame.org/*
// @match        *://*.ogame.gameforge.com/*
// @grant        none
// @run-at       document-end
// @connect      127.0.0.1
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
