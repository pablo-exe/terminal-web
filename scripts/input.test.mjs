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
  assert.equal(padding, 5);
  assert.ok(Math.abs(after.keybarBottom - 560) < 1);
  assert.equal(after.rows, before.rows);
  await viewport(page, 915);
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#keybar').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)), 29);
  assert.equal((await geometry(page)).rows, before.rows);
});

// Model a single-line editor receiving real terminal bytes, including cursor
// movement. This checks the resulting phrase, not the chosen diff algorithm.
function editedLine(bytes) {
  const line = [];
  let caret = 0;
  for (let i = 0; i < bytes.length;) {
    const arrow = /^(?:\x1b\[|\x1bO)([CD])/.exec(bytes.slice(i));
    if (arrow) {
      caret = Math.max(0, Math.min(line.length, caret + (arrow[1] === 'C' ? 1 : -1)));
      i += arrow[0].length;
    } else {
      const char = String.fromCodePoint(bytes.codePointAt(i));
      i += char.length;
      if (char === '\x7f') {
        if (caret) line.splice(--caret, 1);
      } else if (char === '\r') {
        line.length = 0;
        caret = 0;
      } else {
        line.splice(caret++, 0, char);
      }
    }
  }
  return line.join('');
}
async function gboardEdit(page, value, inputType = 'insertReplacementText') {
  await page.evaluate(({ value, inputType }) => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    ta.dispatchEvent(new InputEvent('beforeinput', { data: value, inputType, bubbles: true }));
    ta.value = value;
    ta.dispatchEvent(new InputEvent('input', { data: value, inputType, bubbles: true, composed: true }));
  }, { value, inputType });
  await page.waitForTimeout(15);
}

test('Android: equal-length Gboard correction and subsequent input do not replay the phrase', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'echo tset');
  await gboardEdit(page, 'echo test');
  assert.equal(editedLine(await sent(page)), 'echo test');
  await gboardText(page, 'ing');
  assert.equal(editedLine(await sent(page)), 'echo testing');
  await gboardEdit(page, 'echo tested');
  await gboardText(page, '!');
  assert.equal(editedLine(await sent(page)), 'echo tested!');
});

test('Android: Gboard phrase deletion and a longer correction preserve the unchanged prefix', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'echo corregir esta frase');
  await gboardEdit(page, 'echo corregir', 'deleteWordBackward');
  assert.equal(editedLine(await sent(page)), 'echo corregir');
  await gboardEdit(page, 'echo corregir bien');
  await gboardText(page, ' ahora');
  assert.equal(editedLine(await sent(page)), 'echo corregir bien ahora');
});

test('Android: composition replaces an existing word once and commits before Enter', async (t) => {
  const page = await fixture(t);
  await gboardText(page, 'echo tset');
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    ta.setSelectionRange(5, 9);
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'test', bubbles: true }));
    ta.value = 'echo test';
    ta.dispatchEvent(new InputEvent('input', { data: 'test', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
  });
  assert.equal(await sent(page), 'echo tset');
  await commit(page, 'test');
  assert.equal(editedLine(await sent(page)), 'echo test');
  const corrected = await sent(page);
  await page.keyboard.press('Enter');
  assert.equal(await sent(page), corrected + '\r');
  await gboardText(page, 'echo next');
  assert.equal(editedLine(await sent(page)), 'echo next');
});

test('Android: 229-only Backspace after paste works with empty IME context', async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'pasted');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  });
  await page.waitForTimeout(15);
  assert.equal(await sent(page), 'pasted\x7f');
});

for (const width of [412, 768]) {
  test(`Touch keys: toggling and using the bar at ${width}px never focuses the native keyboard`, async (t) => {
    const page = await fixture(t, android, {});
    await page.setViewportSize({ width, height: 915 });
    await page.evaluate(() => {
      document.activeElement.blur();
      window.nativeFocusCalls = 0;
      const original = HTMLTextAreaElement.prototype.focus;
      HTMLTextAreaElement.prototype.focus = function (...args) {
        if (this.classList.contains('xterm-helper-textarea')) window.nativeFocusCalls++;
        return original.apply(this, args);
      };
    });
    const toggle = page.locator(width > 640 ? '#topbar [title="Toggle on-screen keys"]' : '#mobilebar [title="Toggle on-screen keys"]');
    await toggle.tap();
    await toggle.tap();
    await page.locator('#keybar button').filter({ hasText: /^Tab$/ }).tap();
    await page.locator('#keybar button').filter({ hasText: /^←$/ }).tap();
    await page.waitForTimeout(100);
    assert.equal(await sent(page), '\t\x1b[D');
    assert.equal(await page.evaluate(() => window.nativeFocusCalls), 0);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), false);
    // A socket reconnect while only virtual keys are in use must not refocus.
    await page.evaluate(() => window.fixtureSockets[0].close());
    await page.waitForFunction(() => window.fixtureSockets[1]?.readyState === 1);
    assert.equal(await page.evaluate(() => window.nativeFocusCalls), 0);
  });
}

