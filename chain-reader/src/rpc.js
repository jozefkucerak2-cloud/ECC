'use strict';

const ALLOWED_METHODS = new Set([
  'getHealth',
  'getSlot',
  'getSignaturesForAddress',
  'getTransaction',
]);

class RpcError extends Error {
  constructor(message, category, details = {}) {
    super(message);
    this.name = 'RpcError';
    this.category = category;
    this.details = details;
  }
}

function createRpcClient(config, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new RpcError('fetch is not available', 'alert');
  }

  return {
    async call(method, params = []) {
      if (!ALLOWED_METHODS.has(method)) {
        throw new RpcError(`method ${method} is not allowed`, 'alert', { method });
      }
      return callWithRetry(config, fetchImpl, method, params);
    },
  };
}

async function callWithRetry(config, fetchImpl, method, params) {
  let attempt = 0;
  let lastError;
  while (attempt <= config.maxRetries) {
    try {
      return await callOnce(config, fetchImpl, method, params);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RpcError) || error.category !== 'retry' || attempt === config.maxRetries) {
        throw error;
      }
      const delay = config.retryBaseMs * (2 ** attempt);
      await sleep(delay);
      attempt += 1;
    }
  }
  throw lastError;
}

async function callOnce(config, fetchImpl, method, params) {
  let response;
  try {
    response = await fetchImpl(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new RpcError(`rpc transport failed: ${redact(error.message)}`, 'retry', { method });
  }

  if (response.status === 429 || response.status >= 500) {
    throw new RpcError(`rpc http ${response.status}`, 'retry', { method, status: response.status });
  }
  if (!response.ok) {
    throw new RpcError(`rpc http ${response.status}`, 'alert', { method, status: response.status });
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new RpcError('rpc response was not json', 'alert', { method });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RpcError('rpc response was not an object', 'alert', { method });
  }
  if (body.error) {
    const code = body.error.code;
    const category = code === 429 ? 'retry' : 'alert';
    throw new RpcError(redact(body.error.message || 'rpc error'), category, { method, code });
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
    throw new RpcError('rpc response missing result', 'alert', { method });
  }
  return body.result;
}

function redact(value) {
  return String(value).replace(/api-key=[^&\s'"]+/gi, 'api-key=redacted');
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  ALLOWED_METHODS,
  RpcError,
  createRpcClient,
  redact,
};
