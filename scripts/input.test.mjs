// Browser regression checks with real xterm.js and synthetic keyboard events.
// The API and WebSocket are fixtures: no shell, tmux, or live service is opened.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const publicRoot = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const android = 'Mozilla/5.0 (Linux; Android 17; Pixel 8) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36';
const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
let browser;
let server;
let base;

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/sessions' ? { tabs: [{ name: 'fixture' }] } : {}));
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(publicRoot + sep)) { res.writeHead(403).end(); return; }
    try {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.setHeader('Content-Type', type);
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

async function fixture(t, userAgent = android, metrics = null) {
  const context = await browser.newContext({ userAgent, viewport: { width: 412, height: 915 }, hasTouch: true });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript((metrics) => {
    if (metrics) {
      window.viewportFixture = { height: 915, offsetTop: 0, scale: 1, innerHeight: null, ...metrics };
      const viewport = new EventTarget();
      for (const key of ['height', 'offsetTop', 'scale']) {
        Object.defineProperty(viewport, key, { get: () => window.viewportFixture[key] });
      }
      Object.defineProperty(window, 'visualViewport', { value: viewport });
      Object.defineProperty(window, 'innerHeight', {
        get: () => window.viewportFixture.innerHeight ?? document.documentElement.clientHeight,
      });
    }
    Object.defineProperty(navigator, 'platform', {
      get: () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Linux aarch64',
    });
    window.terminalBytes = [];
    window.terminalResizes = [];
    window.fixtureSockets = [];
    window.WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      constructor() {
        window.fixtureSockets.push(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
      }
      send(data) {
        if (typeof data !== 'string') window.terminalBytes.push(new TextDecoder().decode(data));
        else if (JSON.parse(data).type === 'resize') window.terminalResizes.push(JSON.parse(data));
      }
      close() { this.readyState = 3; this.onclose?.({}); }
    };
  }, metrics);
  await page.goto(base + '/?webgl=0');
  await page.waitForFunction(() => window.fixtureSockets[0]?.readyState === 1);
  await page.locator('.xterm-helper-textarea').focus();
  return page;
}
const sent = (page) => page.evaluate(() => window.terminalBytes.join(''));

// Gboard can send keyCode 229 + insertText without any compositionend. These
// are DOM event traces, not Playwright keyboard.type (which emulates a desktop).
async function gboardText(page, text) {
  for (const char of text) {
    await page.evaluate((char) => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      ta.value += char;
      ta.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true, composed: true }));
    }, char);
    await page.waitForTimeout(15); // xterm's textarea diff is deferred one tick
    await page.evaluate(() => document.querySelector('.xterm-helper-textarea').dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }),
    ));
  }
}
async function composing(page, words) {
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    window.compositionPrefix = ta.value;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  for (const word of words) {
    await page.evaluate((word) => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, isComposing: true, bubbles: true }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: word, bubbles: true }));
      ta.value = window.compositionPrefix + word;
      ta.dispatchEvent(new InputEvent('input', { data: word, inputType: 'insertCompositionText', isComposing: true, bubbles: true, composed: true }));
    }, word);
    await page.waitForTimeout(15);
  }
}
async function commit(page, text, enter = false) {
  await page.evaluate(({ text, enter }) => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true, composed: true }));
    if (enter) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true }));
  }, { text, enter });
  await page.waitForTimeout(25);
}

test('Android: Gboard insertText reaches the socket once, including repeated Unicode', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'echo test éé');
  assert.equal(await sent(page), 'echo test éé');
  await page.keyboard.press('Enter');
  await gboardText(page, 'echo again');
  assert.equal(await sent(page), 'echo test éé\recho again');
});

test('Android: predictive composition is visible and commits only its final text', async (t) => {
  const page = await fixture(t);
  await composing(page, ['t', 'ts', 'tset', 'test']);
  assert.equal(await sent(page), '');
  assert.match(await page.locator('.composition-view.active').textContent(), /test/);
  await commit(page, 'test', true); // Enter before the deferred commit must not duplicate it
  assert.equal(await sent(page), 'test\r');
  await composing(page, ['é']);
  await commit(page, 'é');
  await composing(page, ['é']);
  await commit(page, 'é');
  assert.equal(await sent(page), 'test\réé');
});

test('Android: paste, Backspace and subsequent Gboard input do not replay the paste', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'pasted');
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    // Emulate the browser's default insertion only when it was not prevented.
    if (!event.defaultPrevented) ta.value += 'pasted';
  });
  await page.keyboard.press('Backspace');
  await gboardText(page, 'xy');
  assert.equal(await sent(page), 'pasted\x7fxy');
});

test('Android: Gboard 229-only deletion sends one Backspace', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'abc');
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    ta.value = ta.value.slice(0, -1);
    ta.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true, composed: true }));
  });
  await page.waitForTimeout(15);
  await gboardText(page, 'd');
  assert.equal(await sent(page), 'abc\x7fd');
});

