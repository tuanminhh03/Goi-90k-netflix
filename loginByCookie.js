// loginByCookie.js (ESM)
// Flow:
// 1) Đọc .env (NETFLIX_EMAIL, NETFLIX_PASSWORD, COOKIE_FILE)
// 2) Thử login bằng cookies -> nếu fail thì login bằng tài khoản/mật khẩu và TỰ LƯU cookies
// 3) Mở hồ sơ theo tên/ID -> ép vào /settings/lock/<ID>
// 4) Nếu thấy "Xóa khóa hồ sơ" thì gỡ trước (ƯU TIÊN REMOVE nếu cùng lúc có Remove/Edit)
// 5) Vào pinentry -> nhập PIN 4 số -> Save (tuyệt đối không click Edit PIN)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

/* ====== CONFIG ====== */
const USER_DATA_DIR = process.env.USER_DATA_DIR || './chrome-profile';
const COOKIE_FILE   = process.env.COOKIE_FILE   || './cookies.json';
const HARDCODED_PASSWORD = process.env.ACCOUNT_PASSWORD || 'minhnetflix'; // mật khẩu xác thực PIN
const NETFLIX_EMAIL    = process.env.NETFLIX_EMAIL || '';     // dùng khi cookie hỏng
const NETFLIX_PASSWORD = process.env.NETFLIX_PASSWORD || '';  // dùng khi cookie hỏng
const HOLD = process.argv.includes('--hold');

const BASE_HTTP_HEADERS = {
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
};
let __currentExtraHTTPHeaders = { ...BASE_HTTP_HEADERS };

async function applyExtraHTTPHeaders(page, headers = __currentExtraHTTPHeaders) {
  __currentExtraHTTPHeaders = { ...headers };
  await page.setExtraHTTPHeaders(__currentExtraHTTPHeaders);
}

async function withExtraHTTPHeaders(page, headers = {}, fn) {
  const previous = { ...__currentExtraHTTPHeaders };
  await applyExtraHTTPHeaders(page, { ...previous, ...headers });
  try {
    return await fn();
  } finally {
    await applyExtraHTTPHeaders(page, previous);
  }
}

/* ====== Graceful shutdown ====== */
let browser; // để cleanup dùng được
let page;
let __AUTO_FLOW = false;


async function cleanup(exitCode = 0) {
  try { await page?.close().catch(() => {}); } catch {}
  try { await browser?.close().catch(() => {}); } catch {}
  process.exit(exitCode);
}
async function holdOrExit(code = 0) {
  if (HOLD) { await new Promise(()=>{}); }
  else { await cleanup(code); }
}

process.on('SIGINT',  () => { console.log('\n🛑 SIGINT (Ctrl+C) → đóng trình duyệt...'); cleanup(0); });
process.on('SIGTERM', () => { console.log('\n🛑 SIGTERM → đóng trình duyệt...'); cleanup(0); });
process.on('uncaughtException', (err) => { console.error('💥 uncaughtException:', err); cleanup(1); });
process.on('unhandledRejection', (reason) => {
  const msg = String(reason && (reason.message || reason));
  if (/Execution context was destroyed|Cannot find context|Target closed/i.test(msg)) {
    console.warn('⚠️ Ignored benign rejection: context destroyed due to navigation.');
    return; // lỗi vô hại khi trang điều hướng
  }
  console.error('💥 unhandledRejection:', reason);
  cleanup(1);
});

/* ====== Helpers ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function raceAny(...promises) {
  const wrapped = promises.map(p => p.catch(()=>false));
  const res = await Promise.race(wrapped);
  return !!res;
}
function isBenignNavError(err) {
  const msg = String(err?.message || err);
  return /Execution context was destroyed|Cannot find context|Target closed|frame got detached|detached frame|Frame was detached/i.test(msg);
}

// ===== SELECTORS MAP =====
const S = {
  addProfile: [
    'button[data-uia="menu-card+button"][data-cl-view="addProfile"]',
    'button[data-cl-view="addProfile"]',
    '[data-uia="add-profile-button"]',
  ],
  addProfileNameInput: [
    '[data-uia="account-profiles-page+add-profile+name-input"]',
    'div[role="dialog"] [data-uia="account-profiles-page+add-profile+name-input"]',
    'input[name="name"][data-uia*="add-profile"]',
    'input[name="name"]',
  ],
  addProfileSaveBtn: [
    '[data-uia="account-profiles-page+add-profile+primary-button"]',
    'div[role="dialog"] button[data-uia*="primary-button"]',
    'div[role="dialog"] button[data-uia*="save" i]',
    'button[type="submit"]'
  ],
  deleteProfileBtn: [
    'button[data-uia="profile-settings-page+delete-profile+destructive-button"]',
    '[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-uia*="delete-profile" i]',
  ],
  removeLockBtn: [
    'button[data-uia="profile-lock-page+remove-button"]',
    'button[data-uia="profile-lock-remove-button"]',
    '[data-cl-command="RemoveProfileLockCommand"]',
  ],
  passInput: [
    '[data-uia="collect-password-input-modal-entry"]',
    'input[name="password"]', 'input[type="password"]',
    'input[autocomplete="current-password"]', 'input[autocomplete="password"]',
  ],
};
/* ====== Name Normalization (trim/lowercase/remove accents/collapse spaces) ====== */
function normalizeName(s) {
  if (!s) return '';
  return s
    .normalize('NFD')                      // tách dấu
    .replace(/[\u0300-\u036f]/g, '')      // bỏ dấu
    .toLowerCase()
    .replace(/\s+/g, ' ')                 // gộp space
    .trim();
}

/* ====== DB: đọc danh sách hồ sơ & ngày hết hạn ====== */
const PROFILE_DB_FILE = process.env.PROFILE_DB_FILE || './profiles.db.json';

function loadProfileDb(file = PROFILE_DB_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const r of arr) {
      const name = String(r.name || '').trim();
      if (!name) continue;
      const d = r.expiresAt ? new Date(r.expiresAt) : null;
      map.set(name, d && !isNaN(+d) ? d : null);
    }
    return map;
  } catch {
    console.log(`⚠️ Không đọc được ${file}. Sẽ coi như DB rỗng.`);
    return new Map();
  }
}

function isExpired(expiresAt, now = new Date(), graceDays = 0) {
  if (!expiresAt) return false;
  const end = new Date(expiresAt);
  end.setHours(23, 59, 59, 999);
  if (graceDays > 0) {
    const threshold = new Date(now);
    threshold.setDate(threshold.getDate() + graceDays);
    return end < threshold; // sắp/đã hết hạn
  }
  return now > end; // hết hạn thực sự
}

/**
 * Chọn nạn nhân để xoá theo luật:
 * - Ưu tiên: preferredVictim (nếu khớp tên)
 * - Tiếp: tên không có trong DB
 * - Tiếp: hồ sơ hết hạn/sắp hết hạn (graceDays)
 * - Nếu forceOldest: chọn expiresAt sớm nhất
 */
function pickEvictionCandidate(uiNames = [], dbMap = new Map(), opts = {}) {
  const { graceDays = 0, forceOldest = false, preferredVictim = null } = opts;

  if (preferredVictim && uiNames.includes(preferredVictim)) return preferredVictim;

  const unknown = uiNames.find(n => !dbMap.has(n));
  if (unknown) return unknown;

  let expiredBest = null;
  let expiredBestDate = null;
  for (const n of uiNames) {
    const exp = dbMap.get(n);
    if (exp && isExpired(exp, new Date(), graceDays)) {
      if (!expiredBestDate || exp < expiredBestDate) {
        expiredBest = n; expiredBestDate = exp;
      }
    }
  }
  if (expiredBest) return expiredBest;

  if (forceOldest) {
    let oldest = null, oldestDate = null;
    for (const n of uiNames) {
      const exp = dbMap.get(n);
      if (exp && (!oldestDate || exp < oldestDate)) {
        oldest = n; oldestDate = exp;
      }
    }
    if (oldest) return oldest;
  }

  return null;
}

// ===== Cache frame dialog để giảm quét =====
let __dialogFrameCache = { ts: 0, frame: null };
async function getDialogFrame(page, ttlMs = 2500) {
  const now = Date.now();
  if (__dialogFrameCache.frame && (now - __dialogFrameCache.ts) < ttlMs) return __dialogFrameCache.frame;
  for (const f of page.frames()) {
    const has = await f.$('div[role="dialog"], [data-uia="modal"]').catch(()=>null);
    if (has) { __dialogFrameCache = { ts: now, frame: f }; return f; }
  }
  __dialogFrameCache = { ts: now, frame: null };
  return null;
}

async function setReactInputValue(frame, handle, value) {
  return await frame.evaluate((el, v) => {
    function setNativeValue(element, val) {
      const { set: valueSetter } = Object.getOwnPropertyDescriptor(element, 'value') || {};
      const prototype = Object.getPrototypeOf(element);
      const { set: prototypeValueSetter } = Object.getOwnPropertyDescriptor(prototype, 'value') || {};
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, val);
      } else if (valueSetter) {
        valueSetter.call(element, val);
      } else {
        element.value = val;
      }
    }
    try {
      el.removeAttribute?.('readonly');
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeValue(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch { return false; }
  }, handle, value);
}

// chạy eval/click an toàn: nuốt lỗi do điều hướng
async function safeRun(fn, fallback = false) {
  try { return await fn(); }
  catch (e) { if (isBenignNavError(e)) return fallback; throw e; }
}

function findChromePath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(home, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  throw new Error('Không tìm thấy chrome.exe. Hãy cài Chrome hoặc set CHROME_PATH trỏ đúng file chrome.exe');
}

function loadCookies(filePath = COOKIE_FILE) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bundle = Array.isArray(raw) ? { url: 'https://www.netflix.com', cookies: raw } : raw;
    if (!Array.isArray(bundle?.cookies)) throw 0;
    const domains = new Set(bundle.cookies.map(c => c.domain || new URL(bundle.url||'https://www.netflix.com').hostname));
    console.log(`🍪 Load ${bundle.cookies.length} cookies (${domains.size} domain).`);
    return { url: bundle.url || 'https://www.netflix.com', cookies: bundle.cookies };
  } catch {
    throw new Error('cookies.json sai định dạng hoặc lỗi JSON.');
  }
}

const sameSiteMap = {
  no_restriction: 'None',
  None: 'None',
  lax: 'Lax',
  Lax: 'Lax',
  strict: 'Strict',
  Strict: 'Strict',
};

