// loginByCookie.js (ESM)
// Cookie login -> mở hồ sơ theo tên/ID -> ép vào /settings/lock/<ID>
// -> Nếu thấy "Xóa khóa hồ sơ" thì gỡ trước -> vào pinentry -> nhập PIN 4 số -> Save

import fs from "fs";
import puppeteer from "puppeteer";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const USER_DATA_DIR = "./chrome-profile";
/* ====== CONFIG (điền đúng) ====== */
const HARDCODED_PASSWORD = "minhnetflix"; // mật khẩu tài khoản để xác thực

/* ====== PHẦN 6: Graceful shutdown / dọn dẹp Chrome ====== */
let browser; // để cleanup dùng được
let page;

async function cleanup(exitCode = 0) {
  try { await page?.close().catch(() => {}); } catch {}
  try { await browser?.close().catch(() => {}); } catch {}
  process.exit(exitCode);
}

process.on("SIGINT",  () => { console.log("\n🛑 SIGINT (Ctrl+C) → đóng trình duyệt..."); cleanup(0); });
process.on("SIGTERM", () => { console.log("\n🛑 SIGTERM → đóng trình duyệt..."); cleanup(0); });
process.on("uncaughtException", (err) => { console.error("💥 uncaughtException:", err); cleanup(1); });
process.on("unhandledRejection", (reason) => { console.error("💥 unhandledRejection:", reason); cleanup(1); });

