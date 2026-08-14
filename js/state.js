import { uid } from "./utils.js";

export const State = {
  conversations: [],
  activeId: null,
  streaming: false,
  abort: null,
  active() { return this.conversations.find((conversation) => conversation.id === this.activeId) || null; },
  newConversation() {
    const conversation = { id: uid(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    this.conversations.unshift(conversation);
    this.activeId = conversation.id;
    return conversation;
  },
};
