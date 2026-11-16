const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const figlet = require("figlet");
const moment = require("moment-timezone");
moment.tz.setDefault("Asia/Jakarta");
const { bold, red, yellow, blue, magenta, cyan, green } = require("kleur/colors");



const args = process.argv.slice(2);
const isDebug =
  args.includes("--debug") || /^(1|true|yes)$/i.test(String(process.env.DEBUG || ""));
// log ของ public repo มองเห็นได้ทุกคน — HIDE_NAMES=1 จะพิมพ์แค่ลำดับ ไม่พิมพ์ชื่อเพื่อน
const HIDE_NAMES = /^(1|true|yes)$/i.test(String(process.env.HIDE_NAMES || ""));
// DRY_RUN=1 → ไม่ส่งจริง แค่บอกว่าจะส่งให้ใคร (ใช้ทดสอบ)
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.DRY_RUN || ""));
const CREDENTIALS_FILE = path.join(__dirname, "cookies.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const loadConfig = () => {
  const fromEnv = process.env.CONFIG_JSON;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv);
    } catch {
      throw new Error("Invalid CONFIG_JSON environment variable");
    }
  }
  if (!fs.existsSync(CONFIG_FILE))
    throw new Error("config.json tidak ditemukan");
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    throw new Error("Invalid config.json");
  }
};
const CONFIG = loadConfig();
if (process.env.HEADLESS !== undefined) CONFIG.headless = process.env.HEADLESS === "true";
if (process.env.TOTAL_USERS !== undefined) CONFIG.totalUsers = Number(process.env.TOTAL_USERS);
if (process.env.MESSAGE !== undefined) CONFIG.message = process.env.MESSAGE;
const BROWSER_CONFIG = {
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
  ],
  headless: CONFIG.headless,
};
// TikTok ปฏิเสธ session ที่มาจาก Chrome แบบ headless ล้วนๆ — ปลอม UA ให้เหมือน Chrome จริง
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  BROWSER_CONFIG.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}
// ---------- whitelist ----------
// เก็บแบบเข้ารหัส (whitelist.enc) — ชื่อเพื่อนไม่ถูกเก็บเป็นข้อความใน public repo
const whitelistStore = require("./whitelist");

const fetchQuote = async () => {
  try {
    const res = await fetch("https://dummyjson.com/quotes/random");
    const data = await res.json();
    return `"${data.quote}" — ${data.author}`;
  } catch {
    return null;
  }
};

const sendDiscordAlert = async (url, missing) => {
  const content =
    "⚠️ **TikTok Streak Alert**\n" +
    "ไม่พบชื่อเหล่านี้ในแชทวันนี้:\n" +
    missing.map((m) => `- ${m}`).join("\n");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(green("[+] ส่งแจ้งเตือนไปยัง Discord แล้ว"));
  } catch (e) {
    console.log(red(`[!] ส่ง Discord webhook ไม่สำเร็จ: ${e.message}`));
  }
};