test('Android: reconnect during composition preserves the pending commit', async (t) => {
  const page = await fixture(t);
  await composing(page, ['test']);
  await page.evaluate(() => window.fixtureSockets[0].close());
  await page.waitForFunction(() => window.fixtureSockets[1]?.readyState === 1);
  assert.equal(await page.locator('.xterm-helper-textarea').inputValue(), 'test');
  await commit(page, 'test');
  assert.equal(await sent(page), 'test');
  await gboardText(page, '1');
  assert.equal(await sent(page), 'test1');
});

test('iOS: custom composition commits once and 229-only punctuation still works', async (t) => {
  const page = await fixture(t, ios);
  await composing(page, ['你好']);
  await commit(page, '你好');
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea').dispatchEvent(
    new KeyboardEvent('keydown', { key: '1', keyCode: 229, bubbles: true }),
  ));
  await page.waitForTimeout(120);
  assert.equal(await sent(page), '你好1');
});

test('desktop: ordinary typing and Ctrl+C retain their native terminal behavior', async (t) => {
  const page = await fixture(t, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36');
  await page.keyboard.type('echo desktop');
  await page.keyboard.press('Control+c');
  assert.equal(await sent(page), 'echo desktop\x03');
});


// Model the two browser keyboard policies and viewport panning explicitly.
// Headless Chromium has no OS keyboard, so these are geometry regressions.
async function viewport(page, height, offsetTop = 0) {
  await page.evaluate(({ height, offsetTop }) => {
    Object.assign(window.viewportFixture, { height, offsetTop });
    window.visualViewport.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('scroll'));
  }, { height, offsetTop });
  await page.waitForTimeout(80);
}
async function output(page, text) {
  await page.evaluate((text) => window.fixtureSockets[0].onmessage({
    data: new TextEncoder().encode(text).buffer,
  }), text);
  await page.waitForTimeout(80);
}
async function geometry(page) {
  return page.evaluate(() => {
    const keybar = document.getElementById('keybar').getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    const cursor = document.querySelector('.xterm-cursor').getBoundingClientRect();
    const header = document.getElementById('mobilebar').getBoundingClientRect();
    return {
      keybarTop: keybar.top, keybarBottom: keybar.bottom,
      screenHeight: screen.height, cursorTop: cursor.top, cursorBottom: cursor.bottom,
      headerBottom: header.bottom, pan: parseFloat(document.documentElement.style.getPropertyValue('--kb-offset')),
      rows: window.terminalResizes.at(-1)?.rows,
    };
  });
}

test('Android viewport: fresh prompt stays visible when only the visual viewport shrinks', async (t) => {
  const page = await fixture(t, android, {});
  await output(page, '\x1b[2J\x1b[H$ ');
  const before = await geometry(page);
  await viewport(page, 560);
  const after = await geometry(page);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1, JSON.stringify(after));
  assert.equal(after.pan, 0, 'do not slide a fresh prompt off the top');
  assert.ok(after.cursorTop >= after.headerBottom && after.cursorBottom < after.keybarTop, JSON.stringify(after));
  assert.equal(after.screenHeight, before.screenHeight);
  assert.equal(after.rows, before.rows);
  await viewport(page, 915);
  assert.equal((await geometry(page)).pan, 0);
});

test('Android viewport: fixed keybar uses layout height, not a larger innerHeight', async (t) => {
  const page = await fixture(t, android, { innerHeight: 975 });
  await output(page, '\x1b[H$ ');
  await viewport(page, 560);
  const after = await geometry(page);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1, JSON.stringify(after));
});

test('Android viewport: bottom prompt is visible across pan, output and content resize', async (t) => {
  const page = await fixture(t, android, {});
  await output(page, '\x1b[999;1H$ ');
  const before = await geometry(page);
  await viewport(page, 440, 120);
  let after = await geometry(page);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1, JSON.stringify(after));
  assert.ok(after.cursorTop >= after.headerBottom && after.cursorBottom <= after.keybarTop, JSON.stringify(after));
  assert.ok(after.pan > 0);
  assert.equal(after.rows, before.rows);
  // The shell moves back to its first row while the keyboard remains open.
  await output(page, '\x1b[H$ ');
  after = await geometry(page);
  assert.equal(after.pan, 0);
  assert.ok(after.cursorTop >= after.headerBottom, JSON.stringify(after));
  // Android Chrome's resizes-content policy also shrinks the fixed-position box.
  await page.setViewportSize({ width: 412, height: 560 });
  await viewport(page, 560);
  after = await geometry(page);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1, JSON.stringify(after));
  assert.equal(after.rows, before.rows);
  await page.setViewportSize({ width: 412, height: 915 });
  await viewport(page, 915);
  assert.equal((await geometry(page)).rows, before.rows);
});

test('Android viewport: navigation safe area is not added beneath the keyboard', async (t) => {
  const page = await fixture(t, android, {});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 24 } });
  await page.waitForTimeout(100);
  await output(page, '\x1b[H$ ');
  const before = await geometry(page);
  await viewport(page, 560);
  const after = await geometry(page);
  const padding = await page.locator('#keybar').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  assert.equal(padding, 6);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1);
  assert.equal(after.rows, before.rows);
  await viewport(page, 915);
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#keybar').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)), 30);
  assert.equal((await geometry(page)).rows, before.rows);
});
