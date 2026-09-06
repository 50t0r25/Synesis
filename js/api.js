import { Settings } from "./storage.js";
import { toast } from "./utils.js";

function enabledTools() {
  if (!Settings.data.webSearch) return null;
  try {
    const tools = JSON.parse(Settings.data.tools || "null");
    return Array.isArray(tools) && tools.length ? tools : null;
  } catch {
    toast("Invalid tools JSON — search skipped");
    return null;
  }
}

function apiError(response, text) {
  let detail = "";
  try {
    const data = JSON.parse(text);
    const error = data?.error;
    detail = typeof error === "string" ? error : error?.message || data?.message || "";
  } catch { /* Use raw response text when body is not JSON. */ }
  if (!detail) detail = text.trim().slice(0, 300) || response.statusText || "Request failed";
  return new Error(`${response.status}: ${detail}`);
}

export const API = {
  headers() {
    return { Authorization: `Bearer ${Settings.data.apiKey}`, "Content-Type": "application/json" };
  },
  async fetchModels() {
    const response = await fetch(`${Settings.base()}/models`, { headers: this.headers() });
    if (!response.ok) throw await apiError(response, await response.text());
    const data = await response.json();
    return data.data.map((model) => model.id).sort();
  },
  async fetchProviders(model) {
    const modelPath = model.split("/").map((part) => encodeURIComponent(part)).join("/");
    const response = await fetch(`${Settings.base()}/models/${modelPath}/endpoints`, { headers: this.headers() });
    if (!response.ok) throw await apiError(response, await response.text());
    const data = await response.json();
    return (data.data?.endpoints || [])
      .filter((endpoint) => endpoint.status === 0 && endpoint.tag)
      .sort((a, b) => (a.provider_name || a.tag).localeCompare(b.provider_name || b.tag));
  },
  async *streamChat(messages, signal, reasoningEffort = "none") {
    const body = { model: Settings.data.model, messages, stream: true, reasoning: { effort: reasoningEffort } };
    if (Settings.data.provider) body.provider = { order: [Settings.data.provider], allow_fallbacks: false };
    const tools = enabledTools();
    if (tools) body.tools = tools;
    const response = await fetch(`${Settings.base()}/chat/completions`, {
      method: "POST", headers: this.headers(), signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await apiError(response, await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
        if (!payload) continue;
        if (payload === "[DONE]") return;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (parsed.error) {
          const detail = typeof parsed.error === "string" ? parsed.error : parsed.error.message || JSON.stringify(parsed.error);
          throw new Error(detail);
        }
        const delta = parsed.choices?.[0]?.delta;
        const usage = parsed.usage || null;
        if (!delta && !usage) continue;
        yield {
          content: delta?.content || "",
          reasoning: delta?.reasoning || delta?.reasoning_content || "",
          reasoningDetails: delta?.reasoning_details || [],
          usage,
        };
      }
    }
  },
};
