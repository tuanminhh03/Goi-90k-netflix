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
function isBenignNavError(err) {
  const msg = String(err?.message || err);
  return /Execution context was destroyed|Cannot find context|Target closed|frame got detached/i.test(msg);
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

// Bấm "Xóa hồ sơ" lần 2 trong modal (đúng selector Netflix dùng cho destructive)
async function clickSecondDeleteButton(page, { timeoutMs = 6000 } = {}) {
  const SELECTOR =
    'button[data-uia="profile-settings-page+delete-profile+destructive-button"][data-cl-view="deleteProfile"]';

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Ưu tiên frame có dialog/modal
    const frames = page.frames();
    for (const f of frames) {
      const hasDialog = await f.$('div[role="dialog"], [data-uia="modal"], [aria-modal="true"]').catch(()=>null);
      if (!hasDialog) continue;

      const btn = await f.$(SELECTOR);
      if (btn) {
        // cuộn + click an toàn
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

    // Fallback: đôi khi portal gắn thẳng lên main frame
    const btnMain = await page.$(SELECTOR).catch(()=>null);
    if (btnMain) {
      try { await page.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), btnMain); } catch {}
      try { await btnMain.click({ delay: 20 }); return true; } catch {}
    }

    await sleep(120);
  }
  return false;
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
// Bấm nút "Xóa hồ sơ" TRONG OVERLAY/MODAL (quét cả body, dialog, portal, iframe, shadow) – retry ngắn
async function clickDangerDeleteInAnyOverlay(page, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  // Hàm chạy trong frame: ưu tiên nút trong dialog, sau đó toàn trang (đề phòng portal)
  const clickInFrame = async (frame) => {
    return await frame.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el), r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 1 && r.height > 1 && !el.disabled;
      };

      // 1) Dialog/modal container
      const dialog = document.querySelector('div[role="dialog"], [data-uia="modal"], [aria-modal="true"]') || document.body;

      // 2) Tick mọi checkbox “Tôi hiểu” nếu có
      dialog.querySelectorAll('input[type="checkbox"],[role="checkbox"]').forEach(el => {
        try {
          if (el instanceof HTMLInputElement) { if (!el.checked) el.click(); }
          else if (el.getAttribute('aria-checked') === 'false') el.click();
        } catch {}
      });

      // 3) Tìm nút “Xóa hồ sơ / Delete profile / Delete”
      const buttons = Array.from(dialog.querySelectorAll('button,[role="button"]'));
      const target = buttons.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return visible(b) && (
          t.includes('xóa hồ sơ') || t.includes('xoá hồ sơ') ||
          t.includes('delete profile') || t === 'delete' || t.includes('delete')
        );
      }) || buttons.find(b => {
        // fallback: destructive button (màu đỏ) không có text rõ
        const t = (b.textContent || '').trim().toLowerCase();
        return visible(b) && (b.dataset?.uia?.includes('delete') || /destructive|danger/i.test(b.className) || t.includes('xóa') || t.includes('xoá'));
      });

      if (!target) return false;
      try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      try { target.focus(); } catch {}
      target.click();
      return true;
    }).catch(() => false);
  };

  // Bịt phím gây đóng modal
  await page.evaluate(() => {
    const trap = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
      }
    };
    window.__nfDelTrap2 && document.removeEventListener('keydown', window.__nfDelTrap2, true);
    window.__nfDelTrap2 = trap;
    document.addEventListener('keydown', trap, true);
  }).catch(() => {});

  // Vòng retry ngắn đến khi click được hoặc hết thời gian
  while (Date.now() < deadline) {
    // Ưu tiên những frame đang có dialog
    const frames = page.frames();
    let done = false;

    // Thử trong frame có dialog trước
    for (const f of frames) {
      const hasDialog = await f.$('div[role="dialog"], [data-uia="modal"], [aria-modal="true"]').catch(()=>null);
      if (hasDialog) { done = await clickInFrame(f); if (done) break; }
    }
    // Nếu chưa được, quét tất cả frame (portal có thể nằm ngoài dialog)
    if (!done) {
      for (const f of frames) { done = await clickInFrame(f); if (done) break; }
    }
    if (done) {
      // gỡ trap phím
      await page.evaluate(() => {
        if (window.__nfDelTrap2) {
          document.removeEventListener('keydown', window.__nfDelTrap2, true);
          window.__nfDelTrap2 = null;
        }
      }).catch(()=>{});
      return true;
    }
    await sleep(120);
  }

  // gỡ trap phím nếu thất bại
  await page.evaluate(() => {
    if (window.__nfDelTrap2) {
      document.removeEventListener('keydown', window.__nfDelTrap2, true);
      window.__nfDelTrap2 = null;
    }
  }).catch(()=>{});
  return false;
}

