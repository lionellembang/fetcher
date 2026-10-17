const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.DOWNLOAD_DIR = dir;
process.env.DATA_DIR = path.join(dir, 'data');
const { httpDownload, NotServedError } = require('../../hub/recordings');

const FILE = crypto.randomBytes(3 * 1024 * 1024);
// Stand-in for a Playwright page: a user agent and (no) cookies.
const page = { evaluate: async () => 'test-agent', context: () => ({ cookies: async () => [{ name: 'FedAuth', value: 'x' }] }) };

/** Local server; `behave(req, res, n)` handles the n-th request (1-based). */
function serve(behave) {
  let n = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range, cookie: req.headers.cookie });
    behave(req, res, ++n);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function sendRange(req, res) {
  const m = /bytes=(\d+)-/.exec(req.headers.range || '');
  const from = m ? Number(m[1]) : 0;
  res.writeHead(m ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': FILE.length - from });
  res.end(FILE.subarray(from));
}

const fast = { retryBaseMs: 10 };
const readBack = (rel) => fs.readFileSync(path.join(dir, rel));

test('resumes with Range after the connection drops mid-transfer', async () => {
  const { server, seen, base } = await serve((req, res, n) => {
    if (n === 1) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length });
      res.write(FILE.subarray(0, 1024 * 1024), () => res.socket.destroy()); // break off at 1 MB
      return;
    }
    sendRange(req, res);
  });
  const size = await httpDownload(page, [`${base}/file.mp4`], 'a/one.mp4', FILE.length, fast);
  server.close();
  assert.equal(size, FILE.length);
  assert.ok(readBack('a/one.mp4').equals(FILE));
  // resumes from what reached the disk (some of the 1 MB may still have been in flight)
  const from = Number(/^bytes=(\d+)-$/.exec(seen[1].range)[1]);
  assert.ok(from > 0 && from <= 1024 * 1024, seen[1].range);
  assert.equal(seen[0].cookie, 'FedAuth=x');
  assert.ok(!fs.existsSync(path.join(dir, 'a/one.mp4.part')));
});

test('a short transfer with no error is resumed too (size check)', async () => {
  const { server, base } = await serve((req, res, n) => {
    if (n === 1) {
      res.writeHead(200, { 'content-type': 'video/mp4' }); // no length: ends "cleanly" but short
      res.end(FILE.subarray(0, 500000));
      return;
    }
    sendRange(req, res);
  });
  await httpDownload(page, [`${base}/file.mp4`], 'a/two.mp4', FILE.length, fast);
  server.close();
  assert.ok(readBack('a/two.mp4').equals(FILE));
});

test('restarts from zero when the server ignores Range', async () => {
  const { server, base } = await serve((req, res, n) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length });
    if (n === 1) return res.write(FILE.subarray(0, 700000), () => res.socket.destroy());
    res.end(FILE); // full file, Range ignored
  });
  await httpDownload(page, [`${base}/file.mp4`], 'a/three.mp4', FILE.length, fast);
  server.close();
  assert.ok(readBack('a/three.mp4').equals(FILE));
});

test('falls through refused URLs to one that serves the file', async () => {
  const { server, seen, base } = await serve((req, res) => {
    if (req.url === '/denied') return res.writeHead(403).end('no');
    sendRange(req, res);
  });
  await httpDownload(page, [`${base}/denied`, `${base}/ok`], 'a/four.mp4', FILE.length, fast);
  server.close();
  assert.ok(readBack('a/four.mp4').equals(FILE));
  assert.deepEqual(seen.map((s) => s.url), ['/denied', '/ok']);
});

test('NotServedError when every URL refuses or returns a sign-in page', async () => {
  const { server, base } = await serve((req, res) => {
    if (req.url === '/login') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>sign in</html>');
    res.writeHead(401).end();
  });
  await assert.rejects(httpDownload(page, [`${base}/x`, `${base}/login`], 'a/five.mp4', FILE.length, fast), NotServedError);
  server.close();
  assert.ok(!fs.existsSync(path.join(dir, 'a/five.mp4.part')));
});

test('gives up after repeated breaks', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': FILE.length });
    res.write(FILE.subarray(0, 1000), () => res.socket.destroy());
  });
  await assert.rejects(httpDownload(page, [`${base}/f`], 'a/six.mp4', FILE.length, fast), /kept breaking off/);
  server.close();
});
