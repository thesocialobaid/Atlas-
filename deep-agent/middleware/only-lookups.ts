// Rules about lookups, enforced here rather than asked for in the prompt.
//
// Only the analysis lookups are offered. The runtime also gives every Deep
// Agent a planner, a scratch filesystem and sub-agents; none of them looks
// anything up, so a call to one would show in the chat as a step while
// proving nothing.
//
// Every answer starts with a lookup. When the newest message is the person's,
// the model must call a tool before it may write anything, so no answer, not
// even a refusal, arrives with nothing looked up behind it.
//
// Earlier turns reach the model as what was asked and what was answered, not
// the lookups in between. Replaying an old turn's function calls makes Gemini
// answer a follow-up's lookup with an empty reply, every time; and an old
// lookup's result is the one thing the model shouldn't lean on, since a
// follow-up is looked up again. The answers still name what "that" meant.
//
// An empty reply is asked for again, once. A second one is left for the app to
// report rather than retried forever.

import { AIMessage, createMiddleware, HumanMessage, type BaseMessage } from "langchain";

import { graphTools } from "../tools/graph";

const allowed = new Set<string>(graphTools.map((t) => t.name));

/** Every turn before the newest question, cut to its question and its answer. */
function earlierTurnsAsText(messages: BaseMessage[]): BaseMessage[] {
  let current = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) {
      current = i;
      break;
    }
  }
  if (current <= 0) return messages;
  const earlier = messages.slice(0, current).flatMap((m): BaseMessage[] => {
    if (HumanMessage.isInstance(m)) return [m];
    if (AIMessage.isInstance(m) && (m.tool_calls ?? []).length === 0 && m.text.trim() !== "") {
      return [new AIMessage(m.text)];
    }
    return [];
  });
  return [...earlier, ...messages.slice(current)];
}

export const onlyLookups = createMiddleware({
  name: "OnlyLookups",
  wrapModelCall: async (request, handler) => {
    const last = request.messages[request.messages.length - 1];
    const call = () =>
      handler({
        ...request,
        messages: earlierTurnsAsText(request.messages),
        tools: request.tools.filter((t) => typeof t.name === "string" && allowed.has(t.name)),
        // Gemini's way of saying "call one of these": a function-name allowlist
        // puts it in ANY mode. LangChain's portable `toolChoice: "required"`
        // reaches Gemini as a function called "required" and is refused.
        ...(HumanMessage.isInstance(last)
          ? { modelSettings: { ...request.modelSettings, allowedFunctionNames: [...allowed] } }
          : {}),
      });
    const reply = await call();
    const empty = AIMessage.isInstance(reply) && (reply.tool_calls ?? []).length === 0 && reply.text.trim() === "";
    return empty ? call() : reply;
  },
});
