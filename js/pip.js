// @ts-check
"use strict";

import { formatCompact } from "./constants.js";

/**
 * Manages the always-on-top Document Picture-in-Picture mini overlay using DOM APIs
 * and an external stylesheet (pip.css) instead of inline HTML template strings.
 */
export class PipOverlay {
  /** @param {string} cssHref */
  constructor(cssHref) {
    this.cssHref = cssHref;
    /** @type {Window | null} */
    this.win = null;
    this.els = {
      /** @type {HTMLElement | null} */ map: null,
      /** @type {HTMLElement | null} */ state: null,
      /** @type {HTMLElement | null} */ xph: null,
      /** @type {HTMLElement | null} */ pct: null,
      /** @type {HTMLElement | null} */ eta: null,
    };
  }

  /** @param {() => void} onOpened */
  async toggle(onOpened) {
    if (this.win && !this.win.closed) {
      this.win.close();
      this.win = null;
      return;
    }

    let win = null;
    if ("documentPictureInPicture" in window) {
      try {
        // @ts-ignore
        win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 145 });
      } catch {
        win = null;
      }
    }
    if (!win) {
      win = window.open("", "MapleSprintMini", "width=340,height=160,menubar=no,toolbar=no,location=no,status=no");
    }
    if (!win) return;

    this.win = win;
    const d = win.document;
    d.title = "MapleSprint Mini";
    d.head.replaceChildren();
    d.body.replaceChildren();

    const link = d.createElement("link");
    link.rel = "stylesheet";
    link.href = this.cssHref;
    d.head.appendChild(link);

    const makeEl = (tag, cls, text = "") => {
      const node = d.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    };

    const top = makeEl("div", "top");
    this.els.map = makeEl("span", "", "MapleSprint Mini");
    this.els.state = makeEl("span", "pill paused", "PAUSED");
    top.append(this.els.map, this.els.state);

    const row = makeEl("div", "row");
    const mXph = makeEl("div", "metric");
    this.els.xph = makeEl("div", "val", "0");
    mXph.append(makeEl("div", "lbl", "EXP / HR"), this.els.xph);

    const mPct = makeEl("div", "metric");
    const pctLbl = makeEl("div", "lbl", "LV PROGRESS · ");
    this.els.eta = makeEl("span", "", "ETA —");
    pctLbl.appendChild(this.els.eta);
    this.els.pct = makeEl("div", "val gold", "0.00%");
    mPct.append(pctLbl, this.els.pct);

    row.append(mXph, mPct);
    d.body.append(top, row);
    onOpened();
  }

  update({ xphVal, rolling5m, level, pct, etaText, isGrinding, mapName }) {
    if (!this.win || this.win.closed) return;
    if (this.els.xph) this.els.xph.textContent = `${formatCompact(xphVal)}/h (5m: ${formatCompact(rolling5m)})`;
    if (this.els.pct) this.els.pct.textContent = `Lv.${level} · ${pct.toFixed(2)}%`;
    if (this.els.eta) this.els.eta.textContent = etaText;
    if (this.els.state) {
      this.els.state.textContent = isGrinding ? "ACTIVE" : "PAUSED";
      this.els.state.className = `pill ${isGrinding ? "active" : "paused"}`;
    }
    if (this.els.map && mapName) {
      this.els.map.textContent = mapName;
    }
  }
}