// Tìm phần tử theo danh sách selector ở mọi frame; trả về phần tử đầu tiên tồn tại
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

// ==== Tìm nút thùng rác (Delete) trên mọi frame ====
async function findTrashButtonAnyFrame(page) {
  // Các selector khả dĩ: data-uia, command, hoặc SVG icon TrashCan
  const selectors = [
    'button[data-uia="account-profile-delete-button"]',
    '[data-cl-command="DeleteProfileCommand"]',
    // Nhiều UI gắn aria-label hoặc title dạng Delete/Xóa:
    'button[aria-label*="Delete" i]',
    'button[aria-label*="Xóa" i], button[aria-label*="Xoá" i]',
    'button[title*="Delete" i], button[title*="Xóa" i], button[title*="Xoá" i]',
  ];

  // 1) Thử các selector trực tiếp
  const hit = await findFirstVisibleInFrames(page, selectors);
  if (hit) return hit;

  // 2) Fallback: SVG TrashCan → tìm button/ancestor click được
  const svgHit = await queryInAllFrames(page, 'svg[data-icon*="TrashCan" i], svg[data-icon-id*="TrashCan" i]');
  if (svgHit?.handle) {
    const { frame, handle } = svgHit;
    try {
      const btn = await frame.evaluateHandle((svg) => {
        let el = svg;
        for (let i = 0; i < 5 && el; i++) { // leo tối đa 5 cấp
          if (el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button') return el;
          el = el.parentElement;
        }
        return svg.closest?.('button,[role="button"]') || null;
      }, handle);
      if (btn && (await btn.asElement())) return { frame, handle: btn.asElement() };
    } catch {}
    // Fallback nữa: click trực tiếp ancestor div của svg
    return svgHit;
  }
  return null;
}

// ==== Điều hướng cứng vào /settings/<ID> (không phải lock) ====
async function hardGotoSettings(page, settingsId, refererUrl) {
  const settingsUrl = `https://www.netflix.com/settings/${settingsId}`;
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(refererUrl ? { Referer: refererUrl } : {}),
  });

  const tryOnce = async (how) => {
    if (how === 'goto')
      await page.goto(settingsUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
    else if (how === 'href')
      await page.evaluate((u)=>{ location.href = u; }, settingsUrl).catch(()=>{});
    else if (how === 'assign')
      await page.evaluate((u)=>{ window.location.assign(u); }, settingsUrl).catch(()=>{});

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(()=>null),
      page.waitForFunction(
        (id)=> new RegExp(`/settings/${id}($|[/?#])`).test(location.pathname),
        { timeout: 8000 }, settingsId
      ).catch(()=>null),
    ]);

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
}

// ==== Tìm nút "Xóa hồ sơ" trên mọi frame ====
async function findDeleteProfileButtonAnyFrame(page) {
  const selectors = [
    'button[data-uia="profile-settings-page+delete-profile+destructive-button"]', // bạn cung cấp
    '[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-uia*="delete-profile" i]',
  ];
  const hit = await findFirstVisibleInFrames(page, selectors);
  if (hit) return hit;

  const byText = await findButtonByTextAnyFrame(page, ['xóa hồ sơ','xoá hồ sơ','delete profile']);
  return byText || null;
}