function toCookies(bundle) {
  return (bundle.cookies || []).map((c) => {
    const out = {
      name: c.name,
      value: c.value,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite ? sameSiteMap[c.sameSite] : undefined,
    };
    if (typeof c.expirationDate === 'number') {
      out.expires = Math.round(c.expirationDate);
    }
    if (c.domain) {
      out.domain = c.domain;
    } else {
      out.url = bundle.url || 'https://www.netflix.com';
    }
    if (out.sameSite === 'None' && !out.secure) out.secure = true;
    return out;
  });
}

async function saveCurrentCookies(page, filePath = COOKIE_FILE) {
  let cookies = [];
  try { cookies = await page.cookies('https://www.netflix.com/'); } catch {}
  if (!cookies?.length) { try { cookies = await page.cookies(); } catch {} }
  if (!cookies?.length) {
    console.log('⚠️ Không thu được cookie nào để lưu.');
    return false;
  }
  const out = { url: 'https://www.netflix.com', cookies };
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`💾 Đã lưu cookies vào ${filePath} (${cookies.length} items).`);
  return true;
}

async function isErrorPage(page) {
  const t = await page.evaluate(() => document.body?.innerText || '');
  return /NSES[- ]?UHX/i.test(t) || /Đã xảy ra lỗi/i.test(t) || /An error occurred/i.test(t);
}

async function gentleReveal(page) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(100);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function isLoggedIn(page) {
  await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
  const url = page.url();
  if (/\/login|signin/i.test(url)) return false;
  const hasLoginForm = await page.$('#id_userLoginId, input[name="userLoginId"]');
  if (hasLoginForm) return false;
  const txt = (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
  if (txt.includes('sign in') && (await page.$('form[action*="/login"]'))) return false;
  return true;
}

/* ====== Credential login (fallback khi cookie fail) ====== */
async function loginWithCredentials(page, email, password) {
  if (!email || !password) {
    console.log('❌ Thiếu NETFLIX_EMAIL hoặc NETFLIX_PASSWORD trong .env để đăng nhập fallback.');
    return false;
  }

  console.log('🔐 Đang đăng nhập bằng tài khoản/mật khẩu…');
  await page.goto('https://www.netflix.com/login', { waitUntil: 'networkidle2', timeout: 60000 });

  const emailSel = '#id_userLoginId, input[name="userLoginId"]';
  const passSel  = '#id_password, input[name="password"]';
  const btnSel   = 'button[type="submit"]';

  const emailBox = await page.waitForSelector(emailSel, { visible: true, timeout: 15000 }).catch(()=>null);
  const passBox  = await page.waitForSelector(passSel,  { visible: true, timeout: 15000 }).catch(()=>null);
  if (!emailBox || !passBox) {
    console.log('❌ Không tìm thấy form đăng nhập.');
    return false;
  }

  await emailBox.click({ clickCount: 3 });
  await page.keyboard.type(email, { delay: 30 });
  await passBox.click({ clickCount: 3 });
  await page.keyboard.type(password, { delay: 30 });

  const btn = await page.$(btnSel);
  if (btn) { try { await btn.click({ delay: 20 }); } catch {} } else { await page.keyboard.press('Enter'); }

  const ok = await raceAny(
    page.waitForFunction(() => /\/(browse|profiles|account)/i.test(location.pathname), { timeout: 30000 }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).then(()=>/\/(browse|profiles|account)/i.test(page.url()))
  );

  if (!ok) {
    console.log('⚠️ Không xác nhận được đăng nhập (có thể cần xác minh/MFA).');
    if (await isLoggedIn(page)) return true;
    return false;
  }

  console.log('✅ Đăng nhập thành công bằng tài khoản/mật khẩu.');
  await saveCurrentCookies(page, COOKIE_FILE);
  return true;
}

/* ============== Quét & mở hồ sơ theo tên ============== */
async function getProfileNames(page) {
  return await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-cl-view="accountProfileSettings"]'));
    const names = blocks.map((b, i) =>
      (b.querySelector('p')?.textContent || b.textContent || `Hồ sơ ${i + 1}`)
        .trim()
        .split('\n')[0]
    );
    const seen = new Set();
    return names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  });
}

async function resolveProfileTarget(page, profileName) {
  return await page.evaluate((name) => {
    const blocks = Array.from(document.querySelectorAll('[data-cl-view="accountProfileSettings"]'));
    const block = blocks.find((b) => {
      const first =
        ((b.querySelector('p')?.textContent || b.textContent || '') + '')
          .trim()
          .split('\n')[0];
      return first === name;
    });
    if (!block) return null;

    const li = block.closest('li') || block.parentElement;
    const btn =
      (li && li.querySelector('button[data-uia$="PressableListItem"]')) ||
      block.closest('button[data-uia$="PressableListItem"]') ||
      block.querySelector('button[data-uia$="PressableListItem"]') ||
      block;

    const r = btn.getBoundingClientRect();
    return {
      selector: btn.getAttribute('data-uia')
        ? `button[data-uia="${btn.getAttribute('data-uia')}"]`
        : null,
      rect: { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2) },
    };
  }, profileName);
}

async function dispatchRealClick(page, selector) {
  if (!selector) return false;
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }, selector);
}

