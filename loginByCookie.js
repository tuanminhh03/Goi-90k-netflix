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

/* ====== Graceful shutdown ====== */
let browser; // để cleanup dùng được
let page;

async function cleanup(exitCode = 0) {
  try { await page?.close().catch(() => {}); } catch {}
  try { await browser?.close().catch(() => {}); } catch {}
  process.exit(exitCode);
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
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(raw)) return { url: 'https://www.netflix.com', cookies: raw };
  if (raw && Array.isArray(raw.cookies))
    return { url: raw.url || 'https://www.netflix.com', cookies: raw.cookies };
  throw new Error('cookies.json sai định dạng (mảng hoặc { url, cookies:[...] })');
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

  const ok = await Promise.race([
    page.waitForFunction(() => /\/(browse|profiles|account)/i.test(location.pathname), { timeout: 30000 }).then(()=>true).catch(()=>false),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).then(()=>/\/(browse|profiles|account)/i.test(page.url())).catch(()=>false),
  ]);

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
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
      page.waitForFunction(() => /\/settings\//i.test(location.pathname), { timeout: 8000 }).catch(() => null),
    ]);
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

// Tìm nút theo TEXT ở mọi frame (không dùng :has-text)
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

// Tìm phần tử theo danh sách selector ở mọi frame; trả về phần tử đầu tiên tồn tại
async function findFirstVisibleInFrames(page, selectors = []) {
  for (const sel of selectors) {
    const hit = await queryInAllFrames(page, sel);
    if (hit) return hit;
  }
  return null;
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

/* ===== Identity verify modal: chọn "Xác nhận mật khẩu" và nhập pass ===== */
async function handleIdentityVerifyModal(page, password) {
  // chờ dialog xuất hiện (tối đa ~6s)
  for (let i = 0; i < 12; i++) {
    const open = await page.evaluate(() => !!(document.querySelector('[role="dialog"], [data-uia="modal"]'))).catch(()=>false);
    if (open) break;
    await sleep(500);
  }

  // tìm & bấm "Xác nhận mật khẩu"
  const passOption = await findButtonByTextAnyFrame(page, [
    'xác nhận mật khẩu','confirm with password','verify with password','password','mật khẩu'
  ]);
  if (passOption?.handle) {
    try { await passOption.frame.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), passOption.handle); } catch {}
    await robustClickHandle(page, passOption.handle);
  }

  // tìm ô password (retry qua animation/iframe)
  const PASS_INPUTS = [
    '[data-uia="collect-password-input-modal-entry"]',
    'input[name="password"]', 'input[type="password"]',
    'input[autocomplete="current-password"]', 'input[autocomplete="password"]',
  ];
  let passField = null;
  for (let t = 0; t < 20 && !passField; t++) {
    for (const sel of PASS_INPUTS) {
      const hit = await queryInAllFrames(page, sel);
      if (hit?.handle) { passField = hit; break; }
    }
    if (!passField) await sleep(250);
  }
  if (!passField) return false;

  // focus + type + submit
  try { await passField.frame.evaluate(el => el.focus(), passField.handle); } catch {}
  try { await passField.handle.click({ clickCount: 2 }); } catch {}
  try { await passField.handle.type(password, { delay: 40 }); } catch {}
  try { await page.keyboard.press('Enter'); } catch {}

  // đợi dialog đóng
  for (let i = 0; i < 20; i++) {
    const open = await page.evaluate(() => !!(document.querySelector('[role="dialog"], [data-uia="modal"]'))).catch(()=>false);
    if (!open) return true;
    await sleep(300);
  }
  return false;
}

// Đợi URL có ?profilePinDeleted=success (sau khi remove lock)
async function waitForProfilePinDeletedSuccess(page, timeout = 15000) {
  const ok = await page.waitForFunction(() => {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('profilePinDeleted') === 'success';
    } catch (_) { return false; }
  }, { timeout }).then(() => true).catch(() => false);
  return ok;
}

// Click "Tạo khóa hồ sơ" trong mọi frame
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

