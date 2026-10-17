const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.DOWNLOAD_DIR = dir;
process.env.DATA_DIR = path.join(dir, 'data');
process.env.COMPUTE = '';
process.env.NODE_TOKEN = 'n'.repeat(48); // set, but this is not a hub

const config = require('../../hub/config');
const pipeline = require('../../hub/pipeline');
const remote = require('../../hub/remote');
const nodeApi = require('../../hub/nodeApi');

test('COMPUTE defaults to local: cut and transcribe run here, as before', () => {
  assert.equal(config.compute, 'local');
  assert.equal(remote.isRemote('cut'), false);
  assert.equal(remote.isRemote('transcribe'), false);
  const s = pipeline.status();
  assert.equal(s.remote, undefined);
  assert.equal(s.heavyLimit, config.heavyConcurrency);
  assert.equal(config.embedUrl, config.whisperUrl, 'search uses the transcriber unless EMBED_URL is set');
});

test('the /node API does not exist in local mode, even with a NODE_TOKEN', async () => {
  assert.equal(nodeApi.enabled(), false);
  const server = nodeApi.createLanApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/node/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.NODE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: 'pc', stages: ['cut'] }),
  });
  assert.equal(res.status, 404);
  server.closeAllConnections();
  server.close();
});

test('an unknown COMPUTE value is refused', () => {
  const { execFileSync } = require('child_process');
  assert.throws(
    () => execFileSync(process.execPath, ['-e', "require('./hub/config')"], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, COMPUTE: 'cloud' }, stdio: 'pipe' }),
    /COMPUTE must be "local" or "remote"/
  );
});