/* ============== Helpers chung ============== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromePath() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    process.env.CHROME_PATH, // ưu tiên nếu bạn set biến môi trường
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(home, "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  throw new Error("Không tìm thấy chrome.exe. Hãy cài Chrome hoặc set CHROME_PATH trỏ đúng file chrome.exe");
}

function loadCookies(pathFile = "./cookies.json") {
  const raw = JSON.parse(fs.readFileSync(pathFile, "utf-8"));
  if (Array.isArray(raw)) return { url: "https://www.netflix.com", cookies: raw };
  if (raw && Array.isArray(raw.cookies))
    return { url: raw.url || "https://www.netflix.com", cookies: raw.cookies };
  throw new Error("cookies.json sai định dạng (mảng hoặc { url, cookies:[...] })");
}

const sameSiteMap = {
  no_restriction: "None",
  None: "None",
  lax: "Lax",
  Lax: "Lax",
  strict: "Strict",
  Strict: "Strict",
};

function toCookies(bundle) {
  return (bundle.cookies || []).map((c) => {
    const out = {
      name: c.name,
      value: c.value,
      path: c.path || "/",
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite ? sameSiteMap[c.sameSite] : undefined,
    };
    if (typeof c.expirationDate === "number") {
      out.expires = Math.round(c.expirationDate);
    }
    // Nếu có domain thì dùng domain (áp cho mọi subdomain), KHÔNG set url
    if (c.domain) {
      out.domain = c.domain; // ví dụ ".netflix.com"
    } else {
      out.url = bundle.url || "https://www.netflix.com";
    }
    // SameSite=None => phải Secure
    if (out.sameSite === "None" && !out.secure) out.secure = true;
    return out;
  });
}

async function isErrorPage(page) {
  const t = await page.evaluate(() => document.body?.innerText || "");
  return /NSES[- ]?UHX/i.test(t) || /Đã xảy ra lỗi/i.test(t) || /An error occurred/i.test(t);
}

async function gentleReveal(page) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(100);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function loginWithCredentialsAndSave(page, email, password) {
  console.log("⚠️ Cookie login không thành công → thử login bằng email/mật khẩu...");

  await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2", timeout: 60000 });

  const emailInput = await page.$('input[name="userLoginId"]');
  const passInput = await page.$('input[name="password"]');
  const submitBtn = await page.$('button[type="submit"]');

  if (!emailInput || !passInput || !submitBtn) {
    console.log("❌ Không tìm thấy ô nhập email/mật khẩu.");
    return false;
  }

  await emailInput.type(email, { delay: 50 });
  await passInput.type(password, { delay: 50 });
  await submitBtn.click();

  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 });
  } catch {}

  // Kiểm tra login thành công hay không
  const url = page.url();
  if (!url.includes("/browse") && !url.includes("/profiles")) {
    console.log("❌ Login thất bại (kiểm tra email/password).");
    return false;
  }

  const cookies = await page.cookies();
  fs.writeFileSync("cookies.json", JSON.stringify({ url: "https://www.netflix.com", cookies }, null, 2), "utf-8");
  console.log("✅ Đăng nhập thành công & đã lưu cookies.json");

  return true;
}


/* ============== Quét & mở hồ sơ theo tên ============== */
async function getProfileNames(page) {
  return await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-cl-view="accountProfileSettings"]'));
    const names = blocks.map((b, i) =>
      (b.querySelector("p")?.textContent || b.textContent || `Hồ sơ ${i + 1}`)
        .trim()
        .split("\n")[0]
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
        ((b.querySelector("p")?.textContent || b.textContent || "") + "")
          .trim()
          .split("\n")[0];
      return first === name;
    });
    if (!block) return null;

    const li = block.closest("li") || block.parentElement;
    const btn =
      (li && li.querySelector('button[data-uia$="PressableListItem"]')) ||
      block.closest('button[data-uia$="PressableListItem"]') ||
      block.querySelector('button[data-uia$="PressableListItem"]') ||
      block;

    const r = btn.getBoundingClientRect();
    return {
      selector: btn.getAttribute("data-uia")
        ? `button[data-uia="${btn.getAttribute("data-uia")}"]`
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
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
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
      console.log("❌ Không thấy hồ sơ:", profileName);
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
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => null),
      page.waitForFunction(() => /\/settings\//i.test(location.pathname), { timeout: 8000 }).catch(() => null),
    ]);
    if (await isErrorPage(page)) {
      console.log("⚠️ Trang lỗi sau khi mở hồ sơ → reload…");
      try { await page.goto(page.url(), { waitUntil: "networkidle2", timeout: 60000 }); } catch {}
    }
    const id = extractSettingsId(page.url());
    if (id) {
      const settingsUrl = page.url();
      console.log("✅ Lấy được settingsId:", id, "(", settingsUrl, ")");
      return { id, settingsUrl };
    }
    await page.goto("https://www.netflix.com/account/profiles", { waitUntil: "networkidle2", timeout: 60000 });
    await gentleReveal(page);
    await sleep(300 + i * 200);
  }
  console.log("❌ Không lấy được settingsId cho:", profileName);
  return null;
}