function extractSettingsId(u) {
  const m = u.match(/\/settings\/([^/?#]+)/i);
  return m ? m[1] : null;
}

async function openProfileAndGetId(page, profileName, retries = 5) {
  for (let i = 1; i <= retries; i++) {
    console.log(`👉 Mở hồ sơ ${profileName} (lần ${i}/${retries})`);
    const target = await resolveProfileTarget(page, profileName);
    if (!target) {
      console.log('❌ Không thấy hồ sơ:', profileName);
      return null;
    }
    await page.evaluate(
      ({ x, y }) => window.scrollTo(0, Math.max(0, y - window.innerHeight / 2)),
      target.rect
    );
    const didDispatch = await dispatchRealClick(page, target.selector);
    if (!didDispatch) {
      await page.mouse.move(target.rect.x, target.rect.y, { steps: 6 });
      await page.mouse.down(); await sleep(30); await page.mouse.up();
    }
    await raceAny(
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
      page.waitForFunction(() => /\/settings\//i.test(location.pathname), { timeout: 8000 })
    );
    if (await isErrorPage(page)) {
      console.log('⚠️ Trang lỗi sau khi mở hồ sơ → reload…');
      try { await page.goto(page.url(), { waitUntil: 'networkidle2', timeout: 60000 }); } catch {}
    }
    const id = extractSettingsId(page.url());
    if (id) {
      const settingsUrl = page.url();
      console.log('✅ Lấy được settingsId:', id, '(', settingsUrl, ')');
      return { id, settingsUrl };
    }
    await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 });
    await gentleReveal(page);
    await sleep(300 + i * 200);
  }
  console.log('❌ Không lấy được settingsId cho:', profileName);
  return null;
}

/* ============== Click helpers ============== */
// ====== Add Profile (Thêm hồ sơ) ======
async function clickAddProfileButton(page, { timeoutMs = 8000 } = {}) {
  const SELECTORS = S.addProfile;
  const KEYWORDS = ['thêm hồ sơ', 'them ho so', 'add profile', 'new profile'];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of SELECTORS) {
      const hit = await queryInAllFrames(page, sel);
      if (hit?.handle) {
        await robustClickHandle(page, hit.handle);
        // chờ hoặc modal hoặc điều hướng /add
        await raceAny(
          page.waitForFunction(() =>
            !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]'))),
          page.waitForFunction(() =>
            /(\/profiles\/add|\/addprofile|\/createprofile)/i.test(location.pathname)),
          page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        );
        return true;
      }
    }
    const byText = await findButtonByTextAnyFrame(page, KEYWORDS);
    if (byText?.handle) {
      await robustClickHandle(page, byText.handle);
      await raceAny(
        page.waitForFunction(() =>
          !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]'))),
        page.waitForFunction(() =>
          /(\/profiles\/add|\/addprofile|\/createprofile)/i.test(location.pathname)),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      );
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function waitForAddProfileModal(page, { timeoutMs = 12000 } = {}) {
  const ok = await raceAny(
    page.waitForFunction(() =>
      !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')), { timeout: timeoutMs }
    ),
    page.waitForFunction(() =>
      !!(document.querySelector('input[name="profileName"]') ||
         document.querySelector('form[action*="addProfile" i]') ||
         document.querySelector('[data-uia*="add-profile" i]')), { timeout: timeoutMs }
    ),
    page.waitForFunction(() =>
      /(\/profiles\/add|\/addprofile|\/createprofile)/i.test(location.pathname), { timeout: timeoutMs }
    )
  );
  return !!ok;
}

// Tìm input trong toàn bộ frame + shadow DOM + fallback set value trực tiếp
async function typeNewProfileName(page, name) {
  const SEL = S.addProfileNameInput.join(',');

  // chờ input xuất hiện (modal hoặc trang /profiles/add)
  const handle = await page.waitForSelector(SEL, { visible: true, timeout: 12000 }).catch(()=>null);
  if (!handle) return false;

  // thử gõ thường trước
  try {
    await handle.click({ clickCount: 3 });
    await handle.type(name, { delay: 30 });
    return true;
  } catch {}

  // fallback React-controlled
  const ok = await setReactInputValue(page.mainFrame(), handle, name);
  if (ok) return true;

  // fallback cuối
  const ok2 = await page.evaluate((v) => {
    const el =
      document.querySelector('[data-uia="account-profiles-page+add-profile+name-input"]') ||
      document.querySelector('input[name="name"][data-uia*="add-profile"]') ||
      document.querySelector('input[name="name"]') ||
      null;
    if (!el) return false;
    const { set: valueSetter } = Object.getOwnPropertyDescriptor(el, 'value') || {};
    const proto = Object.getPrototypeOf(el);
    const { set: protoSetter } = Object.getOwnPropertyDescriptor(proto, 'value') || {};
    const setNative = (val) => (protoSetter && valueSetter !== protoSetter) ? protoSetter.call(el, val) : (valueSetter ? valueSetter.call(el, val) : (el.value = val));
    try {
      setNative('');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      setNative(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch { return false; }
  }, name);
  return !!ok2;
}

async function setKidsToggleIfNeeded(page, isKids=false) {
  const TOGGLE_CANDIDATES = [
    'div[role="dialog"] [data-uia*="kids" i]',
    'div[role="dialog"] [aria-label*="trẻ" i], div[role="dialog"] [aria-label*="kids" i]',
    'div[role="dialog"] input[type="checkbox"]',
  ];
  if (typeof isKids !== 'boolean') return true;

  for (const sel of TOGGLE_CANDIDATES) {
    const hit = await queryInAllFrames(page, sel);
    if (hit?.handle) {
      const state = await hit.frame.evaluate(el => {
        if (el.tagName === 'INPUT' && el.type === 'checkbox') return el.checked;
        const pressed = el.getAttribute('aria-pressed');
        const checked = el.getAttribute('aria-checked');
        if (pressed != null) return pressed === 'true';
        if (checked != null) return checked === 'true';
        return null;
      }, hit.handle).catch(()=>null);
      if (state === null) return true;
      if (state !== isKids) {
        await robustClickHandle(page, hit.handle);
      }
      return true;
    }
  }
  return true;
}

async function clickSaveNewProfile(page) {
  // 1) Đảm bảo input đã có tên để nút được enable
  await page.evaluate(() => {
    const inp = document.querySelector('[data-uia="account-profiles-page+add-profile+name-input"]') 
             || document.querySelector('input[name="name"]');
    if (!inp) return;
    const fire = (t) => inp.dispatchEvent(new Event(t, { bubbles: true }));
    fire('input'); fire('change');
  }).catch(()=>{});

  // 2) Đóng toast/snackbar che nút (nếu có)
  await page.evaluate(() => {
    const sels = ['[data-uia*="toast"] [data-uia*="close"]','[aria-label*="đóng" i]','[aria-label*="close" i]'];
    sels.forEach(s => document.querySelectorAll(s).forEach(b => { try { b.click(); } catch {} }));
  }).catch(()=>{});

  // 3) Tìm & click Save
  const selectors = S.addProfileSaveBtn;

  const frames = page.frames();
  for (const f of frames) {
    for (const sel of selectors) {
      let btn = null;
      try { btn = await f.$(sel); } catch {}
      if (!btn) continue;

      try {
        const enabled = await f.evaluate((el) => {
          const st = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const notDisabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
          return notDisabled && st.visibility !== 'hidden' && st.display !== 'none' && rect.width > 1 && rect.height > 1;
        }, btn);
        if (!enabled) continue;
      } catch {}

      try { await f.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), btn); } catch {}

      try {
        await f.evaluate(el => {
          el.focus();
          const o = { bubbles: true, cancelable: true, view: window, buttons: 1 };
          el.dispatchEvent(new PointerEvent('pointerdown', o));
          el.dispatchEvent(new MouseEvent('mousedown', o));
          el.dispatchEvent(new MouseEvent('mouseup', o));
          el.dispatchEvent(new PointerEvent('pointerup', o));
          el.click();
        }, btn);
      } catch {
        try { await btn.click({ delay: 20 }); } catch {}
      }

      const ok = await raceAny(
        f.waitForFunction(() =>
          !document.querySelector('div[role="dialog"]') && !document.querySelector('[data-uia="modal"]'), { timeout: 5000 }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }),
        page.waitForResponse(res => {
          const u = res.url().toLowerCase();
          return res.status() >= 200 && res.status() < 300 &&
                 /(add.*profile|create.*profile|profiles\/(add|create)|profile.*save)/.test(u);
        }, { timeout: 5000 })
      );

      if (ok) return true;

      // fallback submit
      try {
        const submitted = await f.evaluate((el) => {
          const form = el.closest('form');
          if (!form) return false;
          if (form.requestSubmit) { form.requestSubmit(); return true; }
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return true;
        }, btn);
        if (submitted) {
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(()=>{});
          return true;
        }
      } catch {}
    }
  }

  // 5) Enter
  try {
    const input = await page.$(S.addProfileNameInput.join(','));
    if (input) { await input.focus(); await page.keyboard.press('Enter'); }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(()=>{});
  } catch {}

  return false;
}

/**
 * Tạo hồ sơ mới. Trả về { ok, settingsId }.
 * Nếu tạo xong, sẽ mở luôn trang /settings/<ID> để bạn dễ thao tác tiếp.
 */
async function addProfile(page, name, { isKids = false } = {}) {
  if (!name || !name.trim()) { console.log('❌ Thiếu tên hồ sơ.'); return { ok:false, settingsId:null }; }

  // 1) Tới trang danh sách hồ sơ
  await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
  await gentleReveal(page);

  // 2) Bấm "Thêm hồ sơ"
  console.log('➕ Mở modal "Thêm hồ sơ"…');
  const opened = await clickAddProfileButton(page);
  if (!opened) { console.log('❌ Không bấm được "Thêm hồ sơ".'); return { ok:false, settingsId:null }; }

  // 3) Chờ modal & nhập tên
  const hasModal = await waitForAddProfileModal(page);
  if (!hasModal) { console.log('❌ Modal "Thêm hồ sơ" không xuất hiện.'); return { ok:false, settingsId:null }; }

  const typed = await typeNewProfileName(page, name.trim());
  if (!typed) { console.log('❌ Không nhập được tên hồ sơ.'); return { ok:false, settingsId:null }; }

  // 4) Kids (tuỳ chọn)
  await setKidsToggleIfNeeded(page, isKids);

  const didSaveProfile = await clickSaveNewProfile(page);
  if (!didSaveProfile) { console.log('❌ Không bấm được nút Lưu.'); return { ok:false, settingsId:null }; }

  // 6) Đợi modal đóng / danh sách cập nhật
  await raceAny(
    page.waitForFunction(() => !document.querySelector('div[role="dialog"]') && !document.querySelector('[data-uia="modal"]'), { timeout: 8000 }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
  );

  // 7) Xác nhận tên xuất hiện trong danh sách + lấy settingsId
  await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
  await gentleReveal(page);
  const names = await getProfileNames(page);
  if (!names.includes(name)) {
    console.log('⚠️ Không thấy hồ sơ vừa tạo trong danh sách. Danh sách:', names);
    // vẫn thử mở nếu Netflix lazy-update UI
  }

  // Mở chính hồ sơ mới để lấy settingsId
  const openedProfile = await openProfileAndGetId(page, name, 5);
  if (!openedProfile) {
    console.log('⚠️ Tạo có vẻ OK nhưng không lấy được settingsId.');
    return { ok: true, settingsId: null };
  }

  // Đứng lại ở trang /settings/<ID> để tiện làm tiếp (đặt PIN…)
  await hardGotoSettings(page, openedProfile.id, openedProfile.settingsUrl);
  return { ok: true, settingsId: openedProfile.id };
}

async function clickWithAllTricks(page, handle) {
  try { await page.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), handle); } catch {}
  try { await page.evaluate(el => el.click(), handle); return true; } catch {}
  try { await handle.click({ delay: 20 }); return true; } catch {}
  try {
    await page.evaluate(el => {
      el.focus();
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    }, handle);
    return true;
  } catch {}
  try {
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width/2, box.y + box.height/2, { steps: 6 });
      await page.mouse.down(); await sleep(30); await page.mouse.up();
      return true;
    }
  } catch {}
  return false;
}

async function queryInAllFrames(page, selector) {
  const frames = page.frames();
  for (const f of frames) {
    try {
      const h = await f.$(selector);
      if (h) return { frame: f, handle: h };
    } catch (e) {
      const msg = String(e && (e.message || e));
      if (!/Execution context was destroyed|Cannot find context|Target closed/i.test(msg)) {
        // swallow quietly
      }
    }
  }
  return null;
}

// Bấm "Xóa hồ sơ" lần 2 trong modal (đúng selector Netflix dùng cho destructive)
async function clickSecondDeleteButton(page, { timeoutMs = 6000 } = {}) {
  const SELECTOR =
    'button[data-uia="profile-settings-page+delete-profile+destructive-button"][data-cl-view="deleteProfile"]';

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Ưu tiên frame có dialog
    const f = await getDialogFrame(page);
    if (f) {
      const btn = await f.$(SELECTOR);
      if (btn) {
        try { await f.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), btn); } catch {}
        try { await btn.click({ delay: 20 }); return true; } catch {}
        try {
          await f.evaluate(el => {
            el.focus();
            const o = { bubbles:true, cancelable:true, view:window, buttons:1 };
            el.dispatchEvent(new PointerEvent('pointerdown', o));
            el.dispatchEvent(new MouseEvent('mousedown', o));
            el.dispatchEvent(new MouseEvent('mouseup', o));
            el.dispatchEvent(new PointerEvent('pointerup', o));
            el.dispatchEvent(new MouseEvent('click', o));
          }, btn);
          return true;
        } catch {}
      }
    }

    // Fallback: main frame
    const btnMain = await page.$(SELECTOR).catch(()=>null);
    if (btnMain) {
      try { await page.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), btnMain); } catch {}
      try { await btnMain.click({ delay: 20 }); return true; } catch {}
    }

    await sleep(120);
  }
  return false;
}

// Tìm nút theo TEXT ở mọi frame
async function findButtonByTextAnyFrame(page, keywords = []) {
  const frames = page.frames();
  const lows = keywords.map(k => k.toLowerCase());
  for (const f of frames) {
    const handles = await f.$$('button, [role="button"]');
    for (const h of handles) {
      let txt = '';
      try {
        txt = await f.evaluate(el => (el.textContent || '').trim().toLowerCase(), h);
      } catch {}
      if (!txt) continue;
      if (lows.some(k => txt.includes(k))) {
        return { frame: f, handle: h, text: txt };
      }
    }
  }
  return null;
}

async function findFirstVisibleInFrames(page, selectors = []) {
  for (const sel of selectors) {
    const hit = await queryInAllFrames(page, sel);
    if (hit) return hit;
  }
  return null;
}

async function typeProfileNameInConfirmDialog(page, name) {
  if (!name) return false;
  const INPUT_SELECTORS = [
    'div[role="dialog"] input[type="text"]',
    'div[role="dialog"] input',
    '[data-uia="modal"] input[type="text"]',
    '[data-uia="modal"] input',
  ];
  for (let t = 0; t < 10; t++) {
    for (const sel of INPUT_SELECTORS) {
      const hit = await queryInAllFrames(page, sel);
      if (hit?.handle) {
        try { await hit.frame.evaluate(el => el.focus(), hit.handle); } catch {}
        try { await hit.handle.click({ clickCount: 3 }); } catch {}
        try { await hit.handle.type(name, { delay: 40 }); } catch {}
        return true;
      }
    }
    await sleep(200);
  }
  return false;
}

async function confirmDangerInDialog(page) {
  const btn =
    await findButtonByTextAnyFrame(page, ['xóa hồ sơ','xoá hồ sơ','delete profile','delete','ok','confirm','yes','có']) ||
    await findFirstVisibleInFrames(page, ['div[role="dialog"] button','[data-uia="modal"] button']);
  if (btn?.handle) {
    await robustClickHandle(page, btn.handle);
    return true;
  }
  return false;
}

