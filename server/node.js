/**
 * Compute node (runs on the PC, next to the transcriber): pulls cut and
 * transcribe jobs from the hub (COMPUTE=remote on the hub) and runs them.
 * See src/node/agent.js. Needs HUB_URLS and NODE_TOKEN in .env.
 *
 * Stopping it mid-job is safe: the hub puts the job back in the queue once
 * the lease runs out, or as soon as this node claims again.
 */
const config = require('./src/config');
const media = require('./src/media');
const { createAgent } = require('./src/node/agent');

config.ensureDirs();
if (!config.hubUrls.length) {
  console.error('✗ HUB_URLS is empty: set it in .env, e.g. HUB_URLS=http://<mac-lan-ip>:3102');
  process.exit(1);
}
if (config.nodeToken.length < 32) {
  console.error('✗ NODE_TOKEN is unset or shorter than 32 characters: use the same value as on the hub.');
  process.exit(1);
}

const agent = createAgent();
agent.loop();

// Stop child tools (auto-editor, ffmpeg) with us.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`→ ${sig}: stopping.`);
    agent.stop();
    media.killAll();
    process.exit(0);
  });
}
