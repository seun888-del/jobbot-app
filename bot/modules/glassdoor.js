const path = require('path');
const cfg  = require('../config');
const { humanWarmup, waitForCloudflareSolve } = require('./browser_launcher');
const { llmAvailable, llmChat } = require('../../src/services/llm');
const { fillEasyApplyForm } = require('./indeed');

const DELAY = ms => new Promise(r => setTimeout(r, ms));
const J     = (min, max) => DELAY(min + Math.random() * (max - min));

const SSDIR = cfg.SCREENSHOTS_DIR;
const ss = (page, name) => page.screenshot({ path: path.join(SSDIR, `gd_${name}.png`) }).catch(() => {});

// ── Overlay dismissal ──────────────────────────────────────────────────────
async function _dismissOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await J(200, 400);

  let cookieAccepted = false;
  for (const sel of [
    'button[data-test="accept-all-btn"]',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all cookies")',
    '#onetrust-accept-btn-handler',
  ]) {
    try { await page.click(sel, { timeout: 1500 }); cookieAccepted = true; await J(400, 700); break; } catch (_) {}
  }
  if (!cookieAccepted) {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        /accept.*cookie|accept all/i.test(b.textContent || '')
      );
      if (btn) btn.click();
    }).catch(() => {});
    await J(300, 500);
  }

  for (const sel of [
    'button[aria-label="Close"]', 'button[data-test="modal-close-btn"]',
    '[class*="ProfileSyncModal"] button', '[class*="profileSync"] button',
    'button:has-text("Dismiss")', 'button:has-text("No thanks")',
    'button:has-text("Skip")', '[class*="CloseButton"]',
  ]) {
    try { await page.click(sel, { timeout: 800 }); await J(200, 400); } catch (_) {}
  }
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b =>
      /^(×|✕|close|dismiss|no thanks|skip)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())
    );
    if (btn) btn.click();
  }).catch(() => {});
  await J(200, 400);
}

function getBaseUrl() {
  return cfg.APPLICANT.country === 'United States'
    ? 'https://www.glassdoor.com'
    : 'https://www.glassdoor.co.uk';
}

// ── Login ──────────────────────────────────────────────────────────────────
async function ensureLoggedIn(page, domain) {
  const baseUrl = domain ? `https://www.${domain}` : getBaseUrl();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ss(page, 'login_check');
  await waitForCloudflareSolve(page, { maxWaitMs: 45000 });
  await ss(page, 'after_cf_check');
  await J(1800, 3000);
  await humanWarmup(page);
  await _dismissOverlays(page);

  const { loggedIn, onLoginGate } = await page.evaluate(() => {
    const t   = (document.body?.innerText || '').toLowerCase();
    const url = window.location.href.toLowerCase();
    const loggedIn =
      url.includes('/community') || url.includes('/profile') ||
      t.includes('sign out') || t.includes('my profile') ||
      t.includes('community guidelines') || t.includes('create post') ||
      t.includes('my bowls') ||
      !!document.querySelector('[data-test="user-menu"], [class*="userMenu"], [class*="SignedIn"]');
    const onLoginGate =
      t.includes('create an account or sign in') ||
      t.includes('continue with google') ||
      t.includes('continue with apple or email') ||
      t.includes('one login') ||
      url.includes('/member/login') || url.includes('/login_input');
    return { loggedIn, onLoginGate };
  }).catch(() => ({ loggedIn: false, onLoginGate: false }));

  if (onLoginGate) {
    throw new Error(
      'Glassdoor: landed on the sign-in page. Glassdoor now uses a combined Glassdoor+Indeed login. ' +
      'Click "Connect account" on the Glassdoor card, sign in through the browser that opens, then restart the bot.'
    );
  }
  if (!loggedIn) {
    throw new Error('Glassdoor: not logged in. Click "Connect account" on the Glassdoor card and log in first.');
  }
  console.log('  [Glassdoor] Session active');
}

