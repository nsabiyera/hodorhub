/** Public interface of the Messaging bounded context (US-8.3). */
export {
  postMessage,
  getThread,
  listConversationsForProject,
  redactMessagesByAuthor,
  messageSchema,
  NoRelationshipError,
  InvalidCursorError,
  type MessageInput,
  type ConversationSummary,
  type ThreadView,
  type MessageView,
} from './service';