// ==== Nếu hiện dialog/sheet xác nhận thì tick checkbox & bấm xác nhận ====
async function clickConfirmDeleteDialogsIfAny(page) {
  // Tick checkbox (nếu có)
  const checkSel = [
    'div[role="dialog"] input[type="checkbox"]',
    '[data-uia="modal"] input[type="checkbox"]',
    'div[role="dialog"] [role="checkbox"]',
  ];
  for (const sel of checkSel) {
    for (const f of page.frames()) {
      const boxes = await f.$$(sel);
      for (const b of boxes) {
        try {
          await f.evaluate(el => {
            if (el.getAttribute?.('aria-checked') === 'false') el.click();
            if (el instanceof HTMLInputElement && !el.checked) el.click();
          }, b);
        } catch {}
      }
    }
  }

  // Bấm nút xác nhận trong dialog
  const confirm =
    await findButtonByTextAnyFrame(page, ['xóa hồ sơ','xoá hồ sơ','delete','ok','confirm','yes','có']) ||
    await findFirstVisibleInFrames(page, ['div[role="dialog"] button','[data-uia="modal"] button']);
  if (confirm?.handle) await robustClickHandle(page, confirm.handle);
}

// Click 1 lần duy nhất, không fallback (tránh toggle đóng/mở)
async function singleClick(page, handle) {
  try { await page.evaluate(el => el.scrollIntoView({block:'center',inline:'center'}), handle); } catch {}
  try { await page.evaluate(el => el.click(), handle); return true; } catch {}
  try { await handle.click(); return true; } catch {}
  return false;
}

// Mở overlay xác nhận xóa và chờ modal hiện rõ (không di chuột/scroll thêm)
// === XÓA HỒ SƠ ATOMIC: mở overlay & xác nhận ngay trong cùng 1 evaluate ===
async function atomicOpenAndConfirmDelete(page, profileNameForConfirm = null, timeoutMs = 2500) {
  const ok = await page.evaluate(async (profileName, timeout) => {
    // 1) Mở overlay xóa (click ngay nút Xóa hồ sơ ở trang /settings/<ID>)
    const openBtn =
      document.querySelector('button[data-uia="profile-settings-page+delete-profile+destructive-button"]') ||
      document.querySelector('[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]') ||
      document.querySelector('button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]');
    if (!openBtn) return false;
    openBtn.click();

    // 2) Chờ modal/dialog xuất hiện (poll nhanh)
    const start = Date.now();
    function findDialog() {
      return document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]');
    }
    while (!findDialog()) {
      if (Date.now() - start > timeout) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    const dialog = findDialog();

    // 3) Khoá scroll để tránh overlay tự đóng do wheel/scroll
    try { document.documentElement.style.overflow = 'hidden'; } catch {}

    // 4) Tick mọi checkbox “Tôi hiểu/Confirm” nếu có
    dialog.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach(el => {
      try {
        if (el instanceof HTMLInputElement) {
          if (!el.checked) el.click();
        } else {
          if (el.getAttribute('aria-checked') === 'false') el.click();
        }
      } catch {}
    });

    // 5) Nếu yêu cầu gõ tên hồ sơ → điền luôn
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

    // 6) Tìm nút xác nhận trong dialog và click
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

// ==== Utility: kiểm tra visible/enabled ====
function __isClickable(el) {
  if (!el) return false;
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  if (el.disabled) return false;
  return true;
}

// ==== Utility: tìm trong shadow DOM ====
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
    // shadow root
    if (node.shadowRoot) stack.push(node.shadowRoot);
    // children
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return null;
}

// ==== Bấm nút "Xóa hồ sơ" (trả true nếu click được) ====

// Đóng mọi toast/snackbar có thể che nút trong modal
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

// Tìm dialog trong mọi frame
async function findDialogAnyFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    const handle = await f.$('div[role="dialog"], [data-uia="modal"]');
    if (handle) return { frame: f, handle };
  }
  return null;
}

