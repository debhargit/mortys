'use strict';
// =============================================================================
//  Scripted stand-in for the Claude API -- DEVELOPMENT TESTS ONLY.
//
//  ai.js loads this only when VISION_DEV=1 and VISION_AI_FAKE=1, so the agent
//  loop, its tools, guardrails and storage can be tested without an API key or
//  any cost. It never runs on the live till.
//
//  A test message drives it with directives:
//    #tool <name> <json input>   -> the "model" calls that tool
//    #refuse                     -> a refusal stop
//    anything else               -> a plain reply echoing the message
//  After a tool result the "model" replies "Done: <first part of the result>".
// =============================================================================
let n = 0;
const id = () => 'toolu_fake_' + (++n) + '_' + Date.now().toString(36);

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const tr = c.find((b) => b.type === 'tool_result');
    if (tr) return { toolResult: tr };
    return { text: c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  }
  return { text: '' };
}

function message(content, stop) {
  return { id: 'msg_fake_' + (++n), type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_details: null,
    usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } };
}

function create(params) {
  if (!params.model || !Array.isArray(params.messages) || !params.messages.length) throw new Error('fake: bad request');
  if (params.messages[0].role !== 'user') throw new Error('fake: first message must be user');
  const last = lastUser(params.messages);
  if (last.toolResult) {
    const body = typeof last.toolResult.content === 'string' ? last.toolResult.content : JSON.stringify(last.toolResult.content);
    return message([{ type: 'text', text: 'Done: ' + body.slice(0, 600) }], 'end_turn');
  }
  const t = String(last.text || '');
  if (/#refuse/.test(t)) return message([], 'refusal');
  const m = /#tool\s+([a-z_]+)\s*(\{[\s\S]*\})?/.exec(t);
  if (m) {
    let input = {};
    try { input = m[2] ? JSON.parse(m[2]) : {}; } catch (_) { input = { bad: true }; }
    return message([{ type: 'text', text: 'One moment.' }, { type: 'tool_use', id: id(), name: m[1], input }], 'tool_use');
  }
  return message([{ type: 'text', text: 'You said: ' + t.slice(0, 300) }], 'end_turn');
}

module.exports = { beta: { messages: { create: async (p) => create(p) } } };
