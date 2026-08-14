export const DB = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      const request = indexedDB.open("synesis", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("conversations", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this._db;
  },
  transaction(mode, callback) {
    return this.open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction("conversations", mode);
      const result = callback(transaction.objectStore("conversations"));
      transaction.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
      transaction.onerror = () => reject(transaction.error);
    }));
  },
  put: (conversation) => DB.transaction("readwrite", (store) => store.put(conversation)),
  del: (id) => DB.transaction("readwrite", (store) => store.delete(id)),
  clear: () => DB.transaction("readwrite", (store) => store.clear()),
  all: () => DB.transaction("readonly", (store) => store.getAll()).then((result) => result || []),
};

export const DEFAULT_TOOLS = '[{"type":"openrouter:web_search"}]';

export const Settings = {
  key: "synesis.settings",
  data: { baseUrl: "", apiKey: "", model: "", provider: "", systemPrompt: "", reasoningEffort: "none", preserveReasoning: false, webSearch: false, tools: DEFAULT_TOOLS },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(this.key)) || {}); } catch { /* Ignore malformed local settings. */ }
  },
  save() { localStorage.setItem(this.key, JSON.stringify(this.data)); },
  base() { return (this.data.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, ""); },
};