test('Touch keys: two rows fit narrow phones and tablets with Up above Down', async (t) => {
  const page = await fixture(t);
  for (const width of [320, 360, 412, 768]) {
    await page.setViewportSize({ width, height: 915 });
    await page.waitForTimeout(80);
    const layout = await page.locator('#keybar').evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      const keys = [...bar.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom,
          width: r.width, textFits: b.scrollWidth <= b.clientWidth };
      });
      return { height: box.height, left: box.left, right: box.right, bottom: box.bottom, keys };
    });
    assert.equal(new Set(layout.keys.map((key) => key.y)).size, 2, JSON.stringify(layout));
    assert.equal(layout.keys.some((key) => key.label.includes('End')), false);
    assert.ok(layout.height <= 96, JSON.stringify(layout));
    const up = layout.keys.find((key) => key.label === '↑');
    const down = layout.keys.find((key) => key.label === '↓');
    const select = layout.keys.find((key) => key.label === 'Select');
    assert.equal(up.x, down.x);
    assert.equal(up.width, down.width);
    assert.ok(up.y < down.y);
    assert.equal(select.y, down.y);
    for (const key of layout.keys) {
      assert.ok(key.x >= layout.left && key.right <= layout.right && key.bottom <= layout.bottom, JSON.stringify(key));
      assert.ok(key.textFits, JSON.stringify(key));
    }
  }
});

for (const userAgent of [android, ios]) {
  test(`Virtual bar height: ${userAgent === ios ? 'iOS' : 'Android'} reserves space without hiding the top`, async (t) => {
    const page = await fixture(t, userAgent, {});
    const toggle = page.locator('#mobilebar [title="Toggle on-screen keys"]');
    await toggle.tap(); // hide the default visible bar, keeping textarea focus
    await page.waitForTimeout(80);
    await output(page, '\x1b[2J\x1b[HTOP\x1b[999;1H$ ');
    await toggle.tap();
    await page.waitForTimeout(150);
    const after = await geometry(page);
    assert.equal(after.pan, 0, JSON.stringify(after));
    const area = await page.locator('#terminal').evaluate((el) => {
      const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
    });
    assert.ok(area.top >= after.headerBottom, JSON.stringify({ area, after }));
    assert.ok(Math.abs(area.bottom - after.keybarTop) < 1, JSON.stringify({ area, after }));
    assert.equal(await page.locator('#keybar').evaluate((el) => el.offsetHeight),
      await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--keybar-h'))));
  });
}

for (const userAgent of [android, ios]) {
  test(`Virtual keys: ${userAgent === ios ? 'iOS' : 'Android'} keyboard dismissed while textarea remains focused`, async (t) => {
    const page = await fixture(t, userAgent, {});
    // Android Back hides the OS keyboard but keeps DOM focus. Do not blur the
    // textarea as the earlier independence checks did.
    assert.equal(await page.locator('.xterm-helper-textarea').evaluate((ta) => ta === document.activeElement), true);
    await page.locator('#keybar button').filter({ hasText: /^Tab$/ }).tap();
    assert.deepEqual(await page.locator('.xterm-helper-textarea').evaluate((ta) => ({
      mode: ta.inputMode, readonly: ta.readOnly, focused: ta === document.activeElement,
    })), { mode: 'none', readonly: true, focused: false });
    await page.locator('#keybar button').filter({ hasText: /^←$/ }).tap();
    assert.equal(await sent(page), '\t\x1b[D');
    // Even a later browser/default focus cannot target an editable input.
    await page.locator('.xterm-helper-textarea').focus();
    assert.equal(await page.locator('.xterm-helper-textarea').evaluate((ta) => ta.readOnly), true);
    await page.locator('#terminal').tap({ position: { x: 30, y: 30 } });
    assert.deepEqual(await page.locator('.xterm-helper-textarea').evaluate((ta) => ({
      mode: ta.inputMode, readonly: ta.readOnly,
    })), { mode: '', readonly: false });
    await page.locator('.xterm-helper-textarea').focus();
    if (userAgent === android) await gboardText(page, 'ok');
    else await page.keyboard.type('ok');
    assert.equal(await sent(page), '\t\x1b[Dok');
  });

  test(`Virtual keys: ${userAgent === ios ? 'iOS' : 'Android'} keeps an already open device keyboard editable`, async (t) => {
    const page = await fixture(t, userAgent, {});
    await viewport(page, 560);
    await page.locator('#keybar button').filter({ hasText: /^Tab$/ }).tap();
    assert.deepEqual(await page.locator('.xterm-helper-textarea').evaluate((ta) => ({
      readonly: ta.readOnly, focused: ta === document.activeElement,
    })), { readonly: false, focused: true });
    if (userAgent === android) await gboardText(page, 'a');
    else await page.keyboard.type('a');
    assert.equal(await sent(page), '\ta');
  });
}
