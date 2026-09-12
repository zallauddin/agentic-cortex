export const AC_PROMPTS = {
  extract: {
    system: `Extract durable factual memories from a conversation.`,
    user: `Extract memories from this conversation:\n\n${"{conversation}"}`,
  },
  answer: {
    system: `Answer based ONLY on retrieved context.`,
    user: `Question: ${"{question}"}\n\nContext:\n${"{context}"}`,
  },
}
export default AC_PROMPTS
