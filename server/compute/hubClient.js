/**
 * The compute node's line to the hub's node API (hub/nodeApi.js) on the LAN:
 * every request carries NODE_TOKEN and this node's id.
 */

class HubUnreachable extends Error {} // no answer from the hub at all (down, or the link is)

/** The hub's node API at `url`. */
function createHub({ url, token, nodeId }) {
  const auth = { authorization: `Bearer ${token}`, 'x-node-id': nodeId };
  return {
    auth,
    url: (pathname) => url + pathname,
    /** fetch(), with any failure to get an answer turned into HubUnreachable. */
    async request(method, pathname, { json, body, headers = {}, timeoutMs = 60000 } = {}) {
      try {
        return await fetch(url + pathname, {
          method,
          headers: { ...auth, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
          body: json ? JSON.stringify(json) : body,
          duplex: 'half', // lets an upload stream from the file
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new HubUnreachable(`hub not reachable at ${url} (${err.cause ? err.cause.code || err.cause.message : err.message})`);
      }
    },
  };
}

module.exports = { createHub, HubUnreachable };