// ── Search Jobs ────────────────────────────────────────────────────────────
async function searchJobs(page, searchTerm, limit = 25) {
  const baseUrl = getBaseUrl();
  console.log(`\n  [Glassdoor] Searching: "${searchTerm}"`);

  const jobAgeSecs  = cfg.JOB_AGE ? parseInt((cfg.JOB_AGE || '').replace('r', ''), 10) : 1209600;
  const fromAgeDays = Math.max(1, Math.round((isNaN(jobAgeSecs) ? 1209600 : jobAgeSecs) / 86400));
  const encoded     = encodeURIComponent(searchTerm);
  // No applicationType filter — include both Easy Apply and external-site jobs
  const searchUrl   = `${baseUrl}/Job/jobs.htm?sc.keyword=${encoded}&remoteWorkType=1&fromAge=${fromAgeDays}&sortBy=date_desc`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await J(2000, 3500);
  await ss(page, 'search_loaded');
  await waitForCloudflareSolve(page, { maxWaitMs: 45000 });
  await ss(page, 'search_after_cf');
  await _dismissOverlays(page);
  await humanWarmup(page);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 500 + Math.random() * 300));
    await J(600, 1100);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await J(400, 700);

  await ss(page, 'search_results');
  console.log(`  [Glassdoor] Page URL after search: ${page.url()}`);

  const jobs = await page.evaluate((lim) => {
    const cardSelectors = [
      '[data-test="jobListing"]', 'li[data-jobid]', 'div[data-jobid]',
      '[class*="JobsList_jobListItem"]', '[class*="jobCard"]', '[class*="JobCard"]',
      '[class*="job-listing"]', '.react-job-listing',
    ];
    let cards = [], usedSel = '';
    for (const sel of cardSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) { cards = found; usedSel = sel; break; }
    }
    if (!cards.length) {
      const links = Array.from(document.querySelectorAll(
        'a[href*="/job-listing/"], a[href*="jobListingId="], a[href*="jl="]'
      ));
      return links.slice(0, lim).map(a => {
        const href  = a.getAttribute('href') || '';
        const jobId = href.match(/jl=(\d+)/)?.[1] || href.match(/jobListingId=(\d+)/)?.[1] || href.match(/-(\d+)\.htm/)?.[1] || '';
        const title = (a.innerText || a.textContent || '').trim();
        let company = '', el = a.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          const c = el.querySelector('[class*="employer"],[class*="company"],[class*="Company"],[data-test*="company"],[data-test*="employer"]');
          if (c && c !== a) { company = (c.innerText || c.textContent || '').trim(); break; }
          el = el.parentElement;
        }
        return { title, company, jobId: 'glassdoor_' + jobId, jobKey: jobId, url: href.startsWith('http') ? href : window.location.origin + href };
      }).filter(j => j.jobKey && j.title);
    }
    return cards.slice(0, lim).map(card => {
      const titleEl = card.querySelector(
        '[data-test="job-title"], a[data-test*="title"], [class*="jobTitle"] a, [class*="JobTitle"] a, h3 a, h2 a'
      ) || card.querySelector('a[href*="jl="], a[href*="/job-listing/"], a[href*="jobListingId="]');
      const companyEl = card.querySelector(
        '[data-test="employer-name"], [class*="EmployerName"], [class*="employerName"], [class*="companyName"]'
      );
      const href  = titleEl?.getAttribute('href') || '';
      const jobId = card.getAttribute('data-jobid') || card.getAttribute('data-id') ||
                    href.match(/jl=(\d+)/)?.[1] || href.match(/jobListingId=(\d+)/)?.[1] || href.match(/-(\d+)\.htm/)?.[1] || '';
      return {
        title:   (titleEl?.innerText || titleEl?.textContent || '').trim(),
        company: (companyEl?.innerText || companyEl?.textContent || '').trim(),
        jobId:   'glassdoor_' + jobId, jobKey: jobId, _sel: usedSel,
        url:     href ? (href.startsWith('http') ? href : window.location.origin + href) : '',
      };
    }).filter(j => j.jobKey && j.title);
  }, limit);

  if (jobs.length) {
    console.log(`  [Glassdoor] Found ${jobs.length} jobs (via ${jobs[0]._sel || 'link fallback'})`);
  } else {
    console.log(`  [Glassdoor] No jobs found — title: "${await page.title().catch(() => '?')}"`);
    const txt = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '').catch(() => '');
    console.log(`  [Glassdoor] Page snippet: ${txt.replace(/\n/g, ' ').trim()}`);
  }
  return jobs.map(({ _sel, ...j }) => j);
}

