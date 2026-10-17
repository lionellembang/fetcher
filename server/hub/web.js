/**
 * Web: the frontend. Dashboard, player, search, file streaming and MCP on
 * HOST:PORT (the Cloudflare tunnel points here). Reads the database directly;
 * scans, retries and SharePoint links go to the worker (src/control.js), so
 * this process can be restarted at any time without interrupting work.
 */
const config = require('./config');
const { startServer } = require('./server');

config.ensureDirs();
if (!config.accessToken || config.accessToken === 'change-me') {
  console.warn('⚠ ACCESS_TOKEN is unset/default — set a strong value in .env.');
}
startServer();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
