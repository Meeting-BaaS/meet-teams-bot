/**
 * Single source of truth for the Zoom Web chat DOM selectors.
 *
 * Both the chat reader (ZoomChatObserver) and the end-of-meeting denial scanner
 * (zoom-state-config) need to know where chat content lives. Keeping them in one
 * place means the denial scanner's ignore-list can never drift from what the
 * observer actually reads — the exact gap that let the bot's own entry message
 * ("…can be removed from the meeting…") escape the ignore-list and kill the bot
 * ~200ms after joining (2026-08 Noota incident, bots c97b775f / ee8053f9).
 *
 * The observer must pass these into page.evaluate as ARGS (Playwright
 * serializes them into the page context); the denial scanner imports them
 * directly on the Node side.
 */

export const CHAT_CONTAINER_SELECTORS = [
  '[aria-label="Chat Message List"]',
  ".chat-virtuoso-wrapper",
  "#chat-list-content",
  ".chat-list-content",
  ".chat-container__chat-list",
  '[class*="chat-list"]',
  '[class*="chat-message-list"]'
] as const

export const CHAT_MESSAGE_SELECTORS = [
  '[id^="chat-message-"]',
  ".new-chat-message__container",
  '[class*="chat-message-item"]',
  '[class*="chatMessage"]',
  "div[data-index]"
] as const

/**
 * Chat-scoped forms of the generic virtualized-row selector, used only by the
 * denial ignore-list. The bare `div[data-index]` also matches participants
 * lists and other virtualized panels anywhere in the Zoom DOM — using it in
 * the ignore-list would create denial blind spots outside chat.
 */
const CHAT_SCOPED_MESSAGE_SELECTORS = [
  ".chat-virtuoso-wrapper div[data-index]",
  ".chat-container__chat-list div[data-index]",
  ".chat-list-content div[data-index]"
] as const

/**
 * Every subtree whose text must NEVER be treated as a meeting-end/denial signal.
 * Union of the chat containers/message items the observer reads, plus the
 * top-level chat panel roots and the compose editor.
 */
export const CHAT_IGNORE_SELECTORS: readonly string[] = [
  ...CHAT_CONTAINER_SELECTORS,
  ...CHAT_MESSAGE_SELECTORS.filter((s) => s !== "div[data-index]"),
  ...CHAT_SCOPED_MESSAGE_SELECTORS,
  "#chat",
  ".chat-container",
  ".chat-rtf-box__editor-outer",
  '[class*="new-chat"]'
]