// ── Get Job Description ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  if (!job.url) return { ...job, description: '', hasEasyApply: false, hasExternalApply: false };

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await J(2000, 3500);
  await humanWarmup(page);
  await _dismissOverlays(page);

  const { description, hasEasyApply, hasExternalApply } = await page.evaluate(() => {
    const descSelectors = [
      '[class*="jobDescriptionContent"]', '[data-test="jobDescriptionContent"]',
      '.desc', '[class*="JobDescription"]',
    ];
    let desc = '';
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) { desc = el.innerText.trim(); break; }
    }
    if (!desc) {
      const main = document.querySelector('main, [class*="jobContent"]');
      if (main) desc = main.innerText.trim().substring(0, 8000);
    }

    const bodyText = (document.body?.innerText || '').toLowerCase();
    const hasEasyApply = !!document.querySelector('[data-test="easy-apply-button"], [class*="EasyApplyButton"]') ||
                         bodyText.includes('easy apply');

    // External apply = any Apply button that isn't Easy Apply
    const hasExternalApply = !hasEasyApply && (
      !!document.querySelector('[data-test="apply-button"]') ||
      bodyText.includes('apply on company website') ||
      bodyText.includes('apply on employer') ||
      !!Array.from(document.querySelectorAll('a, button')).find(el =>
        /^apply(\s+on|\s+now|\s+at)?$/i.test((el.textContent || '').trim())
      )
    );

    return { description: desc, hasEasyApply, hasExternalApply };
  });

  const type = hasEasyApply ? 'EASY APPLY' : hasExternalApply ? 'EXTERNAL' : 'NO APPLY';
  console.log(`  [Glassdoor] JD: ${description.length} chars | Apply type: ${type}`);
  return { ...job, description, hasEasyApply, hasExternalApply };
}

// ── Apply to Job ────────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [Glassdoor] Applying: ${job.title} @ ${job.company}`);

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await J(2500, 4000);
  await humanWarmup(page);
  await _dismissOverlays(page);
  await ss(page, 'job_page');

  const alreadyApplied = await page.evaluate(() =>
    (document.body?.innerText || '').toLowerCase().includes('you applied') ||
    !!document.querySelector('[data-test="applied-badge"]')
  );
  if (alreadyApplied) return null;

  // Easy Apply: click the button, fill the Indeed-hosted form
  if (job.hasEasyApply) {
    return await _applyEasyApply(page, job, resumePath);
  }

  // External-only jobs: skip (apply-on-company-website)
  console.log('  [Glassdoor] External apply only — skipping');
  return false;
}

async function _applyEasyApply(page, job, resumePath) {
  const easyApplySelectors = [
    'button[data-test="easy-apply-button"]',
    '[class*="EasyApplyButton"] button',
    '[class*="EasyApplyButton"]',
    'button:has-text("Easy Apply")',
    'button:has-text("Easily Apply")',
  ];

  let applyPage = null;
  for (const sel of easyApplySelectors) {
    try {
      const btn = await page.$(sel);
      if (!btn || !await btn.isVisible()) continue;
      const [newTab] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
        btn.click(),
      ]);
      applyPage = newTab || page;
      if (newTab) await newTab.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await J(3000, 4500);
      break;
    } catch (_) {}
  }

  if (!applyPage) {
    await ss(page, 'apply_no_button');
    console.log('  [Glassdoor] Easy Apply button not found');
    return false;
  }

  // Check landing URL — if the page closed after click (e.g. popup rejected) bail out
  let landingUrl;
  try { landingUrl = applyPage.url(); } catch (_) {
    console.log('  [Glassdoor] Apply tab closed unexpectedly');
    return false;
  }

  await ss(applyPage, 'apply_landing');
  console.log(`  [Glassdoor] Easy Apply opened: ${landingUrl.substring(0, 80)}`);

  // Detect the Indeed auth/login wall — the glassdoor_profile needs an Indeed session.
  // Use "Connect account" on the Glassdoor card which now opens Indeed login first.
  const isAuthWall = landingUrl.includes('indeed.com') &&
    (landingUrl.includes('/auth') || landingUrl.includes('/account/login')) &&
    !landingUrl.includes('smartapply') && !landingUrl.includes('indeedapply');
  if (isAuthWall) {
    await ss(applyPage, 'apply_auth_wall');
    console.log('  [Glassdoor] Indeed login required — click "Connect account" and log into both Indeed and Glassdoor tabs');
    return 'auth_required';
  }

  try {
    return await fillEasyApplyForm(applyPage, job, resumePath);
  } catch (err) {
    await ss(applyPage, 'apply_error').catch(() => {});
    if (/closed|detached|target/i.test(err.message)) {
      console.log('  [Glassdoor] Apply tab closed during form fill');
      return false;
    }
    throw err;
  }
}

