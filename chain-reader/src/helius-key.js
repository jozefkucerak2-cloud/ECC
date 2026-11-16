'use strict';

const RPC_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const HELIUS_HOSTS = new Set(['mainnet.helius-rpc.com', 'beta.helius-rpc.com']);

function parseHeliusKey(value) {
  let text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\s+/g, '');
  if (!text) {
    return '';
  }
  if (text.includes('://') || text.startsWith('//')) {
    return keyFromUrl(text);
  }
  const embedded = text.match(/(?:api-key=)([A-Za-z0-9_-]{8,64})/i);
  if (embedded) {
    return embedded[1];
  }
  if (!RPC_KEY.test(text)) {
    throw badKey();
  }
  return text;
}

function keyFromUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badKey();
  }
  if (url.protocol !== 'https:' || !HELIUS_HOSTS.has(url.hostname)) {
    throw badKey();
  }
  const key = url.searchParams.get('api-key') || '';
  if (!RPC_KEY.test(key)) {
    throw badKey();
  }
  return key;
}

function badKey() {
  const error = new Error('Kľúč má zlý tvar. Súkromný kľúč peňaženky sa neprijíma.');
  error.statusCode = 400;
  return error;
}

module.exports = {
  HELIUS_HOSTS,
  RPC_KEY,
  parseHeliusKey,
};
