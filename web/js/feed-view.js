// @ts-check
"use strict";

/**
 * Owns the filterable Live Feed list and category filter chip bar.
 */
export class FeedView {
  /**
   * @param {HTMLElement} listEl
   * @param {HTMLElement} filtersEl
   * @param {number} [maxItems]
   */
  constructor(listEl, filtersEl, maxItems = 60) {
    this.listEl = listEl;
    this.filtersEl = filtersEl;
    this.maxItems = maxItems;
    /** @type {import("./types.js").FeedCategory} */
    this.activeCategory = "all";

    this.filtersEl.addEventListener("click", (ev) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const btn = target?.closest("[data-feed-cat]");
      if (!btn) return;
      const cat = /** @type {import("./types.js").FeedCategory} */ (btn.getAttribute("data-feed-cat") || "all");
      this.setCategory(cat);
    });
  }

  /** @param {import("./types.js").FeedCategory} cat */
  setCategory(cat) {
    this.activeCategory = cat || "all";
    for (const btn of this.filtersEl.querySelectorAll("[data-feed-cat]")) {
      btn.classList.toggle("active", btn.getAttribute("data-feed-cat") === this.activeCategory);
    }
    for (const li of this.listEl.children) {
      const itemCat = li.getAttribute("data-cat") || "general";
      li.classList.toggle("hidden", this.activeCategory !== "all" && itemCat !== this.activeCategory);
    }
  }

  /**
   * @param {string} text
   * @param {import("./types.js").FeedCategory} [category]
   * @param {boolean} [major]
   */
  add(text, category = "general", major = false) {
    const li = document.createElement("li");
    li.dataset.cat = category;
    if (major) li.classList.add("major");
    if (this.activeCategory !== "all" && category !== this.activeCategory) {
      li.classList.add("hidden");
    }
    const msgSpan = document.createElement("span");
    msgSpan.textContent = text;
    const tsSpan = document.createElement("span");
    tsSpan.className = "ts";
    tsSpan.textContent = new Date().toLocaleTimeString();
    li.append(msgSpan, tsSpan);
    this.listEl.prepend(li);
    while (this.listEl.children.length > this.maxItems && this.listEl.lastChild) {
      this.listEl.lastChild.remove();
    }
  }

  clear() {
    this.listEl.replaceChildren();
  }
}

/**
 * Owns non-intrusive toast notifications for sprint & challenge milestones.
 */
export class ToastView {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.containerEl = containerEl;
  }

  /**
   * @param {string} title
   * @param {string} body
   * @param {number} [durationMs]
   */
  show(title, body, durationMs = 4500) {
    const el = document.createElement("div");
    el.className = "toast";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.textContent = body;
    el.append(strong, span);
    this.containerEl.append(el);
    window.setTimeout(() => {
      el.remove();
    }, durationMs);
  }
}