// ── ATS detection ─────────────────────────────────────────────────────────
function _detectATS(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('greenhouse.io') || u.includes('boards.greenhouse'))   return 'greenhouse';
  if (u.includes('lever.co') || u.includes('jobs.lever'))               return 'lever';
  if (u.includes('workday') || u.includes('myworkdayjobs.com'))         return 'workday';
  if (u.includes('smartrecruiters.com'))                                 return 'smartrecruiters';
  if (u.includes('bamboohr.com'))                                        return 'bamboohr';
  if (u.includes('jobvite.com') || u.includes('hire.jobvite'))          return 'jobvite';
  if (u.includes('taleo.net'))                                           return 'taleo';
  if (u.includes('successfactors') || u.includes('sap.com/careers'))    return 'successfactors';
  if (u.includes('adp.com') || u.includes('workforcenow.adp'))          return 'adp';
  if (u.includes('icims.com'))                                           return 'icims';
  if (u.includes('oracle') && u.includes('cloud'))                      return 'oracle';
  if (u.includes('ashbyhq.com') || u.includes('jobs.ashbyhq'))          return 'ashby';
  if (u.includes('recruitee.com'))                                       return 'recruitee';
  if (u.includes('personio.'))                                           return 'personio';
  if (u.includes('workable.com'))                                        return 'workable';
  if (u.includes('pinpointhq.com'))                                      return 'pinpoint';
  if (u.includes('breezy.hr'))                                           return 'breezy';
  if (u.includes('teamtailor.com'))                                      return 'teamtailor';
  if (u.includes('rippling.com'))                                        return 'rippling';
  if (u.includes('jazz.co') || u.includes('hire.jazz'))                 return 'jazz';
  return 'generic';
}

const _ACCOUNT_REQUIRED_ATS = new Set(['workday', 'taleo', 'successfactors', 'adp', 'icims', 'oracle']);

// ── Fix 1: Click the button — don't parse hrefs ────────────────────────────
// Glassdoor's apply buttons use JS click handlers, not plain hrefs.
// We click the button and capture whatever new tab or redirect results.
async function _applyExternal(page, job, resumePath) {
  const applySelectors = [
    '[data-test="apply-button"]',
    'a:has-text("Apply on company website")',
    'a:has-text("Apply on employer site")',
    'button:has-text("Apply on company website")',
    'a:has-text("Apply Now")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
  ];

  let applyPage = null;

  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (!btn || !await btn.isVisible()) continue;

      const box = await btn.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(
          box.x + box.width * (0.3 + Math.random() * 0.4),
          box.y + box.height * (0.3 + Math.random() * 0.4),
          { steps: 10 + Math.floor(Math.random() * 8) }
        );
        await J(100, 250);
      }

      const [newTab] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
        btn.click(),
      ]);

      if (newTab) {
        await newTab.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        applyPage = newTab;
        console.log(`  [Glassdoor] Opened new tab: ${newTab.url().substring(0, 80)}`);
      } else {
        // Same-tab redirect
        await page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {});
        if (!page.url().includes('glassdoor')) applyPage = page;
      }

      if (applyPage) { console.log(`  [Glassdoor] Apply button clicked via: ${sel}`); break; }
    } catch (_) {}
  }

  if (!applyPage) {
    console.log('  [Glassdoor] Could not reach external apply page');
    return false;
  }

  await J(2000, 3500);
  await humanWarmup(applyPage);

  const finalUrl = applyPage.url();
  const ats = _detectATS(finalUrl);

  if (_ACCOUNT_REQUIRED_ATS.has(ats)) {
    console.log(`  [Glassdoor] ATS "${ats}" requires account — skipping`);
    return false;
  }

  console.log(`  [Glassdoor] External form: ${ats} | ${finalUrl.substring(0, 80)}`);
  return await _fillExternalForm(applyPage, job, resumePath, ats);
}

