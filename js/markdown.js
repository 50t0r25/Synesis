import { esc } from "./utils.js";

function codeBlock({ text, lang }) {
  const language = (lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
  const label = language || "code";
  return `<div class="code-block"><div class="code-head"><span>${esc(label)}</span><button type="button" data-copy-code>Copy</button></div><pre><code data-language="${esc(language)}">${esc(text.replace(/\n$/, ""))}</code></pre></div>`;
}

export const MD = {
  render(source) {
    const markdown = String(source).replace(/\r\n?/g, "\n").replace(/^\s*--\s*$/gm, "---");
    if (!window.marked || !window.DOMPurify) return `<p>${esc(markdown).replace(/\n/g, "<br>")}</p>`;
    const renderer = new window.marked.Renderer();
    renderer.code = codeBlock;
    const html = window.marked.parse(markdown, { gfm: true, breaks: false, renderer });
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ["data-copy-code", "data-language"] });
  },
};