// ---------- cookies ----------
// รองรับทุกรูปแบบที่ extension ส่งออกมา (EditThisCookie / Cookie-Editor / puppeteer)
// แล้วแปลงเป็นรูปแบบที่ puppeteer รับได้
const normalizeCookies = (cookies) =>
  (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
    .map((c) => {
      const out = {
        name: c.name,
        value: c.value,
        domain: c.domain || ".tiktok.com",
        path: c.path || "/",
      };
      const exp = c.expires ?? c.expirationDate;
      if (typeof exp === "number" && exp > 0) out.expires = Math.floor(exp);
      if (typeof c.httpOnly === "boolean") out.httpOnly = c.httpOnly;
      if (typeof c.secure === "boolean") out.secure = c.secure;
      const ss = String(c.sameSite || "").toLowerCase();
      if (ss === "strict") out.sameSite = "Strict";
      else if (ss === "lax") out.sameSite = "Lax";
      else if (ss === "none" || ss === "no_restriction") out.sameSite = "None";
      return out;
    })
    .filter((c) => /(^|\.)tiktok\.com$/i.test(c.domain));

// ---------- diagnostics ----------
// ถ้าหา iframe ไม่เจอ ให้บอกสาเหตุ + ถ่ายภาพหน้าจอไว้ดู (ไม่พิมพ์ชื่อเพื่อน)
const diagnose = async (page, reason) => {
  console.log(red(`[!] ${reason}`));
  let url = "-";
  let title = "-";
  let iframes = [];
  try {
    url = page.url();
  } catch {}
  try {
    title = await page.title();
  } catch {}
  try {
    iframes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map((f) => f.src || "(no src)")
    );
  } catch {}
  console.log(red(`[!] URL: ${url}`));
  console.log(red(`[!] Title: ${title}`));
  console.log(red(`[!] iframe ที่พบ (${iframes.length}): ${iframes.join(" | ") || "-"}`));
  try {
    const shot = path.join(__dirname, "debug-screenshot.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(red(`[!] บันทึกภาพหน้าจอ: ${shot}`));
  } catch (e) {
    console.log(red(`[!] จับภาพหน้าจอไม่ได้: ${e.message}`));
  }
};

const IFRAME_SELECTORS = [
  "iframe[src*='/messages?allow_label=true&lang=en&scene=business']",
  "iframe[src*='/messages']",
  "iframe[src*='scene=business']",
];

const main = async () => {
  const banner = figlet.textSync("TikTok Streak", { font: CONFIG.bannerFont, horizontalLayout: "default", verticalLayout: "default" });
  console.clear();
  console.log(bold(cyan(banner)));
  console.log(yellow("\n[+] Made with 🚬 and ☕ by Saturia."));
  if (CONFIG.useQuotesAPi) console.log(blue("[+] Message: Random quote (dummyjson.com)"));
  else console.log(blue("[+] Message:", CONFIG.message));
  console.log(magenta("[+] Delay:", `${CONFIG.actionDelayMs} ms\n`));
  console.log(yellow(`[+] Mode: ${isDebug ? "Debug" : "Normal"}\n`));



  let credentials;
  if (process.env.COOKIES_JSON) {
    try {
      const data = JSON.parse(process.env.COOKIES_JSON);
      credentials = Array.isArray(data) ? { cookies: data } : { cookies: [data] };
      console.log(green("[+] Cookies loaded from COOKIES_JSON env var"));
    } catch {
      throw new Error("Invalid COOKIES_JSON environment variable");
    }
  } else if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
      credentials = Array.isArray(data) ? { cookies: data } : { cookies: [data] };
      console.log(yellow("[+] Cookies loaded from cookies.json (local only)"));
    } catch {
      throw new Error("Invalid session file");
    }
  } else {
    throw new Error("Session not found. Set COOKIES_JSON env var or create cookies.json");
  }



  let browser;
  try {
    browser = await puppeteer.launch(BROWSER_CONFIG);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(USER_AGENT);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });
    const rawCookies = Array.isArray(credentials.cookies) ? credentials.cookies : [];
    const cookieList = normalizeCookies(credentials.cookies);
    if (cookieList.length === 0)
      throw new Error("ไม่พบ cookie ของ tiktok.com ใน COOKIES_JSON (ตรวจรูปแบบไฟล์อีกครั้ง)");
    if (isDebug) {
      console.log(yellow(`[+] cookies ที่ส่งมา ${rawCookies.length} รายการ, ใช้จริง ${cookieList.length}`));
      console.log(yellow(`[+] ชื่อ cookies: ${cookieList.map((c) => c.name).join(", ")}`));
    }
    await page.setCookie(...cookieList);
    if (isDebug) console.log(yellow(`[+] ใส่ cookies ${cookieList.length} รายการ`));

    // --- pre-flight: ถาม TikTok ตรงๆ ว่า session นี้ยังใช้ได้จาก IP ของ runner ไหม ---
    if (isDebug) {
      const cookieHeader = cookieList.map((c) => `${c.name}=${c.value}`).join("; ");
      for (const aid of [1459, 1988]) {
        try {
          const res = await fetch(
            `https://www.tiktok.com/passport/web/account/info/?aid=${aid}&app_name=tiktok_web&device_platform=web`,
            {
              headers: {
                Cookie: cookieHeader,
                "User-Agent": USER_AGENT,
                Referer: "https://www.tiktok.com/",
              },
            }
          );
          const body = (await res.text()).replace(/\s+/g, " ").slice(0, 240);
          console.log(yellow(`[diag] account/info aid=${aid} → HTTP ${res.status}: ${body}`));
        } catch (e) {
          console.log(red(`[diag] account/info aid=${aid} ล้มเหลว: ${e.message}`));
        }
      }
    }
    if (isDebug) console.log(yellow("[+] Membuka halaman TikTok messages..."));
    await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle2", timeout: 60000 });
    if (/\/login/i.test(page.url())) {
      await diagnose(page, "TikTok เด้งไปหน้า login — cookies หมดอายุหรือไม่ถูกต้อง ต้อง export ใหม่");
      throw new Error("TikTok session expired (redirected to login)");
    }
    if (isDebug) console.log(yellow("[+] Halaman loaded, tunggu UI siap..."));
    await new Promise((r) => setTimeout(r, CONFIG.pageLoadDelayMs));



    let success = 0,
    failed = 0,
    skipped = 0,
    wouldSend = 0;
    // ถ้าถอดรหัสไม่ได้ (กุญแจผิด/ไฟล์เสีย) จะ throw แล้วหยุดทันที ไม่ยอมส่งหาทุกคน
    const whitelistRaw = whitelistStore.load({ debug: isDebug });
    const whitelist = (whitelistRaw || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    const matchedWhitelist = new Set();
    const skipGroups = !!CONFIG.skipGroups;
    const groupMarkers = CONFIG.groupNameMarkers || [","];
    // TikTok มี 2 โครงสร้าง: บางเวอร์ชันฝังรายการแชทใน iframe, เวอร์ชันใหม่ (2026) อยู่บนหน้าหลัก
    let ctx = page;
    let iframe = null;
    for (const sel of IFRAME_SELECTORS) {
      iframe = await page.$(sel);
      if (iframe) break;
    }
    if (iframe) {
      const frame = await iframe.contentFrame();
      if (frame) {
        ctx = frame;
        if (isDebug) console.log(green("[+] ใช้ iframe ของหน้า messages"));
      }
    } else if (isDebug) {
      console.log(green("[+] ใช้หน้าหลัก (ไม่พบ iframe) — โครงสร้างใหม่ของ TikTok"));
    }

    // รอให้รายการแชทขึ้นก่อน (หน้านี้ใช้เวลาเรนเดอร์)
    try {
      await ctx.waitForSelector('[data-e2e="dm-new-conversation-item"]', { timeout: 25000 });
      if (isDebug) console.log(green("[+] พบรายการแชทแล้ว"));
    } catch {
      await diagnose(page, "ไม่พบรายการแชท (dm-new-conversation-item)");
      throw new Error("Conversation list not found");
    }
    try {
      await ctx.waitForSelector("._TUXModal-wrapper", { visible: true, timeout: 3000});
      await ctx.evaluate(() => {
        const modal = document.querySelector("._TUXModal-wrapper");
        if (!modal) return;
        const rect = modal.getBoundingClientRect();
        const x = Math.max(1, rect.left - 10);
        const y = Math.max(1, rect.top - 10);
        document.elementFromPoint(x, y)?.click();
      });
    } catch (e) {
    }



    const itemCount = await ctx.evaluate(
      () => document.querySelectorAll('[data-e2e="dm-new-conversation-item"]').length
    );
    // totalUsers = 0 (หรือไม่ตั้ง) หมายถึงตรวจทั้งหมดที่มองเห็น
    const loopCount = CONFIG.totalUsers > 0 ? Math.min(CONFIG.totalUsers, itemCount) : itemCount;
    if (isDebug) console.log(green(`[+] พบ ${itemCount} บทสนทนา — จะตรวจ ${loopCount} รายการ`));

    for (let i = 0; i < loopCount; i++) {
      try {
        const userSelector = `div[data-index="${i}"] [data-e2e="dm-new-conversation-item"]`;
        await ctx.waitForSelector(userSelector, { timeout: 8000 });

        const nicknameSelector = `div[data-index="${i}"] [data-e2e="dm-new-conversation-nickname"]`;
        const username = await ctx.evaluate((sel) => {
          return document.querySelector(sel)?.textContent?.trim() || "";
        }, nicknameSelector);
        const displayName = username || `user${i}`;
        const label = HIDE_NAMES ? `user #${i + 1}` : displayName;
        const lower = username.toLowerCase();

        // --- เงื่อนไข whitelist ---
        // ชื่อสั้น (1-2 ตัว) ต้องตรงทั้งชื่อเท่านั้น กัน "G" ไป match "kaning"
        if (whitelist.length > 0) {
          const matched = whitelist.find((w) =>
            lower === w || (w.length >= 3 && lower.includes(w))
          );
          if (!matched) {
            if (isDebug) console.log(yellow(`  [${i + 1}/${loopCount}] SKIP (ไม่อยู่ใน whitelist): ${label}`));
            skipped++;
            continue;
          }
          matchedWhitelist.add(matched);
        }

        // --- เงื่อนไขข้ามกลุ่ม: ชื่อมีตัวคั่นแบบชื่อสมาชิกหลายคน ---
        if (skipGroups && groupMarkers.some((m) => username.includes(m))) {
          if (isDebug) console.log(yellow(`  [${i + 1}/${loopCount}] SKIP (เป็นกลุ่ม): ${label}`));
          skipped++;
          continue;
        }

        // --- โหมดทดสอบ: ไม่ส่งจริง แค่บอกว่าจะส่งให้ใคร ---
        if (DRY_RUN) {
          console.log(cyan(`  [DRY RUN] จะส่งให้: ${label}`));
          wouldSend++;
          continue;
        }

        await ctx.click(userSelector);
        console.log(yellow(`\n[${i + 1}/${loopCount}] Mengirim pesan ke: ${label}`));
        await new Promise((r) => setTimeout(r, 500));
        if (isDebug) console.log(yellow("  [~] Mencari editor..."));
        await ctx.waitForSelector("div.notranslate.public-DraftEditor-content", { timeout: 10000 });
        const editor = await ctx.$("div.notranslate.public-DraftEditor-content");
        if (!editor) throw new Error("Editor not found");
        await editor.click();
        await new Promise((r) => setTimeout(r, CONFIG.afterClickDelayMs));
        let message = CONFIG.message;
        if (CONFIG.useQuotesAPi) {
          const quote = await fetchQuote();
          if (!quote) throw new Error("Gagal fetch quote");
          message = quote;
          if (isDebug) console.log(cyan(`  [~] Quote: ${quote}`));
        }
        await page.keyboard.type(message, { delay: CONFIG.typeDelayMs });
        await new Promise((r) => setTimeout(r, CONFIG.afterSendDelayMs));
        // กันเคสพิมพ์ไม่ออก (เช่น emoji อย่างเดียว) แล้วกด Enter ส่งข้อความว่าง
        const typedText = await ctx.evaluate(
          () => document.querySelector("div.notranslate.public-DraftEditor-content")?.textContent || ""
        );
        if (!typedText.trim()) throw new Error("พิมพ์ข้อความลงช่องไม่สำเร็จ (ช่องว่าง)");
        if (isDebug) console.log(cyan(`  [~] ข้อความในช่อง: ${JSON.stringify(typedText.trim())}`));
        if (isDebug) console.log(blue("  [~] Mengirim dengan Ctrl+Enter..."));
        await page.keyboard.down("Control");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Control");
        await new Promise((r) => setTimeout(r, CONFIG.afterSendDelayMs));
        console.log(green(`  [✓] Terkirim!`));
        success++;
      } catch (e) {
        if (isDebug) console.log(red(`  [✗] Error: ${e.message}`));
        failed++;
      }



      if (i < loopCount - 1) {
        if (isDebug) console.log(yellow(`  [~] Tunggu ${CONFIG.actionDelayMs} ms...`));
        await new Promise((r) => setTimeout(r, CONFIG.actionDelayMs));
      }
    }



    console.log(green(`\n[+] SELESAI!`));
    console.log(blue(`[+] Success: ${success}`));
    console.log(red(`[+] Failed: ${failed}`));
    console.log(yellow(`[+] Skipped: ${skipped}`));
    if (DRY_RUN) console.log(cyan(`[+] DRY RUN — จะส่งให้ ${wouldSend} คน (ยังไม่ได้ส่งจริง)`));

    // --- แจ้งเตือนถ้ามีชื่อใน whitelist ที่ไม่ถูกพบ ---
    if (whitelist.length > 0) {
      const missing = whitelist.filter((w) => !matchedWhitelist.has(w));
      if (missing.length > 0) {
        const warn = HIDE_NAMES
          ? `ไม่พบชื่อใน whitelist ${missing.length} รายการ (ซ่อนรายชื่อเพราะเปิด HIDE_NAMES)`
          : `ไม่พบชื่อใน whitelist: ${missing.join(", ")}`;
        console.log(red(`\n[!] ${warn}`));
        const webhookUrl = process.env.DISCORD_WEBHOOK;
        if (webhookUrl) {
          await sendDiscordAlert(webhookUrl, missing);
        } else {
          console.log(red(`[!] (ไม่ได้ตั้ง DISCORD_WEBHOOK จึงไม่มีการแจ้งเตือน)`));
        }
      } else {
        console.log(green(`[+] พบชื่อใน whitelist ครบทุกคน`));
      }
    }
    console.log("");
    await new Promise((r) => setTimeout(r, CONFIG.finishDelayMs));
  } catch (e) {
    console.error(red("[!] Fatal error:", e.message));
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
};



main();