// ── Fix 2 + 3: Multi-step loop with AI screening question answers ──────────
async function _fillExternalForm(page, job, resumePath, ats) {
  // Some ATS land on a job-info page — click through to the actual form first
  if (['greenhouse', 'lever', 'ashby'].includes(ats)) {
    for (const sel of [
      'a:has-text("Apply for this job")', 'button:has-text("Apply for this job")',
      'a:has-text("Apply now")', '.application-button', '[data-qa="btn-apply-bottom"]',
    ]) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await J(1500, 2500); break; }
      } catch (_) {}
    }
  }

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    await J(1000, 2000);
    console.log(`  [Glassdoor] External form step ${step + 1}`);

    // Resume upload — only on first step or when a file input appears
    await _uploadResume(page, resumePath);

    // Fill all visible field types on this step
    await _fillExternalStep(page, job);

    // Submit?
    const submitted = await _tryExternalSubmit(page);
    if (submitted) return true;

    // Next/Continue?
    const advanced = await _tryExternalNext(page);
    if (!advanced) {
      console.log('  [Glassdoor] No more steps to advance through');
      break;
    }
    await J(1500, 2500);
  }

  return false;
}

async function _uploadResume(page, resumePath) {
  if (!resumePath) return;
  const fileSelectors = [
    'input[type="file"][accept*="pdf"]', 'input[type="file"][name*="resume" i]',
    'input[type="file"][name*="cv" i]',  'input[type="file"][id*="resume" i]',
    'input[type="file"][id*="cv" i]',    'input[type="file"]',
  ];
  for (const sel of fileSelectors) {
    try {
      const fi = await page.$(sel);
      if (fi) {
        const current = await fi.evaluate(el => el.files?.length || 0).catch(() => 0);
        if (!current) {
          await fi.setInputFiles(resumePath);
          await J(2000, 3500);
          console.log('  [Glassdoor] Resume uploaded');
        }
        return;
      }
    } catch (_) {}
  }
}