/* ===== Generic: tìm nút theo selector hoặc theo từ khoá TRÊN MỌI FRAME ===== */
async function findButtonAnyFrame(page, selectors = [], keywords = []) {
  for (const sel of selectors) {
    const found = await queryInAllFrames(page, sel);
    if (found) return found;
  }
  const frames = page.frames();
  for (const f of frames) {
    const nodes = await f.$$('button, [role="button"]');
    for (const n of nodes) {
      const t = (await f.evaluate(el => el.textContent || '', n)).trim().toLowerCase();
      if (keywords.some(k => t.includes(k))) {
        return { frame: f, handle: n };
      }
    }
  }
  return null;
}

/* ===== Identity verify modal ===== */
async function handleIdentityVerifyModal(page, password) {
  for (let i = 0; i < 12; i++) {
    const open = await page.evaluate(() => !!(document.querySelector('[role="dialog"], [data-uia="modal"]'))).catch(()=>false);
    if (open) break;
    await sleep(500);
  }

  const passOption = await findButtonByTextAnyFrame(page, [
    'xác nhận mật khẩu','confirm with password','verify with password','password','mật khẩu'
  ]);
  if (passOption?.handle) {
    try { await passOption.frame.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), passOption.handle); } catch {}
    await robustClickHandle(page, passOption.handle);
  }

  let passField = null;
  for (let t = 0; t < 20 && !passField; t++) {
    for (const sel of S.passInput) {
      const hit = await queryInAllFrames(page, sel);
      if (hit?.handle) { passField = hit; break; }
    }
    if (!passField) await sleep(250);
  }
  if (!passField) return false;

  try { await passField.frame.evaluate(el => el.focus(), passField.handle); } catch {}
  try { await passField.handle.click({ clickCount: 2 }); } catch {}
  try { await passField.handle.type(password, { delay: 40 }); } catch {}
  try { await page.keyboard.press('Enter'); } catch {}

  for (let i = 0; i < 20; i++) {
    const open = await page.evaluate(() => !!(document.querySelector('[role="dialog"], [data-uia="modal"]'))).catch(()=>false);
    if (!open) return true;
    await sleep(300);
  }
  return false;
}

async function waitForProfileDeletedSuccess(page, timeout = 15000) {
  return await page
    .waitForFunction(() => {
      try {
        const u = new URL(location.href);
        return u.pathname.includes('/account/profiles')
            && u.searchParams.get('profileDeleted') === 'success';
      } catch { return false; }
    }, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function waitForProfilePinDeletedSuccess(page, timeout = 15000) {
  return await page
    .waitForFunction(() => {
      try {
        const u = new URL(location.href);
        const ok =
          u.searchParams.get('profilePinDeleted') === 'success' ||
          u.searchParams.get('profileLockRemoved') === 'true' ||
          u.searchParams.get('profileLock') === 'removed' ||
          u.searchParams.get('pinDeleted') === 'success';
        const onSettings = /\/settings\/[A-Z0-9]+/i.test(u.pathname);
        const onProfiles = /\/account\/profiles/i.test(u.pathname);
        return ok && (onSettings || onProfiles);
      } catch { return false; }
    }, { timeout })
    .then(() => true)
    .catch(() => false);
}

async function clickCreateProfileLockAnyFrame(page) {
  const SEL = 'button[data-uia="profile-lock-off+add-button"], button[data-cl-command="AddProfileLockCommand"]';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const found = await queryInAllFrames(page, SEL);
    if (!found) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
      await sleep(300);
      continue;
    }
    const { frame, handle } = found;
    try { await frame.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), handle); } catch {}
    try { await handle.click({ delay: 20 }); return true; } catch {}
    try {
      await frame.evaluate(el => {
        el.focus();
        const o = { bubbles: true, cancelable: true, view: window, buttons: 1 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new PointerEvent('pointerup', o));
        el.dispatchEvent(new MouseEvent('click', o));
      }, handle);
      return true;
    } catch {}
    try {
      const box = await handle.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
        await page.mouse.down(); await sleep(30); await page.mouse.up();
        return true;
      }
    } catch {}
    await sleep(300);
  }
  return false;
}

async function robustClickHandle(page, handle) {
  try { await page.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }), handle); } catch {}
  try { await handle.click({ delay: 20 }); return true; } catch {}
  try {
    await page.evaluate((el) => {
      el.focus();
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    }, handle);
    return true;
  } catch {}
  try {
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
      await page.mouse.down(); await sleep(30); await page.mouse.up();
      return true;
    }
  } catch {}
  return false;
}

// ==== Điều hướng cứng vào /settings/<ID> (không phải lock) ====
async function hardGotoSettings(page, settingsId, refererUrl) {
  const settingsUrl = `https://www.netflix.com/settings/${settingsId}`;
  const refererHeaders = refererUrl ? { Referer: refererUrl } : {};

  return await withExtraHTTPHeaders(page, refererHeaders, async () => {
    const tryOnce = async (how) => {
      if (how === 'goto')
        await page.goto(settingsUrl, {
          waitUntil: 'networkidle2',
          timeout: 60000,
          ...(refererUrl ? { referer: refererUrl } : {}),
        }).catch(()=>{});
      else if (how === 'href')
        await page.evaluate((u)=>{ location.href = u; }, settingsUrl).catch(()=>{});
      else if (how === 'assign')
        await page.evaluate((u)=>{ window.location.assign(u); }, settingsUrl).catch(()=>{});

      await raceAny(
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
        page.waitForFunction(
          (id)=> new RegExp(`/settings/${id}($|[/?#])`).test(location.pathname),
          { timeout: 8000 }, settingsId
        )
      );

      if (await isErrorPage(page)) {
        console.log('⚠️ Trang lỗi khi vào settings → reload…');
        await page.goto(page.url(), { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
      }
      return new RegExp(`/settings/${settingsId}($|[/?#])`).test(page.url());
    };

    if (await tryOnce('goto'))   return true;
    if (await tryOnce('href'))   return true;
    if (await tryOnce('assign')) return true;
    return false;
  });
}

// ==== Tìm nút "Xóa hồ sơ" trên mọi frame ====
async function findDeleteProfileButtonAnyFrame(page) {
  const hit = await findFirstVisibleInFrames(page, S.deleteProfileBtn);
  if (hit) return hit;
  const byText = await findButtonByTextAnyFrame(page, ['xóa hồ sơ','xoá hồ sơ','delete profile']);
  return byText || null;
}

// ==== Nếu hiện dialog/sheet xác nhận thì tick checkbox & bấm xác nhận ====
async function clickConfirmDeleteDialogsIfAny(page) {
  // luôn clear cache frame dialog trước khi thao tác
  __dialogFrameCache = { ts: 0, frame: null };

  // tick checkbox nếu có
  for (const sel of [
    'div[role="dialog"] input[type="checkbox"]',
    '[data-uia="modal"] input[type="checkbox"]',
    'div[role="dialog"] [role="checkbox"]'
  ]) {
    try {
      const f = await getDialogFrame(page, 0);
      if (f) {
        const boxes = await f.$$(sel).catch(() => []);
        for (const b of boxes) {
          await safeRun(() => f.evaluate(el => {
            if (el.getAttribute?.('aria-checked') === 'false') el.click();
            if (el instanceof HTMLInputElement && !el.checked) el.click();
          }, b));
        }
      }
    } catch {}
  }

  // tìm & click nút xác nhận
  const findAndClick = async () => {
    const hit =
      await findButtonByTextAnyFrame(page, ['xóa hồ sơ','xoá hồ sơ','delete profile','delete','ok','confirm','yes','có']) ||
      await findFirstVisibleInFrames(page, ['div[role="dialog"] button','[data-uia="modal"] button']);
    if (hit?.handle) {
      await safeRun(() => robustClickHandle(page, hit.handle));
      return true;
    }
    return false;
  };

  for (let i = 0; i < 5; i++) {
    const ok = await findAndClick();
    if (ok) return true;
    await sleep(150);
    __dialogFrameCache = { ts: 0, frame: null };
  }
  return false;
}


async function singleClick(page, handle) {
  try { await page.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), handle); } catch {}
  try { await page.evaluate(el => el.click(), handle); return true; } catch {}
  try { await handle.click(); return true; } catch {}
  return false;
}

async function atomicOpenAndConfirmDelete(page, profileNameForConfirm = null, timeoutMs = 2500) {
  const ok = await page.evaluate(async (profileName, timeout) => {
    const openBtn =
      document.querySelector('button[data-uia="profile-settings-page+delete-profile+destructive-button"]') ||
      document.querySelector('[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]') ||
      document.querySelector('button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]');
    if (!openBtn) return false;
    openBtn.click();

    const start = Date.now();
    function findDialog() {
      return document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]');
    }
    while (!findDialog()) {
      if (Date.now() - start > timeout) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    const dialog = findDialog();

    try { document.documentElement.style.overflow = 'hidden'; } catch {}

    dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach(el => {
      try {
        if (el instanceof HTMLInputElement) {
          if (!el.checked) el.click();
        } else {
          if (el.getAttribute('aria-checked') === 'false') el.click();
        }
      } catch {}
    });

    if (profileName) {
      const inp = dialog.querySelector('input[type="text"], input');
      if (inp) {
        try {
          inp.focus();
          inp.value = '';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.value = profileName;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } catch {}
      }
    }

    const btns = Array.from(dialog.querySelectorAll('button, [role="button"]'));
    const danger =
      btns.find(b => /xóa hồ sơ|xoá hồ sơ|delete profile/i.test(b.textContent || '')) ||
      btns.find(b => /delete|ok|confirm|yes|có/i.test(b.textContent || ''));
    if (danger) {
      danger.click();
      return true;
    }
    return false;
  }, profileNameForConfirm, timeoutMs);

  return !!ok;
}

function __isClickable(el) {
  if (!el) return false;
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  if (el.disabled) return false;
  return true;
}

function __queryDeep(root, selectors) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.querySelector) {
      for (const sel of selectors) {
        const found = node.querySelector(sel);
        if (found) return found;
      }
    }
    if (node.shadowRoot) stack.push(node.shadowRoot);
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return null;
}

async function closeOverlaysIfAny(page) {
  await page.evaluate(() => {
    const candidates = [
      '[data-uia*="toast"] [data-uia*="close"]',
      '[data-uia*="message"] [data-uia*="close"]',
      '[aria-label*="đóng" i]',
      '[aria-label*="close" i]',
    ];
    for (const sel of candidates) {
      document.querySelectorAll(sel).forEach(btn => { try { btn.click(); } catch {} });
    }
  }).catch(()=>{});
}