/* ============== Điều hướng cứng vào /settings/lock/<ID> ============== */
async function hardGotoLock(page, settingsId, refererUrl) {
  const lockUrl = `https://www.netflix.com/settings/lock/${settingsId}`;
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(refererUrl ? { Referer: refererUrl } : {}),
  });
  const tryOnce = async (how) => {
    if (how === 'goto')
      await page.goto(lockUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    else if (how === 'href')
      await page.evaluate((u) => { location.href = u; }, lockUrl).catch(() => {});
    else if (how === 'assign')
      await page.evaluate((u) => { window.location.assign(u); }, lockUrl).catch(() => {});

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null),
      page.waitForFunction(
        (id) => location.pathname.includes(`/settings/lock/${id}`) || /\/settings\//.test(location.pathname),
        { timeout: 8000 }, settingsId
      ).catch(() => null),
    ]);

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

  // ⛔ Nếu có REMOVE thì KHÔNG làm gì ở đây, để caller xử lý gỡ trước
  if (await hasRemoveButtonAnyFrame(page)) {
    console.log('🔒 Thấy nút "Xóa khóa hồ sơ" → bỏ qua Create/Edit, trả về cho caller xử lý gỡ.');
    return false;
  }

  // ✅ Chỉ click "Tạo khóa hồ sơ" (KHÔNG click Edit PIN)
  let clicked = await clickCreateProfileLockAnyFrame(page);

  // Fallback: kích hoạt command trực tiếp
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

  // Sau click: chờ Confirm(PASSWORD) HOẶC đã vào pinentry
  const stage1Confirm = page.waitForSelector(CONFIRM_SEL, { visible: true, timeout: TIMEOUTS.first })
    .then(() => 'confirm').catch(() => null);
  const stage1Url = page.waitForFunction(
    re => new RegExp(re,'i').test(location.href), { timeout: TIMEOUTS.first, polling: 300 }, SUCCESS_RE.source
  ).then(ok => ok ? 'url' : null).catch(() => null);
  const stage1 = await Promise.race([stage1Confirm, stage1Url]);

  if (stage1 === 'url') {
    console.log('✅ Vào pinentry ngay sau click.');
    return true;
  }
  if (stage1 !== 'confirm') {
    console.log('❌ Không thấy Confirm & không vào pinentry.');
    try { await page.screenshot({ path: 'lock_after_click.png', fullPage: true }); } catch {}
    return false;
  }

  // Confirm → nhập pass hoặc redirect
  const confirmBtn = await page.$(CONFIRM_SEL);
  if (!confirmBtn) { console.log('❌ confirmBtn biến mất.'); return false; }
  await clickWithAllTricks(page, confirmBtn);

  const stage2Input = page.waitForSelector(PASS_INPUT_SEL, { timeout: TIMEOUTS.input, visible: true })
    .then(() => 'input').catch(() => null);
  const stage2Url = page.waitForFunction(
    re => new RegExp(re, 'i').test(location.href),
    { timeout: TIMEOUTS.input, polling: 300 }, SUCCESS_RE.source
  ).then(ok => ok ? 'url' : null).catch(() => null);
  const stage2 = await Promise.race([stage2Input, stage2Url]);

  if (stage2 === 'url') {
    console.log('✅ Redirect pinentry sau confirm (không cần nhập pass).');
    return true;
  }
  if (stage2 !== 'input') {
    console.log('❌ Không thấy ô nhập password.');
    return false;
  }

  // Nhập mật khẩu + Enter
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
    [
      'button[data-uia="profile-lock-page+remove-button"]',
      'button[data-uia="profile-lock-remove-button"]',
      '[data-cl-command="RemoveProfileLockCommand"]',
    ],
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
  const PASS_INPUT_CANDIDATES = [
    '[data-uia="collect-password-input-modal-entry"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="password"]',
  ];
  let passBox = null;
  for (let i = 0; i < 8 && !passBox; i++) {
    for (const sel of PASS_INPUT_CANDIDATES) {
      const hitSel = await queryInAllFrames(page, sel);
      if (hitSel) { passBox = hitSel.handle; break; }
    }
    if (!passBox) await sleep(250);
  }
  if (passBox) {
    try { await passBox.type(HARDCODED_PASSWORD, { delay: 40 }); } catch {}
    try { await page.keyboard.press('Enter'); } catch {}
  }

  // Save/Done button (if UI requires)
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