// Fill every visible field on the current step using rule-based matching + AI fallback
async function _fillExternalStep(page, job) {
  const { firstName, lastName, email, phone, linkedin, location,
          yearsExperience, salaryExpectation, availability,
          rightToWorkCountries } = cfg.APPLICANT;

  // ── Standard named/labelled text inputs ──
  const knownFields = [
    { val: firstName,                        sels: ['input[name="first_name"]', 'input[name="firstname"]', 'input[id*="first_name" i]', 'input[id*="firstName" i]', 'input[placeholder*="First name" i]', 'input[autocomplete="given-name"]'] },
    { val: lastName,                         sels: ['input[name="last_name"]',  'input[name="lastname"]',  'input[id*="last_name" i]',  'input[id*="lastName" i]',  'input[placeholder*="Last name" i]',  'input[autocomplete="family-name"]'] },
    { val: `${firstName} ${lastName}`.trim(),sels: ['input[name="full_name"]',  'input[name="name"]',      'input[id*="full_name" i]',  'input[placeholder*="Full name" i]',  'input[autocomplete="name"]'] },
    { val: email,                            sels: ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="Email" i]', 'input[autocomplete="email"]'] },
    { val: phone,                            sels: ['input[type="tel"]',   'input[name*="phone" i]', 'input[id*="phone" i]', 'input[placeholder*="Phone" i]', 'input[placeholder*="Mobile" i]', 'input[autocomplete="tel"]'] },
    { val: linkedin || '',                   sels: ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="LinkedIn" i]', 'input[aria-label*="LinkedIn" i]'] },
    { val: location || '',                   sels: ['input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="Location" i]', 'input[autocomplete="address-level2"]'] },
  ];

  for (const { val, sels } of knownFields) {
    if (!val) continue;
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          if (await el.inputValue().catch(() => '')) break; // already filled
          await el.click(); await J(80, 200);
          await el.type(val, { delay: 55 + Math.random() * 75 });
          await J(80, 150);
          break;
        }
      } catch (_) {}
    }
  }

  // ── Unknown text inputs — read label, answer with rules or AI ──
  const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
  for (const inp of allInputs) {
    try {
      if (!await inp.isVisible()) continue;
      if (await inp.inputValue().catch(() => '')) continue;
      const { label, placeholder } = await inp.evaluate(el => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wrapLabel = wrap?.querySelector('label, legend, [class*="label"], [class*="Label"]');
        return {
          label:       (lab?.innerText || wrapLabel?.innerText || '').trim(),
          placeholder: el.placeholder || '',
        };
      }).catch(() => ({ label: '', placeholder: '' }));

      const question = label || placeholder;
      if (!question) continue;

      const answer = await _buildExternalAnswer(question, 'text', job);
      if (answer) {
        await inp.click(); await J(80, 200);
        await inp.type(answer, { delay: 55 + Math.random() * 75 });
        await J(80, 150);
        console.log(`  [Glassdoor] Filled "${question.substring(0, 50)}" → "${answer.substring(0, 40)}"`);
      }
    } catch (_) {}
  }

  // ── Select dropdowns ──
  const selects = await page.$$('select');
  for (const sel of selects) {
    try {
      if (!await sel.isVisible()) continue;
      const currentVal = await sel.inputValue().catch(() => '');
      if (currentVal && currentVal !== '0' && currentVal !== '') continue;

      const { question, options } = await sel.evaluate(el => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wrapLabel = wrap?.querySelector('label, legend, [class*="label"]');
        const question = (lab?.innerText || wrapLabel?.innerText || el.getAttribute('aria-label') || '').trim();
        const options  = Array.from(el.options).map(o => ({ val: o.value, text: o.text.trim() })).filter(o => o.val && o.val !== '0');
        return { question, options };
      }).catch(() => ({ question: '', options: [] }));

      if (!question || !options.length) continue;

      const chosen = _pickDropdownOption(question, options) ||
        await _aiPickOption(question, options.map(o => o.text), job);

      if (chosen) {
        const match = options.find(o => o.text === chosen || o.val === chosen);
        if (match) {
          await sel.selectOption(match.val);
          await J(200, 400);
          console.log(`  [Glassdoor] Select "${question.substring(0, 40)}" → "${chosen}"`);
        }
      }
    } catch (_) {}
  }

  // ── Radio groups ──
  const radios = await page.$$('input[type="radio"]');
  const groupsSeen = new Set();
  for (const radio of radios) {
    try {
      if (!await radio.isVisible()) continue;
      const { groupName, legend, options } = await radio.evaluate(el => {
        const name   = el.name || '';
        const fieldset = el.closest('fieldset');
        const legend   = (fieldset?.querySelector('legend')?.innerText || '').trim();
        const wrap     = el.closest('[class*="question"],[class*="Question"],[class*="field"],[class*="Field"]');
        const wrapLbl  = (wrap?.querySelector('label, legend, [class*="label"]')?.innerText || '').trim();
        const allRadios = name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)) : [el];
        const options   = allRadios.map(r => {
          const lab = r.id ? document.querySelector(`label[for="${r.id}"]`) : r.closest('label');
          return { val: r.value, text: (lab?.innerText || r.value || '').trim() };
        });
        return { groupName: name, legend: legend || wrapLbl, options };
      }).catch(() => ({ groupName: '', legend: '', options: [] }));

      if (!groupName || groupsSeen.has(groupName) || !options.length) continue;
      groupsSeen.add(groupName);

      const alreadyChecked = await page.$eval(`input[type="radio"][name="${groupName}"]:checked`, () => true).catch(() => false);
      if (alreadyChecked) continue;

      const chosen = _pickRadioOption(legend, options.map(o => o.text)) ||
        await _aiPickOption(legend, options.map(o => o.text), job);

      if (chosen) {
        const match = options.find(o => o.text === chosen);
        if (match) {
          const radioEl = await page.$(`input[type="radio"][name="${groupName}"][value="${match.val}"]`);
          if (radioEl) {
            await radioEl.click();
            await J(200, 400);
            console.log(`  [Glassdoor] Radio "${legend.substring(0, 40)}" → "${chosen}"`);
          }
        }
      }
    } catch (_) {}
  }

  // ── Textareas ──
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    try {
      if (!await ta.isVisible()) continue;
      if (await ta.inputValue().catch(() => '')) continue;
      const question = await ta.evaluate(el => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wrapLabel = wrap?.querySelector('label, legend, [class*="label"]');
        return (lab?.innerText || wrapLabel?.innerText || el.placeholder || el.getAttribute('aria-label') || '').trim();
      }).catch(() => '');

      const answer = await _buildExternalAnswer(question || 'cover letter', 'textarea', job);
      if (answer) {
        await ta.click(); await J(100, 200);
        await ta.type(answer, { delay: 25 + Math.random() * 35 });
      }
    } catch (_) {}
  }

  // ── Consent checkboxes ──
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      if (!await cb.isVisible()) continue;
      const lbl = await cb.evaluate(el => {
        const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.parentElement;
        return (lab?.innerText || '').toLowerCase();
      }).catch(() => '');
      if (/agree|consent|terms|accept|gdpr|privacy|data protection/i.test(lbl) && !await cb.isChecked().catch(() => false)) {
        await J(200, 500); await cb.click();
      }
    } catch (_) {}
  }
}