// Bấm nút "Xóa hồ sơ" trong modal (đa frame, có đóng toast, cuộn, Enter/Space, click)

// === 1) Click nút "Xóa hồ sơ" TRÊN TRANG /settings/<ID> (main frame, 1 lần) ===
async function clickDeleteProfileButtonStrict(page, { retry = 3 } = {}) {
  const SELECTORS = [
    'button[data-uia="profile-settings-page+delete-profile+destructive-button"]',
    '[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
    'button[data-uia*="delete-profile" i]',
  ];
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
      btn.click(); // 1 lần duy nhất
      return true;
    }, { SELECTORS, KEYWORDS }).catch(() => false);

    if (ok) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// === 2) Click nút "Xóa hồ sơ" TRONG MODAL (strict: chặn phím, đóng toast, không blur) ===
async function clickConfirmDeleteInDialog(page, timeoutMs = 6000) {
  // Đợi modal xuất hiện
  const hasDialog = await page.waitForFunction(() =>
    !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
  if (!hasDialog) return false;

  // Đóng toast/snackbar che khu vực
  await page.evaluate(() => {
    const sel = ['[data-uia*="toast"] [data-uia*="close"]','[aria-label*="đóng" i]','[aria-label*="close" i]'];
    sel.forEach(s => document.querySelectorAll(s).forEach(b => { try { b.click(); } catch {} }));
  }).catch(()=>{});

  // Ngăn Escape/Enter làm đóng modal hoặc kích hoạt thứ khác phía sau (lock)
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

  // Click đúng nút trong modal (quét trong modal thôi)
  const clicked = await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]');
    if (!dialog) return false;

    // Khoá scroll nền + đưa modal vào giữa
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
    target.click(); // 1 lần, không phát phím
    return true;
  }).catch(() => false);

  // Bỏ trap phím (dọn dẹp)
  await page.evaluate(() => {
    if (window.__nfDelTrap) {
      document.removeEventListener('keydown', window.__nfDelTrap, true);
      window.__nfDelTrap = null;
    }
  }).catch(()=>{});

  return !!clicked;
}

/* ============== XÓA HỒ SƠ – chỉ thao tác trên /settings/<ID> ============== */
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

  // ===== Helper nội bộ: click nút "Xóa hồ sơ" chắc chắn =====
  async function clickDeleteProfileButtonStrict() {
    const SELECTORS = [
      'button[data-uia="profile-settings-page+delete-profile+destructive-button"]',
      '[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
      'button[data-cl-view="deleteProfile"][data-cl-command="SubmitCommand"]',
      'button[data-uia*="delete-profile" i]',
    ];
    const KEYWORDS = ['xóa hồ sơ','xoá hồ sơ','delete profile','delete'];

    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const f of page.frames()) {
        const clicked = await f.evaluate(({ SELECTORS, KEYWORDS }) => {
          function visible(el) {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && !el.disabled;
          }
          let btn = null;
          for (const sel of SELECTORS) {
            const cand = document.querySelector(sel);
            if (cand && visible(cand)) { btn = cand; break; }
          }
          if (!btn) {
            const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
            btn = nodes.find(n => {
              const t = (n.textContent || '').toLowerCase();
              return visible(n) && KEYWORDS.some(k => t.includes(k));
            }) || null;
          }
          if (!btn) return false;
          try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { btn.focus(); } catch {}
          btn.click();
          return true;
        }, { SELECTORS, KEYWORDS }).catch(() => false);
        if (clicked) return true;
      }
      await sleep(200);
    }
    return false;
  }

  // 1) Click nút “Xóa hồ sơ” để mở overlay