async function findDialogAnyFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    const handle = await f.$('div[role="dialog"], [data-uia="modal"]');
    if (handle) return { frame: f, handle };
  }
  return null;
}

// === 1) Click nút “Xóa hồ sơ” TRÊN TRANG /settings/<ID> (global) ===
async function clickDeleteProfileButtonStrict(page, { retry = 3 } = {}) {
  const SELECTORS = S.deleteProfileBtn;
  const KEYWORDS = ['xóa hồ sơ','xoá hồ sơ','delete profile','delete'];

  for (let i = 0; i < retry; i++) {
    const ok = await page.mainFrame().evaluate(({ SELECTORS, KEYWORDS }) => {
      const visible = el => {
        if (!el) return false;
        const st = getComputedStyle(el), r = el.getBoundingClientRect();
        return st.display!=='none' && st.visibility!=='hidden' && r.width>1 && r.height>1 && !el.disabled;
      };
      let btn = null;
      for (const sel of SELECTORS) {
        const cand = document.querySelector(sel);
        if (cand && visible(cand)) { btn = cand; break; }
      }
      if (!btn) {
        btn = Array.from(document.querySelectorAll('button,[role="button"]'))
          .find(b => visible(b) && KEYWORDS.some(k => (b.textContent||'').toLowerCase().includes(k)));
      }
      if (!btn) return false;
      try { btn.scrollIntoView({block:'center', inline:'center'}); } catch {}
      try { btn.focus(); } catch {}
      btn.click();
      return true;
    }, { SELECTORS, KEYWORDS }).catch(() => false);

    if (ok) return true;
    await sleep(150);
  }
  return false;
}

// === 2) Click nút "Xóa hồ sơ" TRONG MODAL ===
async function clickConfirmDeleteInDialog(page, timeoutMs = 6000) {
  const hasDialog = await page.waitForFunction(() =>
    !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
  if (!hasDialog) return false;

  await page.evaluate(() => {
    const sel = ['[data-uia*="toast"] [data-uia*="close"]','[aria-label*="đóng" i]','[aria-label*="close" i]'];
    sel.forEach(s => document.querySelectorAll(s).forEach(b => { try { b.click(); } catch {} }));
  }).catch(()=>{});

  await page.evaluate(() => {
    const trap = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
      }
    };
    window.__nfDelTrap && document.removeEventListener('keydown', window.__nfDelTrap, true);
    window.__nfDelTrap = trap;
    document.addEventListener('keydown', trap, true);
  });

  const clicked = await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]');
    if (!dialog) return false;

    try { document.documentElement.style.overflow = 'hidden'; } catch {}
    try { dialog.scrollTop = dialog.scrollHeight; } catch {}

    const visible = el => {
      const st = getComputedStyle(el), r = el.getBoundingClientRect();
      return st.display!=='none' && st.visibility!=='hidden' && r.width>1 && r.height>1 && !el.disabled;
    };

    const btns = Array.from(dialog.querySelectorAll('button,[role="button"]'));
    const target =
      btns.find(b => /xóa hồ sơ|xoá hồ sơ/i.test((b.textContent||'').trim())) ||
      btns.find(b => /delete/i.test((b.textContent||'').trim()));
    if (!target || !visible(target)) return false;

    try { target.scrollIntoView({block:'center', inline:'center'}); } catch {}
    try { target.focus(); } catch {}
    target.click();
    return true;
  }).catch(() => false);

  await page.evaluate(() => {
    if (window.__nfDelTrap) {
      document.removeEventListener('keydown', window.__nfDelTrap, true);
      window.__nfDelTrap = null;
    }
  }).catch(()=>{});

  return !!clicked;
}

/* ============== XÓA HỒ SƠ – chỉ thao tác trên /settings/<ID> ============== */
async function deleteProfileBySettingsId(
  page,
  settingsId,
  password,
  refererUrl,
  profileNameForConfirm = null
) {
  // Điều hướng tới trang cài đặt hồ sơ
  const ok = await hardGotoSettings(page, settingsId, refererUrl);
  if (!ok) {
    console.log('❌ Không vào được trang settings.');
    return false;
  }

  // 1) Click nút “Xóa hồ sơ” để mở overlay (dùng bản global)
  console.log('🗑️ Tìm & bấm nút "Xóa hồ sơ"…');
  const ok1 = await safeRun(() => clickDeleteProfileButtonStrict(page, { retry: 3 }), false);
  await safeRun(() => Promise.race([
    page.waitForFunction(() =>
      !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
      { timeout: 8000 }
    ),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
  ]), null);

  // 2) Chờ overlay (modal) xuất hiện
  const overlayOk = await page.waitForFunction(() =>
    !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
    { timeout: 4000 }
  ).then(() => true).catch(() => false);
  if (!overlayOk) {
    console.log('⚠️ Overlay xác nhận không hiện. Thử click lại…');
    if (!await clickDeleteProfileButtonStrict(page, { retry: 2 })) {
      console.log('❌ Không mở được overlay xác nhận.');
      return false;
    }
    await page.waitForFunction(() =>
      !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
      { timeout: 4000 }
    ).catch(() => {});
  }

  console.log('🗑️ Bấm "Xóa hồ sơ" trong modal xác nhận…');
  const ok2 = await safeRun(() => clickSecondDeleteButton(page, { timeoutMs: 6000 }), false);
  // KHÔNG giữ handle cũ: modal có thể detach frame → luôn bọc safeRun
__dialogFrameCache = { ts: 0, frame: null };

await safeRun(() => typeProfileNameInConfirmDialog(page, profileNameForConfirm), false);
await safeRun(() => clickConfirmDeleteDialogsIfAny(page), false);
await safeRun(() => confirmDangerInDialog(page), false);
await safeRun(() => handleIdentityVerifyModal(page, password), false);

  if (!ok2) {
    await closeOverlaysIfAny(page);
    const retry = await safeRun(() => clickSecondDeleteButton(page, { timeoutMs: 6000 }), false);
    if (!retry) return false;
  }

  await typeProfileNameInConfirmDialog(page, profileNameForConfirm); // nếu cần gõ tên
  await clickConfirmDeleteDialogsIfAny(page); // tick checkbox / nút OK phụ
  await confirmDangerInDialog(page);          // phòng khi Netflix render thêm nút xác nhận
  await handleIdentityVerifyModal(page, password); // bắt case yêu cầu nhập mật khẩu

  // 6) Chờ tín hiệu đã xóa hoặc quay về danh sách hồ sơ
  const redirected = await raceAny(
    page.waitForFunction(() => /\/account\/profiles/i.test(location.pathname), { timeout: 15000 }),
    page.waitForResponse(res => {
      const u = res.url().toLowerCase();
      return res.status() >= 200 && res.status() < 300 &&
             /(delete.*profile|profile.*delete|remove.*profile)/.test(u);
    }, { timeout: 15000 })
  );

  // 7) Kiểm tra danh sách hồ sơ để chắc chắn hồ sơ đã biến mất
  let removedByList = true;
  try {
    await page.goto('https://www.netflix.com/account/profiles',
                    { waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{});
    if (profileNameForConfirm) {
      const names = await getProfileNames(page);
      removedByList = !names.includes(profileNameForConfirm);
    }
  } catch {}

  if (redirected || removedByList) {
    console.log('✅ Đã xóa hồ sơ thành công.');
    return true;
  }

  console.log('❌ Không xác nhận được trạng thái xóa.');
  return false;
}

async function deleteProfileSmart(page, profileOrId, password, refererUrl) {
  if (/^[A-Z0-9]+$/.test(profileOrId)) {
    return await deleteProfileBySettingsId(page, profileOrId, password, refererUrl);
  }

  await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 });
  await gentleReveal(page);

  const names = await getProfileNames(page);
  if (!names.includes(profileOrId)) {
    console.log(`❌ Không thấy hồ sơ tên "${profileOrId}". Danh sách:`, names);
    return false;
  }

  const res = await openProfileAndGetId(page, profileOrId, 5);
  if (!res) { console.log('❌ Không lấy được settingsId từ tên hồ sơ.'); return false; }

  return await deleteProfileBySettingsId(page, res.id, password, res.settingsUrl);
}

