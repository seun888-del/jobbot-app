// CapSolver integration — auto-detects and solves reCAPTCHA v2 / hCaptcha.
// Requires CAPSOLVER_KEY env var. Silently skips if no key is configured.

const https = require('https');
const cfg   = require('../config');

const POLL_MS   = 3000;
const MAX_POLLS = 60; // 3 minutes max

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.capsolver.com',
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function pollResult(taskId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const res = await apiPost('/getTaskResult', { clientKey: cfg.CAPSOLVER_KEY, taskId });
    if (res.errorId) throw new Error(`CapSolver: ${res.errorDescription}`);
    if (res.status === 'ready') return res.solution;
  }
  throw new Error('CapSolver timed out after 3 minutes');
}

async function createAndSolve(taskBody) {
  const res = await apiPost('/createTask', { clientKey: cfg.CAPSOLVER_KEY, task: taskBody });
  if (res.errorId) throw new Error(`CapSolver createTask: ${res.errorDescription}`);
  return pollResult(res.taskId);
}

// Solve reCAPTCHA v2 if present on the page or any of its frames.
// CapSolver solves the image grid challenge server-side and returns a token —
// the bot never has to click any image squares.
async function solveRecaptchaV2(page) {
  if (!cfg.CAPSOLVER_KEY) return false;

  // Collect all frames (main + iframes) so we find the sitekey even when the
  // form is embedded in an iframe.
  let frames;
  try { frames = page.frames(); } catch (_) { frames = [page]; }

  let sitekey = null;
  let targetFrame = page;

  for (const frame of frames) {
    sitekey = await frame.evaluate(() => {
      const el = document.querySelector('.g-recaptcha, [data-sitekey]');
      return el?.getAttribute('data-sitekey') || null;
    }).catch(() => null);
    if (sitekey) { targetFrame = frame; break; }
  }
  if (!sitekey) return false;

  console.log('  [CAPTCHA] reCAPTCHA v2 detected — solving via CapSolver (image challenge handled server-side)...');
  try {
    const solution = await createAndSolve({
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: page.url(),   // main page URL — reCAPTCHA sitekey is bound to this domain
      websiteKey: sitekey,
    });
    const token = solution.gRecaptchaResponse;
    // Inject the token into the same frame where the reCAPTCHA lives
    await targetFrame.evaluate((t) => {
      const el = document.getElementById('g-recaptcha-response');
      if (el) { el.innerHTML = t; el.style.display = 'block'; }
      const cb = document.querySelector('[data-callback]')?.getAttribute('data-callback');
      if (cb && typeof window[cb] === 'function') window[cb](t);
    }, token);
    console.log('  [CAPTCHA] reCAPTCHA solved — token injected.');
    return true;
  } catch (err) {
    console.error(`  [CAPTCHA] reCAPTCHA solve failed: ${err.message}`);
    return false;
  }
}

// Solve hCaptcha if present on the page. Returns true if solved.
async function solveHcaptcha(page) {
  if (!cfg.CAPSOLVER_KEY) return false;
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.h-captcha, [data-hcaptcha-widget-id]');
    return el?.getAttribute('data-sitekey') || null;
  }).catch(() => null);
  if (!sitekey) return false;

  console.log('  [CAPTCHA] hCaptcha detected — solving via CapSolver...');
  try {
    const solution = await createAndSolve({
      type: 'HCaptchaTaskProxyLess',
      websiteURL: page.url(),
      websiteKey: sitekey,
    });
    const token = solution.gRecaptchaResponse;
    await page.evaluate((t) => {
      const el = document.querySelector('[name="h-captcha-response"], textarea[name="h-captcha-response"]');
      if (el) el.value = t;
    }, token);
    console.log('  [CAPTCHA] hCaptcha solved.');
    return true;
  } catch (err) {
    console.error(`  [CAPTCHA] hCaptcha solve failed: ${err.message}`);
    return false;
  }
}

// Solve Cloudflare Turnstile if present on the page.
// Turnstile is what Indeed uses — it looks like a "Verify you are human" checkbox.
// CapSolver handles it server-side and returns a cf-turnstile-response token.
async function solveTurnstile(page) {
  if (!cfg.CAPSOLVER_KEY) return false;

  // Turnstile renders inside an iframe; the sitekey lives on a div with
  // data-sitekey or on the iframe's src query-string.
  let sitekey = null;
  let frames;
  try { frames = page.frames(); } catch (_) { frames = [page]; }

  for (const frame of [page, ...frames]) {
    sitekey = await frame.evaluate(() => {
      // Standard Turnstile widget div
      const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (widget) return widget.getAttribute('data-sitekey');
      // Turnstile in iframe — check iframe src
      const iframes = Array.from(document.querySelectorAll('iframe[src*="turnstile"]'));
      for (const f of iframes) {
        const m = (f.src || '').match(/[?&]sitekey=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    }).catch(() => null);
    if (sitekey) break;
  }

  if (!sitekey) return false;

  console.log('  [CAPTCHA] Cloudflare Turnstile detected — solving via CapSolver...');
  try {
    const solution = await createAndSolve({
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: page.url(),
      websiteKey: sitekey,
    });
    const token = solution.token;
    if (!token) throw new Error('No token returned from CapSolver');

    // Inject token into the hidden textarea Turnstile uses, then fire the
    // callback so the form becomes submittable.
    await page.evaluate((t) => {
      // Hidden input that Turnstile populates
      const inp = document.querySelector('[name="cf-turnstile-response"], input[name*="turnstile"]');
      if (inp) { inp.value = t; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      // Fire the success callback if the widget registered one
      const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
      const cb = widget?.getAttribute('data-callback');
      if (cb && typeof window[cb] === 'function') window[cb](t);
    }, token);

    console.log('  [CAPTCHA] Turnstile solved — token injected.');
    return true;
  } catch (err) {
    console.error(`  [CAPTCHA] Turnstile solve failed: ${err.message}`);
    return false;
  }
}

// Auto-detect and solve any CAPTCHA on the current page.
async function autoSolve(page) {
  if (!cfg.CAPSOLVER_KEY) return false;
  const url = page.url();
  if (!url || url === 'about:blank') return false;
  if (await solveTurnstile(page)) return true;
  if (await solveRecaptchaV2(page)) return true;
  return solveHcaptcha(page);
}

module.exports = { autoSolve, solveRecaptchaV2, solveHcaptcha, solveTurnstile };