console.log('🗑️ Tìm & bấm nút "Xóa hồ sơ"…');
const ok1 = await safeRun(() => clickDeleteProfileButtonStrict(), false);
if (!ok1) { console.log('❌ Không click được nút "Xóa hồ sơ".'); return false; }
await safeRun(() => Promise.race([
  page.waitForFunction(() =>
    !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
    { timeout: 8000 }
  ),
  // nếu UI thật sự điều hướng thì cũng bắt được
  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
]), null);

  // 2) Chờ overlay (modal) xuất hiện
  const overlayOk = await page.waitForFunction(() =>
    !!(document.querySelector('div[role="dialog"]') || document.querySelector('[data-uia="modal"]')),
    { timeout: 4000 }
  ).then(() => true).catch(() => false);
  if (!overlayOk) {
    console.log('⚠️ Overlay xác nhận không hiện. Thử click lại…');
    if (!await clickDeleteProfileButtonStrict()) {
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
if (!ok2) {
  await closeOverlaysIfAny(page);
  const retry = await safeRun(() => clickSecondDeleteButton(page, { timeoutMs: 6000 }), false);
  if (!retry) return false;
}


// (giữ nguyên các bước sau – nếu UI yêu cầu gõ tên/checkbox/mật khẩu)
await typeProfileNameInConfirmDialog(page, profileNameForConfirm); // nếu cần gõ tên
await clickConfirmDeleteDialogsIfAny(page); // tick checkbox / nút OK phụ
await confirmDangerInDialog(page);          // phòng khi Netflix render thêm nút xác nhận
await handleIdentityVerifyModal(page, password); // bắt case yêu cầu nhập mật khẩu

  // 6) Chờ tín hiệu đã xóa hoặc quay về danh sách hồ sơ
  const redirected = await Promise.race([
    page.waitForFunction(() => /\/account\/profiles/i.test(location.pathname),
      { timeout: 15000 }).then(() => true).catch(() => false),
    page.waitForResponse(res => {
      const u = res.url().toLowerCase();
      return res.status() >= 200 && res.status() < 300 &&
             /(delete.*profile|profile.*delete|remove.*profile)/.test(u);
    }, { timeout: 15000 }).then(() => true).catch(() => false),
  ]);

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
  // Nếu truyền ID thẳng
  if (/^[A-Z0-9]+$/.test(profileOrId)) {
    return await deleteProfileBySettingsId(page, profileOrId, password, refererUrl);
  }

  // Nếu truyền tên hồ sơ → mở để lấy settingsId
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
  } else {
    console.log('⚠️ Xóa không thành công – giữ nguyên trang hiện tại để kiểm tra.');
  }
  await new Promise(()=>{});
  return;
}

if (isFourDigits) {
  const okPin = await setPinSmart(page, settingsId, HARDCODED_PASSWORD, rawArg, refererUrl);
  if (!okPin) console.log('❌ Không thay/đặt được PIN. Xem log ở trên.');
  await new Promise(() => {}); 
  return;
}

// Không truyền gì → chỉ mở trang khóa hồ sơ
await hardGotoLock(page, settingsId, refererUrl);
console.log('ℹ️ Không truyền PIN hoặc delete → chỉ mở trang khóa hồ sơ.');
await new Promise(() => {});
return;

  } catch (err) {
  if (isBenignNavError(err)) {
    // Nếu đã ở trang xác nhận xóa thành công thì im lặng thoát
    try {
      const href = page?.url?.() || '';
      if (/\/account\/profiles\b/i.test(href)) {
        const okParam = /[?&]profileDeleted=success\b/i.test(href);
        if (okParam) {
          console.log('✅ Xóa hồ sơ thành công (đã về profiles?profileDeleted=success).');
          return; // KHÔNG in cảnh báo nữa
        }
      }
    } catch {}

    // Nếu chưa chắc chắn là thành công, vẫn in cảnh báo và giữ trình duyệt mở
    console.warn('⚠️ Bỏ qua lỗi do điều hướng:', err.message);
    await new Promise(() => {}); // giữ trình duyệt mở để kiểm tra
    return;
  }
  console.error('❌ Lỗi ngoài ý muốn:', err);
  await cleanup(1);
}
})(); // <- ĐÓNG IIFE Ở ĐÂY
