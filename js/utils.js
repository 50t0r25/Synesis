export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];
export const uid = () => crypto.randomUUID();
export const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const isMobile = () => matchMedia("(max-width: 768px)").matches;

let toastTimer;
export function toast(message, type = "", duration = type === "error" ? 4200 : 2600) {
  const element = $("#toast");
  element.textContent = message;
  element.className = type ? `show ${type}` : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = ""; }, duration);
}
