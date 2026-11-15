const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// whitelist เก็บแบบเข้ารหัส เพื่อไม่ให้ชื่อเพื่อนอยู่ใน public repo
// รูปแบบไฟล์: base64( iv 12 byte | tag 16 byte | ciphertext ) ด้วย AES-256-GCM
// กุญแจ (hex 64 ตัว) อยู่ใน GitHub Secret ชื่อ WHITELIST_KEY เท่านั้น
const ENC_FILE = path.join(__dirname, "whitelist.enc");
const PLAIN_FILE = path.join(__dirname, "whitelist.json"); // local เท่านั้น (gitignored)

function encrypt(list, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(list, null, 2), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(base64, keyHex) {
  const raw = Buffer.from(String(base64).replace(/\s+/g, ""), "base64");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    raw.subarray(0, 12)
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  const plain = Buffer.concat([
    decipher.update(raw.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plain);
}

// ลำดับ: whitelist.enc (มีกุญแจ) -> whitelist.json (local) -> []
// ถ้ามีกุญแจแต่ถอดรหัสไม่ได้ จะ throw เพื่อไม่ให้เผลอส่งหาทุกคน
function load({ key = process.env.WHITELIST_KEY, debug = false } = {}) {
  if (key && fs.existsSync(ENC_FILE)) {
    const list = decrypt(fs.readFileSync(ENC_FILE, "utf8").trim(), key);
    if (debug) console.log("[+] โหลด whitelist จาก whitelist.enc");
    return list;
  }
  if (fs.existsSync(PLAIN_FILE)) {
    if (debug) console.log("[+] โหลด whitelist จาก whitelist.json (local)");
    return JSON.parse(fs.readFileSync(PLAIN_FILE, "utf8"));
  }
  return [];
}

module.exports = { encrypt, decrypt, load, ENC_FILE, PLAIN_FILE };
