// lib/remote-auth.js — 一个远端 MCP 端点，是不是必须带令牌。
//
// 这条信息只有端点自己知道，而且它会明说：保护起来的 MCP 端点对不带 Authorization
// 的请求回 `401` 并附上 `WWW-Authenticate: Bearer error="invalid_token",
// resource_metadata="…"`（RFC 9728 的受保护资源元数据）。Smithery 托管的那些
// 服务器就是这样——`https://brave.run.tools` 与
// `https://server.smithery.ai/brave/mcp` 都回同一段话。
//
// 探针只做一件事：问一次，把答案读出来。读不出来（超时、5xx、4xx 但不是 401）就
// 返回 null——「不知道」必须能和「不需要」区分开，否则每一台远端服务器都会凭空
// 多出一个必填框。

/** The initialize request every MCP server must answer. Nothing is sent after it. */
const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-overall-mcp/probe', version: '0' },
  },
};

/**
 * Read one `WWW-Authenticate` challenge (RFC 7235) into named parts.
 *
 * @returns `{ scheme, params }`; `params` keeps only `key="value"` pairs.
 */
export function challengeOf(header) {
  const text = typeof header === 'string' ? header.trim() : '';
  if (text === '') return null;
  const space = text.search(/\s/);
  const scheme = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const params = {};
  const rest = space === -1 ? '' : text.slice(space + 1);
  for (const match of rest.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g)) {
    params[match[1].toLowerCase()] = match[2];
  }
  return { scheme, params };
}

/**
 * Turn one HTTP response into a demand, or into "cannot tell".
 *
 * @param status - the HTTP status the endpoint answered.
 * @param header - its `WWW-Authenticate` value, when it sent one.
 * @returns `{ status, required, scheme?, description?, resource?, raw? }`.
 */
export function authDemandOf(status, header) {
  const code = Number(status);
  if (Number.isFinite(code) && code >= 200 && code < 300) return { status: code, required: false };
  if (code !== 401) return { status: Number.isFinite(code) ? code : null, required: null };
  const challenge = challengeOf(header);
  const bearer = challenge?.scheme === 'bearer';
  return {
    status: 401,
    // A `401` without a `Bearer` challenge is still a `401`: something is gated.
    required: true,
    ...(challenge ? { scheme: challenge.scheme } : {}),
    ...(challenge?.params?.error_description ? { description: challenge.params.error_description } : {}),
    ...(challenge?.params?.resource_metadata ? { resource: challenge.params.resource_metadata } : {}),
    ...(bearer ? {} : { raw: true }),
  };
}

/**
 * Ask one remote endpoint whether it wants a token.
 *
 * @param url - the streamable-http endpoint.
 * @param options - `{ timeoutMs, fetchImpl }`.
 * @returns the demand (see `authDemandOf`), or `null` when the probe could not
 *   reach the endpoint — 「不知道」, never 「不需要」.
 */
export async function probeRemoteAuth(url, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    // Drain the body: an unread stream keeps the socket open, and a catalogue
    // install must not leak one connection per click.
    try { await res.text(); } catch { /* body already gone */ }
    return authDemandOf(res.status, res.headers?.get?.('www-authenticate'));
  } catch {
    return null;
  }
}
