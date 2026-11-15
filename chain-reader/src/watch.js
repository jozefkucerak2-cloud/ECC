'use strict';

const path = require('node:path');

const { loadConfig } = require('./config');
const { createHeliusPool, watchPool } = require('./helius');

function main(env = process.env) {
  const config = loadConfig(env);
  const pool = createHeliusPool(env, {
    usagePath: env.HELIUS_USAGE_PATH || path.join(__dirname, '..', 'data', 'helius-usage.json'),
    signatureLimit: config.signatureLimit,
    minCleanSample: config.minCleanSample,
    timeoutMs: config.timeoutMs,
    programId: config.programId,
  });
  return watchPool(pool, {
    onResult(result) {
      process.stdout.write(`${JSON.stringify({
        fetchedSignatures: result.fetchedSignatures,
        skipped: result.skipped,
        sample: result.sample,
        walletCount: result.wallets.length,
        usage: result.usage,
      })}\n`);
    },
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