// ==== CHECK: có nút "Xóa/Xoá/Remove profile lock" không (trên mọi frame) ====
async function hasRemoveButtonAnyFrame(page) {
  const found = await findButtonAnyFrame(
    page,
    [
      'button[data-uia="profile-lock-page+remove-button"]',
      'button[data-uia="profile-lock-remove-button"]',
      '[data-cl-command="RemoveProfileLockCommand"]',
    ],
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

  // Nếu Netflix hiện modal xác minh → xử lý
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

  // Nếu còn modal password → nhập & Enter (backup)
  const PASS_INPUT_SEL = '[data-uia="collect-password-input-modal-entry"], input[name="password"], input[type="password"]';
  const passField = await queryInAllFrames(page, PASS_INPUT_SEL);
  if (passField?.handle) {
    try { await passField.handle.type(password, { delay: 40 }); } catch {}
    try { await page.keyboard.press('Enter'); } catch {}
  }

  // Ưu tiên xác nhận theo query param
  const paramOk = await waitForProfilePinDeletedSuccess(page, 15000);
  if (paramOk) return true;

  // fallback: URL/Toast/Remove button biến mất
  const ok = await Promise.race([
    page.waitForFunction(() =>
      /\/settings\/lock(\/|$)/.test(location.pathname) && !/pinentry/.test(location.pathname),
      { timeout: 15000 }).then(()=>true).catch(()=>false),
    page.waitForFunction(() =>
      /đã lưu|đã cập nhật|saved|updated|hoàn tất|done/i.test(document.body?.innerText||''),
      { timeout: 15000 }).then(()=>true).catch(()=>false),
  ]);

  await sleep(500);
  const stillHasRemove = await hasRemoveButtonAnyFrame(page);
  return (ok && !stillHasRemove);
}

/* ============== ĐẶT PIN thông minh (gỡ trước nếu đã có) ============== */
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
  }

  const ok = await goPinAndAuth(page, settingsId, password, refererUrl);
  if (!ok) {
    console.log('❌ Không vào được pinentry sau khi gỡ/hoặc chưa bật.');
    return false;
  }

  return await setPinDigitsAndSave(page, newPin);
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
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

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
        await new Promise(() => {}); // treo để xem UI
        return;
      }
      loggedIn = true;
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
        await new Promise(() => {}); // treo để bạn đọc log
        return;
      }
      const names = await getProfileNames(page);
      if (!names.includes(arg)) {
        console.log(`❌ Không tìm thấy hồ sơ tên "${arg}". Danh sách:`, names);
        await new Promise(() => {});
        return;
      }
      const res = await openProfileAndGetId(page, arg, 5);
      if (!res) { console.log('❌ Không lấy được settingsId.'); await new Promise(() => {}); return; }
      settingsId = res.id;
      refererUrl = res.settingsUrl;
    }

    console.log(`🆔 settingsId: ${settingsId}`);
    console.log(`🔐 PIN URL: https://www.netflix.com/settings/lock/${settingsId}`);

    // Không gọi goPinAndAuth trực tiếp — để setPinSmart tự ưu tiên Remove
    if (pinArg) {
      const okPin = await setPinSmart(page, settingsId, HARDCODED_PASSWORD, pinArg, refererUrl);
      if (!okPin) console.log('❌ Không thay/đặt được PIN. Xem log ở trên.');
    } else {
      await hardGotoLock(page, settingsId, refererUrl);
      console.log('ℹ️ Chưa truyền PIN 4 số → đang ở trang khóa hồ sơ (không bấm Edit).');
    }

    await new Promise(() => {});
  } catch (err) {
    console.error('❌ Lỗi ngoài ý muốn:', err);
    await cleanup(1);
  }
})();