/* ============== Điều hướng cứng vào /settings/lock/<ID> ============== */
async function hardGotoLock(page, settingsId, refererUrl) {
  const lockUrl = `https://www.netflix.com/settings/lock/${settingsId}`;
  const refererHeaders = refererUrl ? { Referer: refererUrl } : {};
  return await withExtraHTTPHeaders(page, refererHeaders, async () => {
    const tryOnce = async (how) => {
      if (how === 'goto')
        await page.goto(lockUrl, {
          waitUntil: 'networkidle2',
          timeout: 60000,
          ...(refererUrl ? { referer: refererUrl } : {}),
        }).catch(() => {});
      else if (how === 'href')
        await page.evaluate((u) => { location.href = u; }, lockUrl).catch(() => {});
      else if (how === 'assign')
        await page.evaluate((u) => { window.location.assign(u); }, lockUrl).catch(() => {});

      await raceAny(
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
        page.waitForFunction(
          (id) => location.pathname.includes(`/settings/lock/${id}`) || /\/settings\//.test(location.pathname),
          { timeout: 8000 }, settingsId
        )
      );

      if (await isErrorPage(page)) {
        console.log('⚠️ Trang lỗi sau khi vào lock → reload…');
        await page.goto(page.url(), { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      }
      if (new RegExp(`/settings/${settingsId}($|[/?#])`).test(page.url()) &&
          !new RegExp(`/settings/lock/${settingsId}($|[/?#])`).test(page.url())) {
        await page.evaluate((id) => {
          if (location.pathname.includes(`/settings/${id}`)) location.href = `/settings/lock/${id}`;
        }, settingsId).catch(() => {});
        await page.waitForFunction(
          (id) => location.pathname.includes(`/settings/lock/${id}`),
          { timeout: 10000 }, settingsId
        ).catch(() => {});
      }
      return new RegExp(`/settings/lock/${settingsId}($|[/?#])`).test(page.url());
    };
    if (await tryOnce('goto'))   return true;
    if (await tryOnce('href'))   return true;
    if (await tryOnce('assign')) return true;
    return false;
  });
}

/* ============== Flow: tới pinentry (Create -> Confirm -> pass) ============== */
async function goPinAndAuth(page, settingsId, password, refererUrl) {
  const SUCCESS_RE = /\/settings\/lock\/pinentry/i;
  const CONFIRM_SEL = '[data-uia="account-mfa-button-PASSWORD+PressableListItem"]';
  const PASS_INPUT_SEL = '[data-uia="collect-password-input-modal-entry"]';
  const TIMEOUTS = { first: 12000, input: 12000, final: 20000, grace: 7000 };

  const okNav = await hardGotoLock(page, settingsId, refererUrl);
  if (!okNav) {
    console.log('❌ Không thể điều hướng vào /settings/lock/', settingsId);
    return false;
  }
  if (SUCCESS_RE.test(page.url())) {
    console.log('✅ Đã ở pinentry (không cần nhập pass).');
    return true;
  }

  if (await hasRemoveButtonAnyFrame(page)) {
    console.log('🔒 Thấy nút "Xóa khóa hồ sơ" → bỏ qua Create/Edit, trả về cho caller xử lý gỡ.');
    return false;
  }

  let clicked = await clickCreateProfileLockAnyFrame(page);

  if (!clicked) {
    const didCmd = await page.evaluate(() => {
      const el = document.querySelector('button[data-cl-command="AddProfileLockCommand"]');
      if (!el) return false;
      el.scrollIntoView({ block:'center', inline:'center' });
      el.click();
      return true;
    });
    if (didCmd) {
      console.log('👉 Kích hoạt AddProfileLockCommand trực tiếp.');
      clicked = true;
    }
  }

  if (!clicked) {
    console.log('❌ Không click được "Tạo khóa hồ sơ".');
    try { await page.screenshot({ path: 'lock_debug.png', fullPage: true }); } catch {}
    if (!SUCCESS_RE.test(page.url())) return false;
  }

  const stage1 = await Promise.race([
    page.waitForSelector(CONFIRM_SEL, { visible: true, timeout: TIMEOUTS.first }).then(()=>'confirm').catch(()=>null),
    page.waitForFunction(
      re => new RegExp(re,'i').test(location.href), { timeout: TIMEOUTS.first, polling: 300 }, SUCCESS_RE.source
    ).then(ok => ok ? 'url' : null).catch(() => null)
  ]);

  if (stage1 === 'url') {
    console.log('✅ Vào pinentry ngay sau click.');
    return true;
  }
  if (stage1 !== 'confirm') {
    console.log('❌ Không thấy Confirm & không vào pinentry.');
    try { await page.screenshot({ path: 'lock_after_click.png', fullPage: true }); } catch {}
    return false;
  }

  const confirmBtn = await page.$(CONFIRM_SEL);
  if (!confirmBtn) { console.log('❌ confirmBtn biến mất.'); return false; }
  await clickWithAllTricks(page, confirmBtn);

  const stage2 = await Promise.race([
    page.waitForSelector(PASS_INPUT_SEL, { timeout: TIMEOUTS.input, visible: true }).then(()=> 'input').catch(()=>null),
    page.waitForFunction(
      re => new RegExp(re, 'i').test(location.href),
      { timeout: TIMEOUTS.input, polling: 300 }, SUCCESS_RE.source
    ).then(ok => ok ? 'url' : null).catch(()=>null)
  ]);

  if (stage2 === 'url') {
    console.log('✅ Redirect pinentry sau confirm (không cần nhập pass).');
    return true;
  }
  if (stage2 !== 'input') {
    console.log('❌ Không thấy ô nhập password.');
    return false;
  }

  console.log('👉 Nhập mật khẩu…');
  const passInput = await page.$(PASS_INPUT_SEL);
  if (!passInput) { console.log('❌ passInput biến mất.'); return false; }
  await passInput.type(password, { delay: 50 });
  await page.keyboard.press('Enter');

  const finalOk = await page.waitForFunction(
    re => new RegExp(re, 'i').test(location.href),
    { timeout: TIMEOUTS.final, polling: 300 }, SUCCESS_RE.source
  ).then(() => true).catch(() => false);

  if (finalOk) { console.log('✅ Pass đúng → vào pinentry.'); return true; }

  console.log('⏳ Grace recheck…');
  const start = Date.now();
  while (Date.now() - start < TIMEOUTS.grace) {
    if (/\/settings\/lock\/pinentry/i.test(page.url())) { console.log('✅ Pass đúng (grace).'); return true; }
    await sleep(300);
  }
  console.log('❌ Không redirect về pinentry.');
  return false;
}

/* ============== NHẬP 4 SỐ PIN & SAVE ============== */
async function setPinDigitsAndSave(page, pin4) {
  if (!/^\d{4}$/.test(pin4)) {
    console.log('❌ PIN phải là 4 chữ số.');
    return false;
  }

  const PIN_INPUT_CANDIDATES = [
    'input.pin-number-input',
    "input[data-uia*='pin']",
    "input[name*='pin' i]",
    "input[id*='pin' i]",
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"][maxlength="1"]',
    'input[type="password"][maxlength="1"]',
    'input[type="text"][maxlength="1"]',
  ].join(',');

  const first = await page.waitForSelector(PIN_INPUT_CANDIDATES, { visible: true, timeout: 12000 }).catch(() => null);
  if (!first) { console.log('❌ Không tìm thấy ô nhập PIN.'); return false; }

  try {
    await page.evaluate((sel) => {
      document.querySelectorAll(sel).forEach((i) => {
        i.value = '';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }, PIN_INPUT_CANDIDATES);
  } catch {}

  const inputs = await page.$$(PIN_INPUT_CANDIDATES);
  if (inputs.length >= 4) {
    for (let i = 0; i < 4; i++) {
      try {
        await inputs[i].focus();
        await inputs[i].click({ clickCount: 2 });
        await page.keyboard.type(pin4[i], { delay: 40 });
        if (i < 3) await page.keyboard.press('Tab');
      } catch {}
      await sleep(40);
    }
    try { await page.keyboard.press('Tab'); } catch {}
  } else {
    try { await first.click({ clickCount: 3 }); await page.keyboard.type(pin4, { delay: 60 }); } catch {}
  }

  const respPromise = page.waitForResponse((res) => {
    const u = res.url().toLowerCase();
    return (
      /(profile.*lock|lock.*profile|pinentry|profilelock|setpin|pin)/.test(u) &&
      res.request().method().match(/POST|PUT|PATCH/i) &&
      res.status() >= 200 && res.status() < 300
    );
  }, { timeout: 15000 }).catch(() => null);

  let save =
    (await page.$("button[data-uia*='save' i]")) ||
    (await page.$("button[type='submit']"));
  if (!save) {
    const found = await findButtonByTextAnyFrame(page, ['lưu','save','done','hoàn tất','update','cập nhật']);
    if (found?.handle) save = found.handle;
  }
  if (!save) { console.log('❌ Không tìm thấy nút Lưu.'); return false; }

  console.log('👉 Bấm Lưu PIN…');
  if (!(await robustClickHandle(page, save))) {
    console.log('❌ Không click được nút Lưu.');
    return false;
  }

  const successByUrlOrText = page.waitForFunction(() => {
    const body = (document.body?.innerText || '').toLowerCase();
    const leftPinEntry = /\/settings\/lock(\/|$)/.test(location.pathname) && !/pinentry/.test(location.pathname);
    const savedText = /(đã lưu|đã cập nhật|saved|updated|hoàn tất|done)/i.test(body);
    return leftPinEntry || savedText;
  }, { timeout: 12000 }).then(()=>true).catch(()=>false);

  const successByInputsGone = page.waitForFunction((sel) => {
    return document.querySelectorAll(sel).length < 4;
  }, { timeout: 12000 }, PIN_INPUT_CANDIDATES).then(()=>true).catch(()=>false);

  const successByRemoveBtn = (async () => {
    for (let i = 0; i < 12; i++) {
      if (await hasRemoveButtonAnyFrame(page)) return true;
      await sleep(1000);
    }
    return false;
  })();

  const successByResponse = (async () => {
    const r = await respPromise; return !!r;
  })();

  const okAny = await Promise.race([
    (async () => (await successByUrlOrText) || (await successByInputsGone) || (await successByRemoveBtn) || (await successByResponse))(),
    (async () => {
      try { await page.waitForNetworkIdle({ timeout: 8000 }).catch(()=>{}); } catch {}
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 12000 }).catch(()=>{}); } catch {}
      return await hasRemoveButtonAnyFrame(page);
    })()
  ]);

  if (okAny) { console.log('✅ Đã lưu PIN 4 số.'); return true; }

  console.log('⚠️ Không xác nhận được trạng thái lưu (có thể vẫn OK). Thử reload & kiểm tra lại lần cuối…');

  try {
    const currentUrl = page.url();
    const m = currentUrl.match(/\/settings\/lock\/([^/?#]+)/i) || currentUrl.match(/\/settings\/([^/?#]+)/i);
    const id = m ? m[1] : null;
    if (id) await page.goto(`https://www.netflix.com/settings/lock/${id}`, { waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{});
  } catch {}
  const lastCheck = await hasRemoveButtonAnyFrame(page);
  if (lastCheck) { console.log('✅ Xác nhận sau reload: PIN đã được bật (có nút Remove).'); return true; }

  console.log('❌ Không thể xác nhận PIN đã được lưu.');
  return false;
}

/* ============== XÓA KHOÁ HỒ SƠ (Remove profile lock) – ưu tiên REMOVE ============== */
async function clickRemoveProfileLockButton(page) {
  const hit = await findButtonAnyFrame(
    page,
    S.removeLockBtn,
    ['xóa', 'xoá', 'remove', 'disable', 'delete']
  );
  if (!hit) return false;

  const { frame, handle } = hit;
  try { await frame.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), handle); } catch {}
  if (!(await robustClickHandle(page, handle))) return false;

  // Confirm dialog
  for (let i = 0; i < 6; i++) {
    const confirmBtn =
      await findButtonByTextAnyFrame(page, ['remove','xóa','xoá','ok','confirm','yes','có','disable','delete']) ||
      await findFirstVisibleInFrames(page, ['[data-uia="modal"] button','[role="dialog"] button','div[role="dialog"] button']);
    if (confirmBtn?.handle) {
      await robustClickHandle(page, confirmBtn.handle);
      break;
    }
    await sleep(200);
  }

  // Password in modal (optional)
  let passBox = null;
  for (let i = 0; i < 8 && !passBox; i++) {
    for (const sel of S.passInput) {
      const hitSel = await queryInAllFrames(page, sel);
      if (hitSel) { passBox = hitSel.handle; break; }
    }
    if (!passBox) await sleep(250);
  }
  if (passBox) {
    try { await passBox.type(HARDCODED_PASSWORD, { delay: 40 }); } catch {}
    try { await page.keyboard.press('Enter'); } catch {}
  }

  // Save/Done (if any)
  for (let i = 0; i < 6; i++) {
    const saveBtn =
      await findButtonByTextAnyFrame(page, ['lưu','save','done','hoàn tất','update','cập nhật']) ||
      await findFirstVisibleInFrames(page, ["button[data-uia*='save' i]","button[type='submit']"]);
    if (saveBtn?.handle) {
      await robustClickHandle(page, saveBtn.handle);
      break;
    }
    await sleep(250);
  }

  return true;
}

async function hasRemoveButtonAnyFrame(page) {
  const found = await findButtonAnyFrame(
    page,
    S.removeLockBtn,
    [
      'xóa khóa hồ sơ', 'xoá khóa hồ sơ', 'tắt khóa hồ sơ', 'bỏ khóa hồ sơ',
      'remove profile lock', 'disable profile lock', 'remove lock', 'delete profile lock',
      'xóa', 'xoá', 'remove', 'disable', 'delete'
    ]
  );
  return !!found;
}

async function disableProfileLockByRemove(page, settingsId, password, refererUrl) {
  await hardGotoLock(page, settingsId, refererUrl);

  if (/\/settings\/lock\/pinentry/i.test(page.url())) {
    try { await page.goBack({ waitUntil: 'networkidle2', timeout: 8000 }); } catch {}
    if (/pinentry/i.test(page.url())) {
      try { await page.goto(`https://www.netflix.com/settings/lock/${settingsId}`, { waitUntil: 'networkidle2', timeout: 60000 }); } catch {}
    }
  }

  const removedClicked = await clickRemoveProfileLockButton(page);

  await handleIdentityVerifyModal(page, password);

  if (!removedClicked) {
    const uncheck = await page.evaluate(() => {
      let changed = false;
      document.querySelectorAll('input[type="checkbox"]').forEach(ch => {
        if (ch.checked) { ch.click(); changed = true; }
      });
      return changed;
    });
    if (uncheck) {
      const saveBtn =
        await findButtonByTextAnyFrame(page, ['lưu','save','done','hoàn tất','update','cập nhật']) ||
        await findFirstVisibleInFrames(page, ["button[data-uia*='save' i]","button[type='submit']"]);
      if (saveBtn?.handle) await robustClickHandle(page, saveBtn.handle);
    } else {
      return false;
    }
  }

  const PASS_INPUT_SEL = S.passInput.join(',');
  const passField = await queryInAllFrames(page, PASS_INPUT_SEL);
  if (passField?.handle) {
    try { await passField.handle.type(password, { delay: 40 }); } catch {}
    try { await page.keyboard.press('Enter'); } catch {}
  }

  const paramOk = await waitForProfilePinDeletedSuccess(page, 15000);
  if (paramOk) return true;

  const ok = await raceAny(
    page.waitForFunction(() =>
      /\/settings\/lock(\/|$)/.test(location.pathname) && !/pinentry/.test(location.pathname),
      { timeout: 15000 }),
    page.waitForFunction(() =>
      /đã lưu|đã cập nhật|saved|updated|hoàn tất|done/i.test(document.body?.innerText||''),
      { timeout: 15000 }),
    waitForProfilePinDeletedSuccess(page, 15000)
  );

  await sleep(500);
  const stillHasRemove = await hasRemoveButtonAnyFrame(page);
  if (!(ok && !stillHasRemove)) return false;

  try {
    const href = page.url();
    const m = href.match(/\/settings\/([A-Z0-9]+)\b/i);
    if (m && /profilePinDeleted=success/i.test(href)) {
      const sid = m[1];
      await page.goto(`https://www.netflix.com/settings/lock/${sid}`, {
        waitUntil: 'networkidle2', timeout: 20000
      }).catch(()=>{});
    }
  } catch {}

  return true;
}

async function setPinSmart(page, settingsId, password, newPin, refererUrl) {
  await hardGotoLock(page, settingsId, refererUrl);

  if (await hasRemoveButtonAnyFrame(page)) {
    console.log('🧹 Thấy nút "Xóa khóa hồ sơ" → gỡ khóa trước…');
    const off = await disableProfileLockByRemove(page, settingsId, password, refererUrl);
    if (!off) {
      console.log('❌ Không gỡ được khóa.');
      return false;
    }
    console.log('✅ Đã gỡ khóa hồ sơ thành công, chuyển sang tạo PIN mới…');

    try { refererUrl = page.url(); } catch {}
    await hardGotoLock(page, settingsId, refererUrl);
  }

  const ok = await goPinAndAuth(page, settingsId, password, refererUrl);
  if (!ok) {
    console.log('❌ Không vào được pinentry sau khi gỡ/hoặc chưa bật.');
    return false;
  }

  return await setPinDigitsAndSave(page, newPin);
}
/**
 * AUTO PROVISION:
 *  B1: Nếu còn nút "Thêm hồ sơ" → tạo hồ sơ + PIN theo yêu cầu
 *  B2: Nếu đủ 5 hồ sơ → tìm hồ sơ hết hạn / không có trong DB (hoặc theo flags) để xoá
 *      rồi tạo hồ sơ mới + đặt PIN
 */
async function autoProvisionProfile(page, wantedName, pin4, { isKids = false } = {}) {
  if (!wantedName || !/^\d{4}$/.test(pin4)) {
    console.log('❌ Thiếu tên hồ sơ hoặc PIN (4 số).');
    return false;
  }

  await page.goto('https://www.netflix.com/account/profiles',
                  { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await gentleReveal(page);

  // B1: còn nút "Thêm hồ sơ"?
  const canAdd = !!(
    await queryInAllFrames(page, S.addProfile[0]) ||
    await queryInAllFrames(page, S.addProfile[1]) ||
    await queryInAllFrames(page, S.addProfile[2]) ||
    await findButtonByTextAnyFrame(page, ['thêm hồ sơ','them ho so','add profile','new profile'])
  );

  if (canAdd) {
    console.log('🟢 Còn slot → tạo hồ sơ mới...');
    const { ok, settingsId } = await addProfile(page, wantedName, { isKids });
    if (!ok) return false;
    console.log('✅ Đã tạo hồ sơ mới:', wantedName);
    if (settingsId) {
      console.log('🔐 Đặt PIN…');
      return await setPinSmart(page, settingsId, HARDCODED_PASSWORD, pin4, page.url());
    }
    return true;
  }

  // B2: full slot → tìm ứng viên xoá
  console.log('🟡 Hết slot → tìm hồ sơ để thay thế...');
  const uiNames = await getProfileNames(page);
  const top5    = uiNames.slice(0, 5);
  const dbMap   = loadProfileDb();

  // Log chẩn đoán
  console.log('📋 UI top5:', top5);
  const dbg = [];
  for (const [k, v] of dbMap.entries()) dbg.push(`${k} -> ${v ? v.toISOString().slice(0,10) : '-'}`);
  console.log('🗃️ DB keys:', dbg);

  // Flags từ ENV (được set ở MAIN khi parse args)
  const graceDays   = Number(process.env.GRACE_DAYS || 0) || 0;
  const forceOldest = String(process.env.EVICT_OLDEST || '').toLowerCase() === '1';
  const preferredVictimRaw = process.env.EVICT_BY || null;

  // Chuẩn hoá tên để so khớp
  const uiIndex = new Map(); // norm -> original
  const top5Norm = top5.map(n => {
    const norm = normalizeName(n);
    if (!uiIndex.has(norm)) uiIndex.set(norm, n);
    return norm;
  });
  const dbMapNorm = new Map();
  for (const [name, date] of dbMap.entries()) {
    const norm = normalizeName(name);
    if (!dbMapNorm.has(norm)) dbMapNorm.set(norm, date);
  }
  const preferredVictim = preferredVictimRaw ? normalizeName(preferredVictimRaw) : null;

  const victimNorm = pickEvictionCandidate(top5Norm, dbMapNorm,
    { graceDays, forceOldest, preferredVictim });
  const victim = victimNorm ? (uiIndex.get(victimNorm) || victimNorm) : null;

  if (!victim) {
    console.log('❌ Không tìm được hồ sơ hợp lệ để xoá (không hết hạn/không lạ).');
    console.log('ℹ️ Dùng --grace=7 hoặc --evict-oldest, hoặc --evict-by="Tên".');
    return false;
  }

  console.log('🗑️ Xoá hồ sơ:', victim);

  let res = await openProfileAndGetId(page, victim, 5);
  if (!res) { console.log('❌ Không mở được hồ sơ cần xoá.'); return false; }

  // Bọc xoá để tránh dừng sớm khi điều hướng nội bộ
  let okDel = false;
  try {
    okDel = await deleteProfileBySettingsId(page, res.id, HARDCODED_PASSWORD, res.settingsUrl, victim);
  } catch (e) {
    if (isBenignNavError(e)) {
      console.warn('⚠️ Benign nav trong lúc xoá, tiếp tục kiểm tra trạng thái…');
      okDel = true;
    } else {
      throw e;
    }
  }
  if (!okDel) { console.log('❌ Xoá thất bại.'); return false; }
  console.log('✅ Đã xoá hồ sơ:', victim);

  // Tạo + đặt PIN
  console.log('➕ Tạo hồ sơ mới sau khi xoá…');
  const addRes = await addProfile(page, wantedName, { isKids });
  if (!addRes?.ok) { console.log('❌ Tạo hồ sơ mới thất bại.'); return false; }
  console.log('✅ Đã tạo hồ sơ mới:', wantedName);

  const newId = addRes.settingsId || (await (async () => {
    const opened = await openProfileAndGetId(page, wantedName, 5);
    return opened?.id || null;
  })());

  if (!newId) {
    console.log('⚠️ Không lấy được settingsId để đặt PIN, nhưng hồ sơ đã tạo xong.');
    return true;
  }

  console.log('🔐 Đặt PIN cho hồ sơ mới…');
  const okPin = await setPinSmart(page, newId, HARDCODED_PASSWORD, pin4, page.url());
  if (!okPin) { console.log('⚠️ Không đặt được PIN, nhưng hồ sơ đã tạo.'); return false; }
  console.log('✅ Đã đặt PIN thành công.');
  return true;
}

/* ============== MAIN ============== */
(async () => {
  try {
    const arg    = process.argv[2] || null;                    // Tên hồ sơ HOẶC ID (chỉ chữ & số)
    const pinArg = process.argv[3] || process.env.PIN || null; // PIN 4 số (tuỳ chọn)

    const bundle = loadCookies(COOKIE_FILE);
    const cookiesFromFile = bundle ? toCookies(bundle) : null;

    browser = await puppeteer.launch({
      headless: false,
      executablePath: findChromePath(),
      userDataDir: USER_DATA_DIR,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--lang=vi-VN',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    page = await browser.newPage();
    // Stealth
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN','vi','en-US','en'] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await applyExtraHTTPHeaders(page, BASE_HTTP_HEADERS);

    // Cookie login (nếu có)
    await page.goto('https://www.netflix.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { const cur = await page.cookies(); if (cur.length) await page.deleteCookie(...cur); } catch {}
    if (cookiesFromFile?.length || cookiesFromFile?.cookies) {
      for (const ck of (cookiesFromFile.cookies || cookiesFromFile)) {
        try { await page.setCookie(ck); } catch (e) { console.log('❌ cookie:', ck.name, e?.message || e); }
      }
    }

    // Nếu cookie fail ⇒ đăng nhập bằng tài khoản/mật khẩu và LƯU cookies
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      const ok = await loginWithCredentials(page, NETFLIX_EMAIL, NETFLIX_PASSWORD);
      if (!ok) {
        console.log('❌ Không đăng nhập được bằng tài khoản/mật khẩu.');
        await holdOrExit(1);
        return;
      }
      loggedIn = true;
    }

    // ==== ACTION: add (tạo hồ sơ mới) ====
    // Cú pháp: node loginByCookie.js add "Tên hồ sơ" [PIN4] [kids]
    {
  const actionAuto = (process.argv[2] || '').trim().toLowerCase();
  if (actionAuto === 'auto') {
    __AUTO_FLOW = true; // đánh dấu auto để outer catch không thoát sớm

    const args = process.argv.slice(3);
    let newName = '';
    let pin4 = '';
    let isKids = false;

    // Bóc tách tham số không phụ thuộc thứ tự
    for (const a of args) {
      if (/^--?kids$/i.test(a) || /^kids$/i.test(a)) { isKids = true; continue; }
      if (/^\d{4}$/.test(a)) { pin4 = a; continue; }
      if (/^--/.test(a)) continue; // flags xử lý vòng sau
      if (!newName) newName = a;   // đối số text đầu tiên => name
    }

    // Flags: --grace=7, --evict-oldest, --evict-by="Tên"
    for (const a of args) {
      const mGrace = a.match(/^--grace=(\d{1,3})$/i);
      if (mGrace) process.env.GRACE_DAYS = mGrace[1];
      if (/^--evict-oldest$/i.test(a)) process.env.EVICT_OLDEST = '1';
      const mBy = a.match(/^--evict-by=(.+)$/i);
      if (mBy) process.env.EVICT_BY = mBy[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }

    if (!newName || !/^\d{4}$/.test(pin4)) {
      console.log('❌ Thiếu tham số. Dùng:');
      console.log('   node loginByCookie.js auto "Tên hồ sơ" 0000 [--kids] [--grace=7] [--evict-oldest] [--evict-by="Tên"]');
      await holdOrExit(1);
      return;
    }

    const ok = await autoProvisionProfile(page, newName, pin4, { isKids });
    console.log(ok ? '✅ AUTO DONE' : '❌ AUTO FAIL');
    await holdOrExit(ok ? 0 : 1);
    return; // QUAN TRỌNG: return sớm, không rơi vào logic xử lý arg bên dưới
  }
}
    const action0 = (process.argv[2] || '').trim().toLowerCase();
    if (action0 === 'add') {
      const newName  = process.argv[3] || '';
      const maybePin = process.argv[4] || '';
      const kidsFlag = (process.argv[5] || '').toLowerCase();
      const isKids   = ['kids','kid','child','children','tre','trẻ','treem','trẻ em','te'].includes(kidsFlag);

      if (!newName) {
        console.log('❌ Thiếu tên hồ sơ. Dùng: node loginByCookie.js add "Tên hồ sơ" [PIN4] [kids]');
        await holdOrExit(1);
        return;
      }

      await page.goto('https://www.netflix.com/account/profiles', { waitUntil:'networkidle2', timeout:60000 }).catch(()=>{});

      const { ok, settingsId } = await addProfile(page, newName, { isKids });
      if (!ok) {
        console.log('❌ Tạo hồ sơ thất bại.');
        await holdOrExit(1);
        return;
      }
      console.log('✅ Đã tạo hồ sơ mới:', newName, '→ settingsId:', settingsId || '(chưa lấy được)');

      if (/^\d{4}$/.test(maybePin) && settingsId) {
        console.log('🔐 Đặt PIN cho hồ sơ mới…');
        const okPin = await setPinSmart(page, settingsId, HARDCODED_PASSWORD, maybePin, page.url());
        if (!okPin) console.log('⚠️ Không đặt được PIN cho hồ sơ mới.');
        else console.log('✅ Đã đặt PIN thành công cho hồ sơ mới.');
      } else if (maybePin) {
        console.log('ℹ️ Bỏ qua đặt PIN: Giá trị PIN không hợp lệ (cần 4 chữ số).');
      }

      await holdOrExit(0);
      return;
    }

    // Lấy settingsId
    let settingsId = null;
    let refererUrl = null;

    if (arg && /^[A-Z0-9]+$/.test(arg)) {
      settingsId = arg;
      await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 });
      refererUrl = 'https://www.netflix.com/account/profiles';
    } else {
      await page.goto('https://www.netflix.com/account/profiles', { waitUntil: 'networkidle2', timeout: 60000 });
      await gentleReveal(page);
      if (!arg) {
        const names = await getProfileNames(page);
        console.log('🔎 Hồ sơ phát hiện:', names);
        console.log('➡️  Dùng: node loginByCookie.js "Tên hồ sơ" 1234  HOẶC  node loginByCookie.js SETTINGS_ID 1234');
        await holdOrExit(0);
        return;
      }
      const names = await getProfileNames(page);
      if (!names.includes(arg)) {
        console.log(`❌ Không tìm thấy hồ sơ tên "${arg}". Danh sách:`, names);
        await holdOrExit(1);
        return;
      }
      const res = await openProfileAndGetId(page, arg, 5);
      if (!res) { console.log('❌ Không lấy được settingsId.'); await holdOrExit(1); return; }
      settingsId = res.id;
      refererUrl = res.settingsUrl;
    }

    // ==== Action routing: delete | set-pin (4 digits) | just open ====
    const rawArg = (process.argv[3] || process.env.PIN || '').trim();
    const action = rawArg.toLowerCase();
    const isFourDigits = /^\d{4}$/.test(rawArg);

    if (action === 'delete' || process.env.DELETE_PROFILE === '1') {
      const profileName = (arg && !/^[A-Z0-9]+$/.test(arg)) ? arg : null;
      const okDel = await deleteProfileBySettingsId(page, settingsId, HARDCODED_PASSWORD, refererUrl, profileName);

      if (okDel) {
        try { await page.goto('https://www.netflix.com/account/profiles', { waitUntil:'networkidle2', timeout:20000 }); } catch {}
        console.log('✅ Xóa xong – đang ở danh sách hồ sơ.');
        await holdOrExit(0);
      } else {
        console.log('⚠️ Xóa không thành công – giữ nguyên trang hiện tại để kiểm tra.');
        await holdOrExit(1);
      }
      return;
    }

    if (isFourDigits) {
      const okPin = await setPinSmart(page, settingsId, HARDCODED_PASSWORD, rawArg, refererUrl);
      if (!okPin) console.log('❌ Không thay/đặt được PIN. Xem log ở trên.');
      await holdOrExit(okPin ? 0 : 1);
      return;
    }
    {
  const actionAuto = (process.argv[2] || '').trim().toLowerCase();
  if (actionAuto === 'auto') {
    __AUTO_FLOW = true; // đánh dấu auto để không thoát sớm trong outer catch

    const args = process.argv.slice(3);
    let newName = '';
    let pin4 = '';
    let isKids = false;

    for (const a of args) {
      if (/^--?kids$/i.test(a) || /^kids$/i.test(a)) { isKids = true; continue; }
      if (/^\d{4}$/.test(a)) { pin4 = a; continue; }
      if (/^--/.test(a)) continue; // flags xử dưới
      if (!newName) newName = a;   // đối số text đầu tiên coi là name
    }

    for (const a of args) {
      const mGrace = a.match(/^--grace=(\d{1,3})$/i);
      if (mGrace) process.env.GRACE_DAYS = mGrace[1];
      if (/^--evict-oldest$/i.test(a)) process.env.EVICT_OLDEST = '1';
      const mBy = a.match(/^--evict-by=(.+)$/i);
      if (mBy) process.env.EVICT_BY = mBy[1].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }

    if (!newName || !/^\d{4}$/.test(pin4)) {
      console.log('❌ Thiếu tham số. Dùng:');
      console.log('   node loginByCookie.js auto "Tên hồ sơ" 0000 [--kids] [--grace=7] [--evict-oldest] [--evict-by="Tên"]');
      await holdOrExit(1);
      return;
    }

    const ok = await autoProvisionProfile(page, newName, pin4, { isKids });
    console.log(ok ? '✅ AUTO DONE' : '❌ AUTO FAIL');
    await holdOrExit(ok ? 0 : 1);
    return;
  }
}

    // Không truyền gì → chỉ mở trang khóa hồ sơ
    await hardGotoLock(page, settingsId, refererUrl);
    console.log('ℹ️ Không truyền PIN hoặc delete → chỉ mở trang khóa hồ sơ.');
    await holdOrExit(0);
    return;

} catch (err) {
  if (isBenignNavError(err)) {
    if (__AUTO_FLOW) {
      console.warn('⚠️ Bỏ qua lỗi do điều hướng (AUTO), tiếp tục flow…', err?.message || err);
      return; // không exit – để autoProvisionProfile tiếp tục
    }
    try {
      const href = page?.url?.() || '';
      if (/\/account\/profiles\b/i.test(href) && /[?&]profileDeleted=success\b/i.test(href)) {
        console.log('✅ Xóa hồ sơ thành công (đã về profiles?profileDeleted=success).');
        await holdOrExit(0);
        return;
      }
    } catch {}
    console.warn('⚠️ Bỏ qua lỗi do điều hướng:', err?.message || err);
    await holdOrExit(0);
    return;
  }
  console.error('❌ Lỗi ngoài ý muốn:', err);
  await cleanup(1);
}
})();