/* ============== Click helpers ============== */
async function clickWithAllTricks(page, handle) {
  try { await page.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" }), handle); } catch {}
  try { await page.evaluate(el => el.click(), handle); return true; } catch {}
  try { await handle.click({ delay: 20 }); return true; } catch {}
  try {
    await page.evaluate(el => {
      el.focus();
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
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

async function queryInAllFrames(page, selector) {
  for (const f of page.frames()) {
    const h = await f.$(selector);
    if (h) return { frame: f, handle: h };
  }
  return null;
}

// Click nút "Tạo khóa hồ sơ" trong mọi frame + mọi chiêu
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
    try { await frame.evaluate(el => el.scrollIntoView({ block: "center", inline: "center" }), handle); } catch {}
    try { await handle.click({ delay: 20 }); return true; } catch {}
    try {
      await frame.evaluate(el => {
        el.focus();
        const o = { bubbles: true, cancelable: true, view: window, buttons: 1 };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        el.dispatchEvent(new MouseEvent("mousedown", o));
        el.dispatchEvent(new MouseEvent("mouseup", o));
        el.dispatchEvent(new PointerEvent("pointerup", o));
        el.dispatchEvent(new MouseEvent("click", o));
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
  try { await page.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }), handle); } catch {}
  try { await handle.click({ delay: 20 }); return true; } catch {}
  try {
    await page.evaluate((el) => {
      el.focus();
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
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
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(refererUrl ? { Referer: refererUrl } : {}),
  });
  const tryOnce = async (how) => {
    if (how === "goto")
      await page.goto(lockUrl, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    else if (how === "href")
      await page.evaluate((u) => { location.href = u; }, lockUrl).catch(() => {});
    else if (how === "assign")
      await page.evaluate((u) => { window.location.assign(u); }, lockUrl).catch(() => {});

    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => null),
      page.waitForFunction(
        (id) => location.pathname.includes(`/settings/lock/${id}`) || /\/settings\//.test(location.pathname),
        { timeout: 8000 }, settingsId
      ).catch(() => null),
    ]);

    if (await isErrorPage(page)) {
      console.log("⚠️ Trang lỗi sau khi vào lock → reload…");
      await page.goto(page.url(), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
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
  if (await tryOnce("goto"))   return true;
  if (await tryOnce("href"))   return true;
  if (await tryOnce("assign")) return true;
  return false;
}

/* ============== Flow: tới pinentry (Create/Edit -> Confirm -> pass) ============== */
async function goPinAndAuth(page, settingsId, password, refererUrl) {
  const SUCCESS_RE = /\/settings\/lock\/pinentry/i;
  const CONFIRM_SEL = '[data-uia="account-mfa-button-PASSWORD+PressableListItem"]';
  const PASS_INPUT_SEL = '[data-uia="collect-password-input-modal-entry"]';
  const TIMEOUTS = { first: 12000, input: 12000, final: 20000, grace: 7000 };

  // 1) Điều hướng cứng vào /settings/lock/<ID>
  const okNav = await hardGotoLock(page, settingsId, refererUrl);
  if (!okNav) {
    console.log("❌ Không thể điều hướng vào /settings/lock/", settingsId);
    return false;
  }
  if (SUCCESS_RE.test(page.url())) {
    console.log("✅ Đã ở pinentry (không cần nhập pass).");
    return true;
  }

  // Nếu đang có nút Remove ⇒ đang khóa sẵn → caller sẽ gỡ, không bấm Edit
  const hasRemove = await page.$('button[data-uia="profile-lock-page+remove-button"], [data-cl-command="RemoveProfileLockCommand"]');
  if (hasRemove) {
    console.log('🔒 Đang có khóa hồ sơ (thấy nút "Xóa khóa hồ sơ") → bỏ qua Edit.');
    return false;
  }

  // 2) Click "Tạo khóa hồ sơ" trước
  let clicked = await clickCreateProfileLockAnyFrame(page);

  // 3) Nếu không có/không click được → thử "Chỉnh sửa mã PIN"
  if (!clicked) {
    const EDIT_SEL_TXT = `//button[
      contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'edit pin')
      or contains(normalize-space(.),'Chỉnh sửa mã PIN')
    ]`;
    let editBtn = await page.$('button[data-uia="profile-lock-page+edit-button"]');
    if (!editBtn) {
      const cand = await page.$x(EDIT_SEL_TXT);
      editBtn = cand && cand[0] ? cand[0] : null;
    }
    if (editBtn) {
      console.log('👉 Thấy nút "Chỉnh sửa mã PIN" — đang click...');
      clicked = await clickWithAllTricks(page, editBtn);
    }
  }

  // 4) Fallback: kích hoạt command trực tiếp
  if (!clicked) {
    const didCmd = await page.evaluate(() => {
      const el = document.querySelector('button[data-cl-command="AddProfileLockCommand"]');
      if (!el) return false;
      el.scrollIntoView({ block:'center', inline:'center' });
      el.click();
      return true;
    });
    if (didCmd) {
      console.log("👉 Kích hoạt AddProfileLockCommand trực tiếp.");
      clicked = true;
    }
  }

  // 5) Nếu vẫn không click được → dừng (trừ khi đã ở pinentry)
  if (!clicked) {
    console.log("❌ Không click được Tạo khóa/Chỉnh sửa. Lưu ảnh lock_debug.png để kiểm tra UI.");
    try { await page.screenshot({ path: "lock_debug.png", fullPage: true }); } catch {}
    if (!SUCCESS_RE.test(page.url())) return false;
  }

  // 6) Sau click: chờ thấy nút Confirm(PASSWORD) HOẶC đã vào pinentry
  const stage1Confirm = page.waitForSelector(CONFIRM_SEL, { visible: true, timeout: TIMEOUTS.first })
    .then(() => "confirm").catch(() => null);
  const stage1Url = page.waitForFunction(
    re => new RegExp(re,"i").test(location.href), { timeout: TIMEOUTS.first, polling: 300 }, SUCCESS_RE.source
  ).then(ok => ok ? "url" : null).catch(() => null);
  const stage1 = await Promise.race([stage1Confirm, stage1Url]);

  if (stage1 === "url") {
    console.log("✅ Vào pinentry ngay sau click.");
    return true;
  }
  if (stage1 !== "confirm") {
    console.log("❌ Không thấy Confirm & không vào pinentry. Lưu ảnh lock_after_click.png để debug.");
    try { await page.screenshot({ path: "lock_after_click.png", fullPage: true }); } catch {}
    return false;
  }

  // 7) Click Confirm → đợi input mật khẩu hoặc redirect thẳng
  const confirmBtn = await page.$(CONFIRM_SEL);
  if (!confirmBtn) { console.log("❌ confirmBtn biến mất."); return false; }
  await clickWithAllTricks(page, confirmBtn);

  const stage2Input = page.waitForSelector(PASS_INPUT_SEL, { timeout: TIMEOUTS.input, visible: true })
    .then(() => "input").catch(() => null);
  const stage2Url = page.waitForFunction(
    re => new RegExp(re, "i").test(location.href),
    { timeout: TIMEOUTS.input, polling: 300 }, SUCCESS_RE.source
  ).then(ok => ok ? "url" : null).catch(() => null);
  const stage2 = await Promise.race([stage2Input, stage2Url]);

  if (stage2 === "url") {
    console.log("✅ Redirect pinentry sau confirm (không cần nhập pass).");
    return true;
  }
  if (stage2 !== "input") {
    console.log("❌ Không thấy ô nhập password.");
    return false;
  }

  // 8) Nhập mật khẩu + Enter
  console.log("👉 Nhập mật khẩu…");
  const passInput = await page.$(PASS_INPUT_SEL);
  if (!passInput) { console.log("❌ passInput biến mất."); return false; }
  await passInput.type(password, { delay: 50 });
  await page.keyboard.press("Enter");

  const finalOk = await page.waitForFunction(
    re => new RegExp(re, "i").test(location.href),
    { timeout: TIMEOUTS.final, polling: 300 }, SUCCESS_RE.source
  ).then(() => true).catch(() => false);

  if (finalOk) { console.log("✅ Pass đúng → vào pinentry."); return true; }

  console.log("⏳ Grace recheck…");
  const start = Date.now();
  while (Date.now() - start < TIMEOUTS.grace) {
    if (SUCCESS_RE.test(page.url())) { console.log("✅ Pass đúng (grace)."); return true; }
    await sleep(300);
  }
  console.log("❌ Không redirect về pinentry.");
  return false;
}

/* ============== NHẬP 4 SỐ PIN & SAVE ============== */
async function setPinDigitsAndSave(page, pin4) {
  if (!/^\d{4}$/.test(pin4)) {
    console.log("❌ PIN phải là 4 chữ số.");
    return false;
  }

  const PIN_INPUT_CANDIDATES = [
    "input.pin-number-input",
    "input[data-uia*='pin']",
    "input[name*='pin' i]",
    "input[id*='pin' i]",
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"][maxlength="1"]',
    'input[type="password"][maxlength="1"]',
    'input[type="text"][maxlength="1"]',
  ].join(",");

  const first = await page.waitForSelector(PIN_INPUT_CANDIDATES, { visible: true, timeout: 12000 }).catch(() => null);
  if (!first) {
    console.log("❌ Không tìm thấy ô nhập PIN.");
    return false;
  }

  try {
    await first.click({ clickCount: 3 });
    await page.keyboard.type(pin4, { delay: 80 });
  } catch {}

  const inputs = await page.$$(PIN_INPUT_CANDIDATES);
  if (inputs.length >= 4) {
    try {
      await page.evaluate((sel) => {
        document.querySelectorAll(sel).forEach((i) => {
          i.value = "";
          i.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }, PIN_INPUT_CANDIDATES);
    } catch {}
    for (let i = 0; i < 4; i++) {
      try {
        await inputs[i].focus();
        await inputs[i].click({ clickCount: 2 });
        await page.keyboard.type(pin4[i], { delay: 50 });
      } catch {}
      await sleep(50);
    }
  }

  let save =
    (await page.$("button[data-uia*='save' i]")) ||
    (await page.$("button[type='submit']"));
  if (!save) {
    const all = await page.$$("button");
    for (const b of all) {
      const txt = (await page.evaluate((el) => el.textContent || "", b)).trim().toLowerCase();
      if (txt.includes("lưu") || txt.includes("save")) { save = b; break; }
    }
  }
  if (!save) {
    console.log("❌ Không tìm thấy nút Lưu.");
    return false;
  }

  console.log("👉 Bấm Lưu PIN…");
  const clicked = await robustClickHandle(page, save);
  if (!clicked) {
    console.log("❌ Không click được nút Lưu.");
    return false;
  }

  const ok = await Promise.race([
    page.waitForFunction(() => /\/settings\/lock(\/|$)/.test(location.pathname) && !/pinentry/.test(location.pathname), { timeout: 12000 }).then(() => true).catch(() => false),
    page.waitForFunction(() => {
      const t = document.body?.innerText || "";
      return /đã lưu|đã cập nhật|saved|updated/i.test(t);
    }, { timeout: 12000 }).then(() => true).catch(() => false),
  ]);

  if (ok) { console.log("✅ Đã lưu PIN 4 số."); return true; }
  console.log("⚠️ Không xác nhận được trạng thái lưu (có thể vẫn OK). Kiểm tra thủ công.");
  return false;
}

/* ============== XÓA KHOÁ HỒ SƠ (Remove profile lock) ============== */
async function clickRemoveProfileLockButton(page) {
  // 1) theo data-uia / command
  let btn =
    (await page.$('button[data-uia="profile-lock-page+remove-button"]')) ||
    (await page.$('[data-cl-command="RemoveProfileLockCommand"]')) ||
    (await page.$("button[data-uia*='remove' i]"));

  // 2) fallback theo text
  if (!btn) {
    const CANDIDATE_TEXTS = [
      "xóa khóa hồ sơ", "xoá khóa hồ sơ", "tắt khóa hồ sơ", "bỏ khóa hồ sơ",
      "remove profile lock", "disable profile lock", "remove lock", "delete profile lock",
    ];
    const nodes = await page.$$("button, [role='button']");
    for (const n of nodes) {
      const t = (await page.evaluate((el) => el.textContent || "", n)).trim().toLowerCase();
      if (CANDIDATE_TEXTS.some((s) => t.includes(s))) { btn = n; break; }
    }
  }

  if (!btn) return false;

  // bấm cứng tay
  if (!(await robustClickHandle(page, btn))) return false;

  // 3) nếu có modal xác nhận → bấm nút xác nhận
  try {
    const confirmBtn = await Promise.race([
      page.waitForXPath(`//button[
        contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'xóa')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'xoá')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'remove')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'ok')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'confirm')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'yes')
        or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'có')
      ]`, { timeout: 2000 }).catch(() => null),
      page.waitForSelector('[data-uia="modal"] button, [role="dialog"] button', { timeout: 2000 }).catch(() => null),
    ]);
    if (confirmBtn) {
      if (Array.isArray(confirmBtn) && confirmBtn[0]) { try { await confirmBtn[0].click({ delay: 20 }); } catch {} }
      else if (confirmBtn.click) { try { await confirmBtn.click({ delay: 20 }); } catch {} }
    }
  } catch {}

  return true;
}

async function disableProfileLockByRemove(page, settingsId, password, refererUrl) {
  // chắc chắn đang ở /settings/lock/<ID> (không phải pinentry)
  await hardGotoLock(page, settingsId, refererUrl);

  // nếu đang ở pinentry → quay về lock page
  if (/\/settings\/lock\/pinentry/i.test(page.url())) {
    try { await page.goBack({ waitUntil: "networkidle2", timeout: 8000 }); } catch {}
    if (/pinentry/i.test(page.url())) {
      try { await page.goto(`https://www.netflix.com/settings/lock/${settingsId}`, { waitUntil: "networkidle2", timeout: 60000 }); } catch {}
    }
  }

  // click "Xóa khóa hồ sơ"
  const removed = await clickRemoveProfileLockButton(page);
  if (!removed) {
    // Fallback: có trang dùng checkbox "Yêu cầu mã PIN..." → bỏ check
    const uncheck = await page.evaluate(() => {
      let changed = false;
      document.querySelectorAll('input[type="checkbox"]').forEach(ch => { if (ch.checked) { ch.click(); changed = true; } });
      return changed;
    });
    if (!uncheck) return false;
  }

  // Có thể Netflix hỏi lại mật khẩu
  const PASS_INPUT_SEL = '[data-uia="collect-password-input-modal-entry"]';
  try {
    const passField = await page.waitForSelector(PASS_INPUT_SEL, { visible: true, timeout: 3000 }).catch(() => null);
    if (passField) {
      await passField.type(password, { delay: 50 });
      await page.keyboard.press("Enter");
    }
  } catch {}

  // Bấm Lưu
  let saveBtn =
    (await page.$("button[data-uia*='save' i]")) ||
    (await page.$("button[type='submit']"));
  if (!saveBtn) {
    const all = await page.$$("button");
    for (const b of all) {
      const t = (await page.evaluate((el) => el.textContent || "", b)).trim().toLowerCase();
      if (t.includes("lưu") || t.includes("save")) { saveBtn = b; break; }
    }
  }
  if (!saveBtn) return false;
  await robustClickHandle(page, saveBtn);

  // Đợi rời pinentry hoặc thấy thông báo
  const ok = await Promise.race([
    page.waitForFunction(() => /\/settings\/lock(\/|$)/.test(location.pathname) && !/pinentry/.test(location.pathname),
      { timeout: 15000 }).then(() => true).catch(() => false),
    page.waitForFunction(() => /đã lưu|đã cập nhật|saved|updated/i.test(document.body?.innerText || ""),
      { timeout: 15000 }).then(() => true).catch(() => false),
  ]);
  return ok;
}

/* ============== ĐẶT PIN thông minh (gỡ trước nếu đã có) ============== */
async function setPinSmart(page, settingsId, password, newPin, refererUrl) {
  await hardGotoLock(page, settingsId, refererUrl);

  // Nếu thấy nút Remove ⇒ gỡ trước
  const hasRemove = await page.$('button[data-uia="profile-lock-page+remove-button"], [data-cl-command="RemoveProfileLockCommand"]');
  if (hasRemove) {
    console.log('🧹 Thấy nút "Xóa khóa hồ sơ" → gỡ khóa trước...');
    const off = await disableProfileLockByRemove(page, settingsId, password, refererUrl);
    if (!off) { console.log("❌ Không gỡ được khóa."); return false; }
  }

  // Sau khi chắc chắn đã gỡ/hoặc chưa bật ⇒ vào pinentry để tạo mới
  const ok = await goPinAndAuth(page, settingsId, password, refererUrl);
  if (!ok) { console.log("❌ Không vào được pinentry."); return false; }
  return await setPinDigitsAndSave(page, newPin);
}

/* ============== MAIN ============== */
(async () => {
  try {
    const arg = process.argv[2] || null;                       // Tên hồ sơ HOẶC ID (chỉ chữ & số)
    const pinArg = process.argv[3] || process.env.PIN || null; // PIN 4 số (tuỳ chọn)

    const bundle = loadCookies("./cookies.json");
    const cookies = toCookies(bundle);

    browser = await puppeteer.launch({
      headless: false,
      executablePath: findChromePath(), // dùng Chrome thật
      userDataDir: USER_DATA_DIR,       // profile bền
      defaultViewport: null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=vi-VN",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7" });

    // cookie login
    await page.goto("https://www.netflix.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

// clear cookie
try {
  const cur = await page.cookies();
  if (cur.length) await page.deleteCookie(...cur);
} catch {}

// set cookie từ file
for (const ck of cookies) {
  try { await page.setCookie(ck); } catch (e) { console.log("❌ cookie:", ck.name, e?.message || e); }
}

// kiểm tra cookie login có dùng được không
await page.goto("https://www.netflix.com/browse", { waitUntil: "networkidle2", timeout: 60000 });
const loginCheck = await page.evaluate(() => {
  return !(document.querySelector('form[action="/login"]') || location.pathname.includes("/login"));
});

if (!loginCheck) {
  const email = process.env.NETFLIX_EMAIL;
  const password = process.env.NETFLIX_PASSWORD;
  if (!email || !password) {
    console.log("❌ Thiếu biến môi trường NETFLIX_EMAIL hoặc NETFLIX_PASSWORD");
    await cleanup(1);
    return;
  }

  const loginOk = await loginWithCredentialsAndSave(page, email, password);
  if (!loginOk) {
    await cleanup(1);
    return;
  }
}

    let settingsId = null;
    let refererUrl = null;

    if (arg && /^[A-Z0-9]+$/.test(arg)) {
      // Người dùng truyền sẵn ID
      settingsId = arg;
      await page.goto("https://www.netflix.com/account/profiles", { waitUntil: "networkidle2", timeout: 60000 });
      refererUrl = "https://www.netflix.com/account/profiles";
    } else {
      // Người dùng truyền tên hồ sơ
      await page.goto("https://www.netflix.com/account/profiles", { waitUntil: "networkidle2", timeout: 60000 });
      await gentleReveal(page);
      if (!arg) {
        const names = await getProfileNames(page);
        console.log("🔎 Hồ sơ phát hiện:", names);
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
      if (!res) { console.log("❌ Không lấy được settingsId."); await new Promise(() => {}); return; }
      settingsId = res.id;
      refererUrl = res.settingsUrl;
    }

    console.log(`🆔 settingsId: ${settingsId}`);
    console.log(`🔐 PIN URL: https://www.netflix.com/settings/lock/${settingsId}`);

    // Thử vào pinentry (không bấm Edit nếu đang locked)
    const okAuth = await goPinAndAuth(page, settingsId, HARDCODED_PASSWORD, refererUrl);
    if (!okAuth) {
      console.log("ℹ️ Có thể hồ sơ đang bị khóa sẵn (đã thấy nút Remove). Sẽ xử lý theo nhánh thông minh.");
    }

    if (pinArg) {
      const okPin = await setPinSmart(page, settingsId, HARDCODED_PASSWORD, pinArg, refererUrl);
      if (!okPin) console.log("❌ Không thay/đặt được PIN. Xem log ở trên.");
    } else {
      await hardGotoLock(page, settingsId, refererUrl);
      console.log("ℹ️ Chưa truyền PIN 4 số → đang ở trang khóa hồ sơ.");
    }

    // Giữ tab mở để thao tác tay nếu muốn
    await new Promise(() => {});
  } catch (err) {
    console.error("❌ Lỗi ngoài ý muốn:", err);
    await cleanup(1);
  }
})();
