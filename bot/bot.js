// Discord bot สำหรับจัดการ whitelist ของ TikTok Streak (slash commands)
// ไฟล์เดียวจบ — ไม่ต้องมี whitelist.js แยก
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const crypto = require("crypto");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID
const OWNER_ID = process.env.OWNER_ID; // Discord User ID ของเจ้าของ
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // PAT (repo / Contents: read+write)
const GITHUB_REPO = process.env.GITHUB_REPO; // เช่น "booto123456/TikTok-Streak"
const WHITELIST_KEY = process.env.WHITELIST_KEY; // hex 64 ตัว (ต้องตรงกับฝั่ง TikTok bot)

const missing = [
  ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
  ["CLIENT_ID", CLIENT_ID],
  ["OWNER_ID", OWNER_ID],
  ["GITHUB_TOKEN", GITHUB_TOKEN],
  ["GITHUB_REPO", GITHUB_REPO],
  ["WHITELIST_KEY", WHITELIST_KEY],
]
  .filter(([, v]) => !v || String(v).trim() === "")
  .map(([k]) => k);

if (missing.length) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}

// ---------- เข้ารหัส whitelist (AES-256-GCM, รูปแบบเดียวกับ index.js) ----------
// base64( iv 12 byte | tag 16 byte | ciphertext )
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

// ---------- GitHub API ----------
// รองรับทั้งไฟล์เข้ารหัส (whitelist.enc) และไฟล์เก่า (whitelist.json)
const FILE_CANDIDATES = ["whitelist.enc", "whitelist.json"];
let activePath = FILE_CANDIDATES[0];

const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "whitelist-bot",
};

async function readWhitelist() {
  for (const p of FILE_CANDIDATES) {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${p}`, {
      headers: ghHeaders,
    });
    if (res.status === 404) continue;
    if (res.status === 401)
      throw new Error("GITHUB_TOKEN ไม่ถูกต้องหรือหมดอายุ (401) — สร้าง token ใหม่");
    if (res.status === 403)
      throw new Error("token ไม่มีสิทธิ์เขียน (403) — ต้องตั้ง Contents = Read and write");
    if (!res.ok) throw new Error(`อ่าน GitHub ไม่สำเร็จ: HTTP ${res.status} (${p})`);

    const data = await res.json();
    activePath = p;
    const raw = Buffer.from(data.content, "base64").toString("utf8");

    if (p.endsWith(".enc")) {
      try {
        return { list: decrypt(raw, WHITELIST_KEY), sha: data.sha };
      } catch {
        throw new Error(
          "ถอดรหัส whitelist.enc ไม่ได้ — WHITELIST_KEY ไม่ตรงกับที่ใช้เข้ารหัสไฟล์"
        );
      }
    }
    return { list: JSON.parse(raw), sha: data.sha };
  }
  throw new Error(
    `ไม่พบ ${FILE_CANDIDATES.join(" หรือ ")} ใน ${GITHUB_REPO} — ` +
      "ถ้า repo เป็น private ต้องให้ token เข้าถึง repo นี้ได้ (Contents: Read and write)"
  );
}

async function writeWhitelist(list, sha) {
  const body = { message: "bot: update whitelist", ...(sha ? { sha } : {}) };
  body.content = activePath.endsWith(".enc")
    ? encrypt(list, WHITELIST_KEY)
    : Buffer.from(JSON.stringify(list, null, 2)).toString("base64");

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${activePath}`,
    {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`เขียน GitHub ไม่สำเร็จ: HTTP ${res.status} ${detail.slice(0, 120)}`);
  }
}

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("whitelist")
    .setDescription("จัดการ whitelist ของ TikTok Streak")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("เพิ่มชื่อลง whitelist")
        .addStringOption((o) =>
          o.setName("name").setDescription("ชื่อที่แสดงใน TikTok DM").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ลบชื่อออกจาก whitelist")
        .addStringOption((o) =>
          o.setName("name").setDescription("ชื่อที่จะลบ").setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("แสดงรายการ whitelist ทั้งหมด")),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✓ ลงทะเบียน slash commands แล้ว");
  } catch (e) {
    console.error("ลงทะเบียน slash command ไม่สำเร็จ:", e.message);
  }
}

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "whitelist") return;

  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: "⛔ คุณไม่มีสิทธิ์ใช้คำสั่งนี้", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === "list") {
    try {
      const { list } = await readWhitelist();
      await interaction.editReply(
        list.length
          ? `📋 whitelist (${list.length}): ${list.join(", ")}`
          : "📋 whitelist ว่างอยู่"
      );
    } catch (e) {
      await interaction.editReply(`❌ ${e.message}`);
    }
    return;
  }

  const name = interaction.options.getString("name");
  try {
    const { list, sha } = await readWhitelist();
    if (sub === "add") {
      if (list.some((n) => String(n).toLowerCase() === name.toLowerCase())) {
        return interaction.editReply(`"${name}" อยู่ใน whitelist แล้ว`);
      }
      list.push(name);
      await writeWhitelist(list, sha);
      return interaction.editReply(`✅ เพิ่ม "${name}" ลง whitelist แล้ว (ทั้งหมด ${list.length})`);
    }
    if (sub === "remove") {
      const idx = list.findIndex((n) => String(n).toLowerCase() === name.toLowerCase());
      if (idx === -1) return interaction.editReply(`"${name}" ไม่อยู่ใน whitelist`);
      list.splice(idx, 1);
      await writeWhitelist(list, sha);
      return interaction.editReply(`🗑️ ลบ "${name}" แล้ว (เหลือ ${list.length})`);
    }
  } catch (e) {
    await interaction.editReply(`❌ ${e.message}`);
  }
});

client.once("ready", () => {
  console.log(`✓ Logged in as ${client.user.tag}`);
  registerCommands();
});

if (require.main === module) {
  client.login(DISCORD_BOT_TOKEN);
}

module.exports = { readWhitelist, writeWhitelist, encrypt, decrypt };
