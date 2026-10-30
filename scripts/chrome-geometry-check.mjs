// Run with node --import tsx scripts/chrome-geometry-check.mjs.
// Geometry and native-dialog regression using owned, temporary Chrome profiles only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { ChromeBrowser, installedChrome } from '../electron/chrome-browser.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-chrome-geometry-'));
const events = [];
const results = [];
const failures = [];
const record = (value, message, details) => {
  if (!value) failures.push({ message, ...details });
};
// Decode Chromium's 8-bit RGB(A) PNG and find the uniquely green fixture button.
// This checks screenshot coordinates without deriving the target from the DOM.
function greenButton(image) {
  const width = image.readUInt32BE(16),
    height = image.readUInt32BE(20);
  assert.equal(image[24], 8);
  assert.ok([2, 6].includes(image[25]));
  const channels = image[25] === 6 ? 4 : 3;
  const chunks = [];
  for (let at = 8; at < image.length;) {
    const length = image.readUInt32BE(at);
    if (image.toString('ascii', at + 4, at + 8) === 'IDAT')
      chunks.push(image.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride),
    offset = 0;
  const box = { left: width, top: height, right: -1, bottom: -1 };
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = data[offset++],
      row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x],
        c = x >= channels ? previous[x - channels] : 0;
      row[x] =
        data[offset++] +
        (filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : paeth(a, b, c));
    }
    for (let x = 0; x < width; x++) {
      const [r, g, b] = row.subarray(x * channels, x * channels + 3);
      if (g > 80 && r < 100 && b < 150 && g > r * 1.5 && g > b * 1.2) {
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x);
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y);
      }
    }
    previous = row;
  }
  return box.right >= box.left
    ? { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
    : undefined;
}
const server = http.createServer((req, res) => {
  if (req.url === '/event') {
    let body = '';
    req.on('data', (data) => (body += data));
    req.on('end', () => {
      events.push(JSON.parse(body));
      res.end('ok');
    });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>Geometry fixture</title><style>
    body{margin:0;font:16px system-ui;background:#f7f7f7;min-width:720px;min-height:500px}
    button{position:absolute;width:130px;height:45px;border:0;color:white;background:#315ae8}
    #alpha{left:100px;top:100px}#beta{left:330px;top:240px;background:#167d55}#confirmation{left:100px;top:380px}
    #result{position:absolute;top:440px;left:15px}
    </style></head><body><button id="alpha">Target Alpha</button><button id="beta">Target Beta</button>
    <button id="confirmation" onclick="document.querySelector('#result').textContent=confirm('Manual response?')?'Manual accepted':'Manual cancelled'">Native dialog</button>
    <p id="result">Ready</p><script>
    document.addEventListener('pointerdown',e=>fetch('/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:location.search,target:e.target.id||e.target.tagName,trusted:e.isTrusted,x:e.clientX,y:e.clientY,dpr:devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},visualViewport:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop}})}));
    </script></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const backend = new ChromeBrowser({
  root: path.join(root, 'managed-data'),
  downloadsRoot: path.join(root, 'managed-downloads'),
  changed() {},
  headless: true,
});
let personal, host;
const until = async (check, label) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(label);
};
async function checkGeometry(service, tab, label) {
  const act = (input) => service.action(tab.id, input);
  await act({ action: 'navigate', url: `${origin}/?${label}` });
  for (const factor of [0.75, 1.5]) {
    await assert.rejects(() => act({ action: 'zoom', factor }), /Chrome|zoom|menú/i);
  }
  const factor = 1;
  {
    for (const [name, id] of [
      ['Target Alpha', 'alpha'],
      ['Target Beta', 'beta'],
    ]) {
      const inspection = await act({ action: 'inspect' });
      const target = inspection.elements.find((item) => item.label === name);
      assert.ok(target, `Missing ${name}`);
      const before = events.length;
      let error;
      try {
        await act({ action: 'click', ref: target.ref });
      } catch (cause) {
        error = cause.message;
      }
      const event = await until(
        () => events.length > before && events.at(-1),
        'Missing pointer event',
      ).catch(() => undefined);
      results.push({
        label,
        factor,
        expected: id,
        rect: target.rect,
        viewport: inspection.viewport,
        event,
        error,
      });
      record(
        !error && event?.target === id && event?.trusted === true,
        'Reference click must hit the intended element with a trusted event',
        { label, factor, expected: id, event, error },
      );
    }
    const screenshot = await act({ action: 'screenshot' });
    const image = Buffer.from(screenshot.image, 'base64');
    assert.equal(image.toString('ascii', 1, 4), 'PNG');
    const actual = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
    results.push({
      label,
      factor,
      screenshot: { actual, imageSize: screenshot.imageSize, viewport: screenshot.viewport },
    });
    record(
      screenshot.imageSize?.width === actual.width &&
        screenshot.imageSize?.height === actual.height,
      'Screenshot imageSize must match its PNG dimensions',
      { label, factor, actual, reported: screenshot.imageSize, viewport: screenshot.viewport },
    );
    const point = greenButton(image);
    record(!!point, 'The screenshot must include the green fixture button', { label, factor });
    if (point) {
      const coordinates = {
        x: (point.x * screenshot.viewport.width) / screenshot.imageSize.width,
        y: (point.y * screenshot.viewport.height) / screenshot.imageSize.height,
      };
      const before = events.length;
      await act({ action: 'click', ...coordinates });
      const event = await until(
        () => events.length > before && events.at(-1),
        'Missing screenshot click',
      );
      results.push({ label, factor, screenshotClick: { imagePoint: point, coordinates, event } });
      record(
        event.target === 'beta' && event.trusted === true,
        'Screenshot coordinates must hit the depicted element',
        { label, factor, coordinates, event },
      );
    }
  }
}
try {
  await backend.connect('managed', 'project', 'session');
  await checkGeometry(backend, backend.snapshot()[0], 'managed-dpr1');
  await backend.disconnect(backend.connections()[0].id);

  // This second browser is test-owned; remote debugging never uses the personal profile.
  const personalProfile = path.join(root, 'owned-dpr2');
  host = await chromium.launchPersistentContext(personalProfile, {
    executablePath: await installedChrome(),
    headless: true,
    chromiumSandbox: true,
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
    args: ['--remote-debugging-port=0'],
  });
  const page = host.pages()[0];
  page.on('dialog', () => {});
  await page.goto(`${origin}/?personal-dpr2`);
  personal = new ChromeBrowser({
    root: path.join(root, 'personal-data'),
    downloadsRoot: path.join(root, 'personal-downloads'),
    personalProfile,
    changed() {},
  });
  await personal.connect('personal', 'project', 'session');
  const tab = personal.snapshot()[0];
  await checkGeometry(personal, tab, 'personal-dpr2');
  const cdp = await host.newCDPSession(page);
  await cdp.send('Page.enable');
  // Synthetic pinch is only a safety regression: unsupported pointer geometry must
  // be rejected, without sending an unintended click. It is not Chrome menu zoom.
  const beforePinch = await personal.action(tab.id, { action: 'inspect' });
  const beta = beforePinch.elements.find((item) => item.label === 'Target Beta');
  const countBeforePinch = events.length;
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
  await assert.rejects(
    () => personal.action(tab.id, { action: 'click', ref: beta.ref }),
    /zoom|gesto|escala|pellizco/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events.length, countBeforePinch, 'Active pinch must not dispatch unintended input');
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  const inspection = await personal.action(tab.id, { action: 'inspect' });
  const modal = await personal.action(tab.id, {
    action: 'click',
    ref: inspection.elements.find((item) => item.label === 'Native dialog').ref,
  });
  assert.equal(modal.dialog?.type, 'confirm');
  await cdp.send('Page.handleJavaScriptDialog', { accept: true });
  const cleared = await until(
    () => !personal.snapshot().find((item) => item.id === tab.id)?.dialog,
    'Manually answered dialog stayed pending',
  )
    .then(() => true)
    .catch(() => false);
  record(cleared, 'Native manual dialog response must clear the backend dialog', {});
  if (cleared)
    record(
      (await personal.action(tab.id, { action: 'inspect' })).text.includes('Manual accepted'),
      'Page must continue after native manual response',
      {},
    );
  await cdp.detach();
  if (failures.length || process.env.DEBUG_CHROME_GEOMETRY)
    console.log(JSON.stringify({ results, failures }, null, 2));
  assert.equal(failures.length, 0, `Chrome geometry/dialog failures: ${JSON.stringify(failures)}`);
  console.log(
    'PASS Chrome geometry: trusted reference and screenshot-coordinate clicks at DPR1/2, unsupported zoom rejection, active-pinch input guard, and manual native dialog response.',
  );
} finally {
  await personal?.closeAll();
  await host?.close();
  await backend.closeAll();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