async function _tryExternalSubmit(page) {
  for (const sel of [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Submit application")', 'button:has-text("Submit Application")',
    'button:has-text("Submit")', 'button:has-text("Send application")',
    '[data-qa="btn-submit"]', '.submit-btn',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        await J(500, 1000); await btn.click(); await J(3000, 5000);
        const success = await page.evaluate(() => {
          const t = (document.body?.innerText || '').toLowerCase();
          return t.includes('application submitted') || t.includes('thank you for applying') ||
                 t.includes('successfully applied')   || t.includes('application received') ||
                 t.includes('application complete')   || t.includes('we received your');
        }).catch(() => false);
        console.log(`  [Glassdoor] ${success ? '✓ External application submitted!' : 'Submitted (no confirmation text found)'}`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function _tryExternalNext(page) {
  for (const sel of [
    'button:has-text("Next")', 'button:has-text("Continue")',
    'button:has-text("Next step")', 'button:has-text("Next Step")',
    'button:has-text("Next: ")', '[data-qa="btn-next"]',
    'button[type="button"]:has-text("Next")',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        await J(300, 700); await btn.click(); await J(1500, 2500);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Fix 3: Rule-based answers + AI fallback ────────────────────────────────
async function _buildExternalAnswer(question, fieldType, job) {
  const { yearsExperience, salaryExpectation, availability, location,
          firstName, lastName, linkedin, rightToWorkCountries,
          requiresSponsorship } = cfg.APPLICANT;
  const q = (question || '').toLowerCase();

  const AVAIL_MAP = {
    'immediately': 'Immediately available',
    '1week': '1 week notice', '2weeks': '2 weeks notice',
    '1month': '1 month notice', '2months': '2 months notice', '3months': '3 months notice',
  };

  if (/cover letter|covering letter/i.test(q) || fieldType === 'textarea') {
    return `Please see my attached CV for full details of my experience and qualifications. I am genuinely excited about the ${job.title} role at ${job.company} and believe my background makes me a strong fit. I am ${AVAIL_MAP[availability || 'immediately'] || 'immediately available'} and welcome the opportunity to discuss further.`;
  }
  if (/notice period|availability|when can you start|available to start/i.test(q))
    return AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
  if (/salary|compensation|expected pay|remuneration/i.test(q))
    return salaryExpectation || '';
  if (/reloc/i.test(q))
    return cfg.APPLICANT.willingToRelocate ? 'Yes' : 'No';
  if (/year.*experience|experience.*year|how many year/i.test(q))
    return String(yearsExperience ?? 0);
  if (/right to work|eligib.*work|work.*eligib|visa.*sponsor|sponsorship.*requir/i.test(q))
    return (rightToWorkCountries || []).some(c => /uk|united kingdom|britain/i.test(c)) ? 'Yes' : 'No';
  if (/city|location|where.*based|where do you live/i.test(q))
    return (location || '').split(',')[0].trim() || location || '';
  if (/linkedin/i.test(q))  return linkedin || '';
  if (/github/i.test(q))    return '';
  if (/pronoun/i.test(q))   return '';
  if (/how did you hear|how.*find.*role|how.*learn/i.test(q)) return 'Job board / online search';
  if (/additional|tell us more|anything else|comments/i.test(q))
    return 'Please see my CV for a full overview of my experience. I am available for interview at your earliest convenience.';
  if (/why.*role|why.*company|what.*attract|motivat/i.test(q)) {
    const yrs = yearsExperience > 0 ? `${yearsExperience} years of` : 'solid';
    return `The ${job.title} position at ${job.company} closely aligns with my ${yrs} experience and I am excited about the opportunity to contribute my skills.`;
  }

  // AI fallback for anything not matched above
  if (!q) return '';
  try {
    if (await llmAvailable()) {
      const avail = AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
      const prompt =
`You are completing a job application form on behalf of ${firstName} ${lastName}.

Candidate facts:
- ${yearsExperience} years of IT support / technical services experience
- Location: ${location}
- Availability: ${avail}
- Right to work in UK: ${(rightToWorkCountries || []).some(c => /uk|united kingdom/i.test(c)) ? 'Yes' : 'No'}

Job: ${job.title} at ${job.company}

Form question: "${question}"

Write a short, professional answer (1-3 sentences). Sound natural and human. No bullet points. No mention of AI. Answer directly.`;
      const answer = await llmChat(prompt);
      if (answer?.trim()) {
        console.log(`  [Glassdoor] AI: "${question.substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        return answer.trim();
      }
    }
  } catch (e) {
    console.log(`  [Glassdoor] AI answer failed: ${e.message}`);
  }
  return '';
}

// Rule-based dropdown picker — returns the text of the best matching option
function _pickDropdownOption(question, options) {
  const q = (question || '').toLowerCase();
  const texts = options.map(o => o.text.toLowerCase());

  if (/right to work|work.*author|eligib.*work/i.test(q))
    return options.find(o => /yes|authoris|eligible|citizen/i.test(o.text))?.text || null;
  if (/notice period|availability/i.test(q)) {
    const avail = cfg.APPLICANT.availability || 'immediately';
    if (avail === 'immediately') return options.find(o => /immediate|0|none/i.test(o.text))?.text || null;
    if (avail === '1week')       return options.find(o => /1 week|one week/i.test(o.text))?.text || null;
    if (avail === '1month')      return options.find(o => /1 month|one month/i.test(o.text))?.text || null;
  }
  if (/salary|compensation/i.test(q)) return null; // handle as text
  if (/country|where.*based/i.test(q))
    return options.find(o => /united kingdom|uk$/i.test(o.text))?.text || null;
  if (/experience.*level|senior.*level|level.*experi/i.test(q)) {
    const yrs = cfg.APPLICANT.yearsExperience ?? 0;
    if (yrs >= 5) return options.find(o => /senior|mid|experienced/i.test(o.text))?.text || null;
    return options.find(o => /junior|entry|graduate/i.test(o.text))?.text || null;
  }
  return null;
}

// Rule-based radio picker — returns the text of the best option
function _pickRadioOption(question, optionTexts) {
  const q = (question || '').toLowerCase();

  if (/right to work|work.*author|eligib.*work|visa sponsor/i.test(q))
    return optionTexts.find(t => /^yes/i.test(t)) || null;
  if (/reloc/i.test(q))
    return cfg.APPLICANT.willingToRelocate
      ? optionTexts.find(t => /^yes/i.test(t)) || null
      : optionTexts.find(t => /^no/i.test(t))  || null;
  if (/currently employed|employment status/i.test(q)) {
    const avail = cfg.APPLICANT.availability || 'immediately';
    return avail === 'immediately'
      ? optionTexts.find(t => /unemployed|not employed|seeking|available/i.test(t)) || null
      : optionTexts.find(t => /employed|current/i.test(t)) || null;
  }
  if (/full.?time|part.?time/i.test(q))
    return optionTexts.find(t => /full.?time/i.test(t)) || null;
  return null;
}

// AI option picker when rule-based matching has no answer
async function _aiPickOption(question, optionTexts, job) {
  if (!question || !optionTexts.length) return null;
  try {
    if (!await llmAvailable()) return null;
    const { firstName, lastName, yearsExperience, availability, rightToWorkCountries } = cfg.APPLICANT;
    const AVAIL_MAP = { 'immediately': 'Immediately', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '3months': '3 months' };
    const prompt =
`You are completing a job application for ${firstName} ${lastName} (${yearsExperience} yrs IT support experience, availability: ${AVAIL_MAP[availability] || 'immediately'}, right to work UK: ${(rightToWorkCountries||[]).some(c=>/uk/i.test(c))}).

Question: "${question}"
Options: ${optionTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Reply with ONLY the exact text of the best option. No explanation.`;
    const reply = await llmChat(prompt);
    const cleaned = (reply || '').trim().replace(/^\d+\.\s*/, '');
    return optionTexts.find(t => t.toLowerCase() === cleaned.toLowerCase()) || null;
  } catch (_) { return null; }
}

module.exports = { ensureLoggedIn, searchJobs, getJobDescription, applyToJob };
