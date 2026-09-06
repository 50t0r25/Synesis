import { API } from "./api.js";
import { MD } from "./markdown.js";
import { State } from "./state.js";
import { DB, Settings, DEFAULT_TOOLS } from "./storage.js";
import { $, $$, esc, isMobile, toast } from "./utils.js";

const input = $("#input");
const sendButton = $("#sendBtn");
let menuConversationId = null;
let providerRequestId = 0;

function conversationIdFromURL() {
  return new URLSearchParams(location.search).get("chat");
}

function updateConversationURL(id, replace = false) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("chat", id);
  else url.searchParams.delete("chat");
  history[replace ? "replaceState" : "pushState"](null, "", url);
}

function openConversation(id, replace = false) {
  State.activeId = id;
  updateConversationURL(id, replace);
  renderSidebar();
  renderMessages();
}

function highlightCode(root = document) {
  if (!window.hljs) return;
  root.querySelectorAll("pre code:not(.hljs)").forEach((code) => {
    const language = code.dataset.language;
    const result =
      language && window.hljs.getLanguage(language)
        ? window.hljs.highlight(code.textContent, { language })
        : window.hljs.highlightAuto(code.textContent);
    code.innerHTML = result.value;
    code.classList.add("hljs");
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
}

function visibleReasoning(message) {
  if (message.reasoning) return message.reasoning;
  return (message.reasoningDetails || [])
    .map((detail) => detail.text || detail.summary || "")
    .filter(Boolean)
    .join("\n\n");
}

function formatCost(cost) {
  if (cost == null || Number.isNaN(Number(cost))) return "";
  const n = Number(cost);
  if (n > 0 && n < 0.0001) return "$>0.0001";
  return `$${n.toFixed(4)}`;
}

function apiErrorMessage(error) {
  const message = String(error?.message || "Unknown API error").trim();
  return /failed to fetch|networkerror|load failed/i.test(message)
    ? "Could not reach the API endpoint"
    : message;
}

function statsText(usage) {
  if (!usage) return "";
  const parts = [];
  if (usage.prompt_tokens != null) parts.push(`${usage.prompt_tokens} in`);
  if (usage.completion_tokens != null)
    parts.push(`${usage.completion_tokens} out`);
  const costVal =
    usage.cost ?? usage.cost_details?.upstream_inference_cost ?? null;
  const cost = formatCost(costVal);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

function assistantHTML(message) {
  const reasoning = visibleReasoning(message);
  const thinking = reasoning
    ? `<details class="reasoning"><summary>Reasoning</summary><div class="reasoning-body">${MD.render(reasoning)}</div></details>`
    : "";
  return thinking + MD.render(message.content);
}

function updateAssistantBubble(bubble, message) {
  const wasOpen = bubble.querySelector(".reasoning")?.open;
  bubble.innerHTML = assistantHTML(message);
  if (wasOpen && bubble.querySelector(".reasoning"))
    bubble.querySelector(".reasoning").open = true;
  highlightCode(bubble);
}

function appendReasoningDetails(target, chunks) {
  for (const chunk of chunks) {
    const existing =
      target.find(
        (detail) =>
          chunk.index !== undefined &&
          detail.index === chunk.index &&
          detail.type === chunk.type,
      ) ||
      target.find(
        (detail) =>
          chunk.id && detail.id === chunk.id && detail.type === chunk.type,
      ) ||
      (chunk.index === undefined &&
      !chunk.id &&
      target.at(-1)?.type === chunk.type &&
      target.at(-1)?.format === chunk.format
        ? target.at(-1)
        : null);
    if (!existing) {
      target.push({ ...chunk });
      continue;
    }
    for (const [key, value] of Object.entries(chunk)) {
      if (
        ["text", "summary", "data"].includes(key) &&
        typeof value === "string"
      )
        existing[key] = (existing[key] || "") + value;
      else if (value !== null && value !== undefined) existing[key] = value;
    }
  }
}

function renderHeader() {
  const conversation = State.active();
  $("#convTitle").textContent = conversation?.title || "New chat";
  const model = Settings.data.model || "";
  $("#modelBadge").textContent = model ? model.split("/").pop() : "no model";
  $("#modelBadge").title = model;
}

function renderSidebar() {
  const list = $("#convList");
  list.innerHTML = State.conversations.length
    ? '<div class="conv-label">Chats</div>'
    : "";
  for (const conversation of State.conversations) {
    const element = document.createElement("div");
    element.className = `conv${conversation.id === State.activeId ? " active" : ""}`;
    element.dataset.id = conversation.id;
    element.innerHTML = `<span class="title">${esc(conversation.title)}</span><button class="icon-btn dots" title="Options" aria-label="Conversation options">⋯</button>`;
    element.addEventListener("click", (event) => {
      if (event.target.closest(".dots"))
        return openConversationMenu(event, conversation.id);
      openConversation(conversation.id);
      closeSidebarMobile();
    });
    list.appendChild(element);
  }
}

function openConversationMenu(event, id) {
  event.stopPropagation();
  menuConversationId = id;
  const menu = $("#menu");
  const rect = event.target.closest(".dots").getBoundingClientRect();
  menu.style.display = "block";
  menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - 100)}px`;
  menu.style.left = `${Math.min(rect.left, innerWidth - 150)}px`;
}

function messageElement(message, index) {
  const element = document.createElement("div");
  element.className = `msg ${message.role}`;
  element.dataset.index = index;
  const stats = message.role === "assistant" ? statsText(message.usage) : "";
  element.innerHTML = `<div class="bubble">${message.role === "assistant" ? assistantHTML(message) : esc(message.content)}</div><div class="message-footer"><div class="message-actions" aria-label="Message actions"><button type="button" data-message-action="retry">Retry</button><button type="button" data-message-action="edit">Edit</button><button type="button" data-message-action="copy">Copy</button><button type="button" data-message-action="delete">Delete</button></div>${stats ? `<span class="message-stats">${esc(stats)}</span>` : ""}</div>`;
  return element;
}

function renderMessages() {
  const conversation = State.active();
  const welcome = !conversation || !conversation.messages.length;
  const main = $("#main");
  const composer = $("#composerBar");
  const transition =
    main.classList.contains("welcome") !== welcome
      ? composer.getBoundingClientRect()
      : null;
  main.classList.toggle("welcome", welcome);
  renderHeader();
  const box = $("#messages");
  box.innerHTML = "";
  if (welcome) {
    box.innerHTML =
      '<div class="empty"><div class="empty-mark">S</div><div class="empty-copy"><h2>A quieter way to chat</h2><p>Your keys, your endpoint, your data.<br>Start a new conversation when you are ready.</p></div></div>';
    return;
  }
  conversation.messages.forEach((message, index) =>
    box.appendChild(messageElement(message, index)),
  );
  highlightCode(box);
  scrollBottom(true);
  if (transition) {
    const next = composer.getBoundingClientRect();
    composer.animate(
      [
        {
          transform: `translate(${transition.left - next.left}px, ${transition.top - next.top}px)`,
        },
        { transform: "translate(0, 0)" },
      ],
      { duration: 360, easing: "cubic-bezier(.2, .75, .25, 1)" },
    );
  }
}

function scrollBottom(force = false) {
  const scroll = $("#chatScroll");
  if (
    force ||
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120
  )
    scroll.scrollTop = scroll.scrollHeight;
}

function closeSidebarMobile() {
  if (isMobile()) document.body.classList.remove("sidebar-open");
}
function setStreaming(streaming) {
  State.streaming = streaming;
  sendButton.textContent = streaming ? "■" : "↑";
  sendButton.classList.toggle("stop", streaming);
  sendButton.setAttribute(
    "aria-label",
    streaming ? "Stop response" : "Send message",
  );
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || State.streaming) return;
  if (!Settings.data.apiKey) {
    toast("Add your API key in Settings first");
    openSettings("api");
    return;
  }
  if (!Settings.data.model) {
    toast("Pick a model in Settings first");
    openSettings("model");
    return;
  }

  const isNewConversation = !State.active();
  const conversation = State.active() || State.newConversation();
  if (isNewConversation) updateConversationURL(conversation.id);
  conversation.messages.push({ role: "user", content: text });
  if (conversation.title === "New chat")
    conversation.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");
  input.value = "";
  input.style.height = "auto";
  await generateAssistant(conversation);
}

async function generateAssistant(conversation) {
  const assistant = {
    role: "assistant",
    content: "",
    reasoning: "",
    reasoningDetails: [],
  };
  conversation.messages.push(assistant);
  renderSidebar();
  renderMessages();
  const bubble = $("#messages").lastElementChild.querySelector(".bubble");
  bubble.classList.add("typing");
  setStreaming(true);
  State.abort = new AbortController();
  let usageStats = null;
  try {
    const history = [];
    if (Settings.data.systemPrompt.trim())
      history.push({
        role: "system",
        content: Settings.data.systemPrompt.trim(),
      });
    history.push(
      ...conversation.messages.slice(0, -1).map((message) => {
        const item = { role: message.role, content: message.content };
        if (Settings.data.preserveReasoning && message.role === "assistant") {
          if (message.reasoningDetails?.length)
            item.reasoning_details = message.reasoningDetails;
          else if (message.reasoning) item.reasoning = message.reasoning;
        }
        return item;
      }),
    );
    for await (const delta of API.streamChat(
      history,
      State.abort.signal,
      Settings.data.reasoningEffort,
    )) {
      if (delta.usage) usageStats = delta.usage;
      assistant.content += delta.content;
      assistant.reasoning += delta.reasoning;
      appendReasoningDetails(
        assistant.reasoningDetails,
        delta.reasoningDetails,
      );
      updateAssistantBubble(bubble, assistant);
      scrollBottom();
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      const index = conversation.messages.indexOf(assistant);
      if (index !== -1) conversation.messages.splice(index, 1);
      toast(apiErrorMessage(error), "error");
    }
  } finally {
    if (usageStats) assistant.usage = usageStats;
    bubble.classList.remove("typing");
    setStreaming(false);
    State.abort = null;
    renderMessages();
    conversation.updatedAt = Date.now();
    State.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    await DB.put(conversation);
    renderSidebar();
  }
}

async function retryMessage(index) {
  if (State.streaming) {
    toast("Stop the current response before retrying");
    return;
  }
  if (!Settings.data.apiKey) {
    toast("Add your API key in Settings first");
    openSettings("api");
    return;
  }
  if (!Settings.data.model) {
    toast("Pick a model in Settings first");
    openSettings("model");
    return;
  }
  const conversation = State.active();
  const message = conversation?.messages[index];
  if (!conversation || !message) return;
  if (
    index < conversation.messages.length - 1 &&
    !confirm("Retry from here? Messages after this point will be removed.")
  )
    return;
  conversation.messages = conversation.messages.slice(
    0,
    message.role === "user" ? index + 1 : index,
  );
  if (
    !conversation.messages.length ||
    conversation.messages.at(-1).role !== "user"
  ) {
    toast("There is no user message to retry");
    return;
  }
  await generateAssistant(conversation);
}

function editMessage(index) {
  if (State.streaming) {
    toast("Stop the current response before editing");
    return;
  }
  const conversation = State.active();
  const message = conversation?.messages[index];
  const bubble = document.querySelector(`.msg[data-index="${index}"] .bubble`);
  if (!conversation || !message || !bubble) return;
  bubble.classList.add("editing");
  bubble.innerHTML = "";
  const editor = document.createElement("textarea");
  editor.className = "message-editor";
  editor.value = message.content;
  editor.rows = 3;
  const controls = document.createElement("div");
  controls.className = "edit-actions";
  controls.innerHTML =
    '<button type="button" data-edit-save>Save</button><button type="button" data-edit-cancel>Cancel</button>';
  bubble.append(editor, controls);
  const save = async () => {
    const content = editor.value.trim();
    if (!content) {
      toast("A message cannot be empty");
      return;
    }
    message.content = content;
    if (message.role === "assistant") {
      message.reasoning = "";
      message.reasoningDetails = [];
      message.usage = undefined;
    }
    conversation.updatedAt = Date.now();
    await DB.put(conversation);
    renderMessages();
  };
  controls.querySelector("[data-edit-save]").addEventListener("click", save);
  controls
    .querySelector("[data-edit-cancel]")
    .addEventListener("click", renderMessages);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") renderMessages();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  });
  editor.addEventListener("input", () => {
    editor.style.height = "auto";
    editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 90), 300)}px`;
  });
  editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 90), 300)}px`;
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

function openSettings(tab) {
  syncSettingsUI();
  if (tab) switchTab(tab);
  if (Settings.data.model) fetchProvidersIntoUI();
  document.body.classList.add("settings-open");
}
function closeSettings() {
  document.body.classList.remove("settings-open");
  Settings.save();
  renderHeader();
}
function switchTab(name) {
  $$(".set-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.tab === name),
  );
  $$(".set-panel").forEach((panel) =>
    panel.classList.toggle("active", panel.dataset.panel === name),
  );
}
function renderWebSearchToggle() {
  const active = Boolean(Settings.data.webSearch);
  $("#webSearchToggle").classList.toggle("active", active);
  $("#webSearchToggle").setAttribute("aria-pressed", String(active));
}

function syncSettingsUI() {
  $("#setBaseUrl").value = Settings.data.baseUrl;
  $("#setApiKey").value = Settings.data.apiKey;
  $("#setSystemPrompt").value = Settings.data.systemPrompt;
  $("#reasoningEffort").value = Settings.data.reasoningEffort || "none";
  $("#setPreserveReasoning").checked = Boolean(Settings.data.preserveReasoning);
  $("#setTools").value = Settings.data.tools;
  renderWebSearchToggle();
  const select = $("#setModel");
  if (
    Settings.data.model &&
    ![...select.options].some((option) => option.value === Settings.data.model)
  )
    select.innerHTML = `<option value="${esc(Settings.data.model)}">${esc(Settings.data.model)}</option>`;
  select.value = Settings.data.model;
  renderProviderOptions([]);
  $("#setProvider").value = Settings.data.provider || "";
  $("#setProvider").disabled = !Settings.data.model;
}

function renderProviderOptions(providers) {
  const select = $("#setProvider");
  select.innerHTML =
    '<option value="">Auto</option>' +
    providers
      .map((provider) => {
        const name = provider.provider_name || provider.tag;
        return `<option value="${esc(provider.tag)}">${esc(name)} · ${esc(provider.tag)}</option>`;
      })
      .join("");
  select.value = Settings.data.provider || "";
}

async function fetchProvidersIntoUI() {
  const select = $("#setProvider");
  const status = $("#providerStatus");
  const requestId = ++providerRequestId;
  if (!Settings.data.model) {
    renderProviderOptions([]);
    select.disabled = true;
    status.className = "status";
    status.textContent = "Select a model first.";
    return;
  }
  if (!Settings.data.apiKey) {
    renderProviderOptions([]);
    select.disabled = true;
    status.className = "status err";
    status.textContent = "Enter an API key first.";
    return;
  }
  select.disabled = true;
  status.className = "status";
  status.textContent = "Fetching providers…";
  try {
    const providers = await API.fetchProviders(Settings.data.model);
    if (requestId !== providerRequestId) return;
    renderProviderOptions(providers);
    if (
      Settings.data.provider &&
      !providers.some((provider) => provider.tag === Settings.data.provider)
    ) {
      Settings.data.provider = "";
      Settings.save();
    }
    select.value = Settings.data.provider || "";
    select.disabled = false;
    status.className = "status ok";
    status.textContent = `${providers.length} healthy provider${providers.length === 1 ? "" : "s"} available`;
  } catch (error) {
    if (requestId !== providerRequestId) return;
    renderProviderOptions([]);
    Settings.data.provider = "";
    Settings.save();
    select.disabled = false;
    status.className = "status err";
    status.textContent = `Failed: ${error.message}`;
  }
}

async function fetchModelsIntoUI() {
  const status = $("#modelStatus");
  const select = $("#setModel");
  if (!Settings.data.apiKey) {
    status.className = "status err";
    status.textContent = "Enter an API key first.";
    return;
  }
  status.className = "status";
  status.textContent = "Fetching models…";
  try {
    const models = await API.fetchModels();
    select.innerHTML = models
      .map((model) => `<option value="${esc(model)}">${esc(model)}</option>`)
      .join("");
    if (Settings.data.model && models.includes(Settings.data.model))
      select.value = Settings.data.model;
    else {
      Settings.data.model = models[0] || "";
      select.value = Settings.data.model;
      Settings.save();
    }
    status.className = "status ok";
    status.textContent = `${models.length} models available`;
    renderHeader();
    await fetchProvidersIntoUI();
  } catch (error) {
    status.className = "status err";
    status.textContent = `Failed: ${error.message}`;
  }
}

$("#messages").addEventListener("click", async (event) => {
  const codeButton = event.target.closest("[data-copy-code]");
  if (codeButton) {
    const code = codeButton
      .closest(".code-block")
      ?.querySelector("code")?.textContent;
    if (code === undefined) return;
    await copyText(code);
    codeButton.textContent = "Copied";
    setTimeout(() => {
      if (codeButton.isConnected) codeButton.textContent = "Copy";
    }, 1400);
    return;
  }

  const actionButton = event.target.closest("[data-message-action]");
  if (!actionButton) return;
  const index = Number(actionButton.closest(".msg")?.dataset.index);
  const conversation = State.active();
  const message = conversation?.messages[index];
  if (!conversation || !message) return;
  const action = actionButton.dataset.messageAction;
  if (action === "retry") await retryMessage(index);
  if (action === "edit") editMessage(index);
  if (action === "copy") {
    await copyText(message.content);
    toast("Message copied");
  }
  if (action === "delete") {
    if (State.streaming) {
      toast("Stop the current response before deleting");
      return;
    }
    const later = conversation.messages.length - index - 1;
    if (
      later > 0 &&
      !confirm(
        `Delete this message? The ${later} message${later === 1 ? "" : "s"} after it will also be removed.`,
      )
    )
      return;
    conversation.messages = conversation.messages.slice(0, index);
    conversation.updatedAt = Date.now();
    await DB.put(conversation);
    renderMessages();
    toast(
      later > 0
        ? `Message and ${later} later message${later === 1 ? "" : "s"} deleted`
        : "Message deleted",
    );
  }
});

$("#menu").addEventListener("click", async (event) => {
  const conversation = State.conversations.find(
    (item) => item.id === menuConversationId,
  );
  const action = event.target.dataset.action;
  if (!conversation || !action) return;
  $("#menu").style.display = "none";
  if (action === "delete") {
    if (!confirm(`Delete "${conversation.title}"?`)) return;
    const nextId =
      State.activeId === conversation.id
        ? (State.conversations.find((item) => item.id !== conversation.id)
            ?.id ?? null)
        : State.activeId;
    State.conversations = State.conversations.filter(
      (item) => item.id !== conversation.id,
    );
    await DB.del(conversation.id);
    openConversation(nextId, true);
  }
  if (action === "rename") {
    const title = document.querySelector(
      `.conv[data-id="${conversation.id}"] .title`,
    );
    const renameInput = document.createElement("input");
    renameInput.className = "rename";
    renameInput.value = conversation.title;
    title.replaceWith(renameInput);
    renameInput.focus();
    renameInput.select();
    const commit = async () => {
      conversation.title = renameInput.value.trim() || conversation.title;
      await DB.put(conversation);
      renderSidebar();
      renderHeader();
    };
    renameInput.addEventListener("blur", commit, { once: true });
    renameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") renameInput.blur();
      if (event.key === "Escape") renderSidebar();
    });
    renameInput.addEventListener("click", (event) => event.stopPropagation());
  }
});
document.addEventListener("click", () => {
  $("#menu").style.display = "none";
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
$("#webSearchToggle").addEventListener("click", () => {
  Settings.data.webSearch = !Settings.data.webSearch;
  Settings.save();
  renderWebSearchToggle();
  toast(Settings.data.webSearch ? "Web search on" : "Web search off");
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !isMobile()) {
    event.preventDefault();
    sendMessage();
  }
});
sendButton.addEventListener("click", () =>
  State.streaming ? State.abort?.abort() : sendMessage(),
);
$("#menuBtn").addEventListener("click", () =>
  isMobile()
    ? document.body.classList.toggle("sidebar-open")
    : document.body.classList.toggle("sidebar-collapsed"),
);
$("#collapseBtn").addEventListener("click", () =>
  isMobile()
    ? document.body.classList.remove("sidebar-open")
    : document.body.classList.add("sidebar-collapsed"),
);
$("#sideBackdrop").addEventListener("click", () =>
  document.body.classList.remove("sidebar-open"),
);
$("#newChat").addEventListener("click", () => {
  openConversation(null);
  closeSidebarMobile();
  input.focus();
});
$$(".set-tab").forEach((tab) =>
  tab.addEventListener("click", () => switchTab(tab.dataset.tab)),
);
$("#openSettings").addEventListener("click", () => {
  openSettings();
  closeSidebarMobile();
});
$("#closeSettings").addEventListener("click", closeSettings);
$("#settingsBackdrop").addEventListener("click", closeSettings);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettings();
    $("#menu").style.display = "none";
  }
});
$("#setBaseUrl").addEventListener("input", (event) => {
  Settings.data.baseUrl = event.target.value.trim();
  Settings.save();
});
$("#setApiKey").addEventListener("input", (event) => {
  Settings.data.apiKey = event.target.value.trim();
  Settings.save();
});
$("#setModel").addEventListener("change", async (event) => {
  Settings.data.model = event.target.value;
  Settings.data.provider = "";
  Settings.save();
  renderHeader();
  await fetchProvidersIntoUI();
});
$("#setProvider").addEventListener("change", (event) => {
  Settings.data.provider = event.target.value;
  Settings.save();
});
$("#setSystemPrompt").addEventListener("input", (event) => {
  Settings.data.systemPrompt = event.target.value;
  Settings.save();
});
$("#setTools").addEventListener("input", (event) => {
  Settings.data.tools = event.target.value;
  Settings.save();
});
$("#resetTools").addEventListener("click", (event) => {
  event.preventDefault();
  Settings.data.tools = DEFAULT_TOOLS;
  Settings.save();
  $("#setTools").value = DEFAULT_TOOLS;
  toast("Tools reset to default");
});
$("#reasoningEffort").addEventListener("change", (event) => {
  Settings.data.reasoningEffort = event.target.value;
  Settings.save();
});
$("#setPreserveReasoning").addEventListener("change", (event) => {
  Settings.data.preserveReasoning = event.target.checked;
  Settings.save();
});
$("#toggleKey").addEventListener("click", () => {
  const key = $("#setApiKey");
  const visible = key.type === "password";
  key.type = visible ? "text" : "password";
  $("#toggleKey").textContent = visible ? "Hide" : "Show";
});
$("#fetchModels").addEventListener("click", fetchModelsIntoUI);
$("#exportBtn").addEventListener("click", async () => {
  const payload = {
    app: "synesis",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: Settings.data,
    conversations: await DB.all(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `synesis-backup-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Exported");
});
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.conversations))
      throw new Error("Invalid backup file");
    await DB.clear();
    for (const conversation of data.conversations) await DB.put(conversation);
    if (data.settings) {
      Object.assign(Settings.data, data.settings);
      Settings.save();
      syncSettingsUI();
    }
    State.conversations = data.conversations.sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    State.activeId = State.conversations[0]?.id ?? null;
    renderSidebar();
    renderMessages();
    toast(`Imported ${data.conversations.length} chats`);
  } catch (error) {
    toast(`Import failed: ${error.message}`);
  }
  event.target.value = "";
});
$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm("Delete all conversations? This cannot be undone.")) return;
  await DB.clear();
  State.conversations = [];
  openConversation(null, true);
  toast("All conversations deleted");
});

(async function init() {
  Settings.load();
  $("#reasoningEffort").value = Settings.data.reasoningEffort || "none";
  renderWebSearchToggle();
  State.conversations = (await DB.all()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const requestedId = conversationIdFromURL();
  State.activeId = State.conversations.some(
    (conversation) => conversation.id === requestedId,
  )
    ? requestedId
    : null;
  if (requestedId && !State.activeId) updateConversationURL(null, true);
  renderSidebar();
  renderMessages();
  if (!Settings.data.apiKey) setTimeout(() => openSettings("api"), 400);
})();

window.addEventListener("popstate", () => {
  const id = conversationIdFromURL();
  State.activeId = State.conversations.some(
    (conversation) => conversation.id === id,
  )
    ? id
    : null;
  renderSidebar();
  renderMessages();
});

window.addEventListener("load", () => highlightCode());
