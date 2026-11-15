const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const crypto = require("crypto");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID ของบอท (ใช้ลงทะเบียน slash command)
const OWNER_ID = process.env.OWNER_ID; // Discord User ID ของเจ้าของ (มีสิทธิ์ใช้คำสั่ง)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // GitHub PAT (scope: repo)
const GITHUB_REPO = process.env.GITHUB_REPO; // เช่น "booto123456/TikTok-Streak"
const WHITELIST_KEY = process.env.WHITELIST_KEY; // กุญแจเดียวกับ GitHub Secret WHITELIST_KEY (hex 64 ตัว)
const FILE_PATH = "whitelist.enc";

if (!DISCORD_BOT_TOKEN || !CLIENT_ID || !OWNER_ID || !GITHUB_TOKEN || !GITHUB_REPO || !WHITELIST_KEY) {
  console.error(
    "Missing env vars. ต้องตั้ง: DISCORD_BOT_TOKEN, CLIENT_ID, OWNER_ID, GITHUB_TOKEN, GITHUB_REPO, WHITELIST_KEY"
  );
  process.exit(1);
}

// ---------- เข้ารหัส whitelist ----------
// ใช้รูปแบบเดียวกับ index.js (AES-256-GCM) — ชื่อเพื่อนไม่ถูกเก็บเป็นข้อความใน repo
const { encrypt, decrypt } = require("../whitelist");

// ---------- GitHub API ----------
async function readWhitelist() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FILE_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "whitelist-bot",
    },
  });
  if (res.status === 404) return { list: [], sha: undefined };
  if (!res.ok) throw new Error(`อ่าน GitHub ไม่สำเร็จ: HTTP ${res.status}`);
  const data = await res.json();
  const encrypted = Buffer.from(data.content, "base64").toString("utf8");
  return { list: decrypt(encrypted, WHITELIST_KEY), sha: data.sha };
}

async function writeWhitelist(list, sha) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${FILE_PATH}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "whitelist-bot",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "bot: update whitelist",
      content: encrypt(list, WHITELIST_KEY),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`เขียน GitHub ไม่สำเร็จ: HTTP ${res.status}`);
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
    console.log("✓ Slash commands ลงทะเบียนแล้ว");
  } catch (e) {
    console.error("ลงทะเบียน slash command ไม่สำเร็จ:", e.message);
  }
}

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "whitelist") return;

  // auth: เจ้าของเท่านั้น
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: "⛔ คุณไม่มีสิทธิ์ใช้คำสั่งนี้", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === "list") {
    try {
      const { list } = await readWhitelist();
      await interaction.editReply(list.length ? `📋 whitelist: ${list.join(", ")}` : "📋 whitelist ว่างอยู่");
    } catch (e) {
      await interaction.editReply(`❌ ${e.message}`);
    }
    return;
  }

  const name = interaction.options.getString("name");
  try {
    const { list, sha } = await readWhitelist();
    if (sub === "add") {
      if (list.some((n) => n.toLowerCase() === name.toLowerCase())) {
        return interaction.editReply(`"${name}" อยู่ใน whitelist แล้ว`);
      }
      list.push(name);
      await writeWhitelist(list, sha);
      return interaction.editReply(`✅ เพิ่ม "${name}" ลง whitelist แล้ว`);
    }
    if (sub === "remove") {
      const idx = list.findIndex((n) => n.toLowerCase() === name.toLowerCase());
      if (idx === -1) return interaction.editReply(`"${name}" ไม่อยู่ใน whitelist`);
      list.splice(idx, 1);
      await writeWhitelist(list, sha);
      return interaction.editReply(`🗑️ ลบ "${name}" ออกจาก whitelist แล้ว`);
    }
  } catch (e) {
    await interaction.editReply(`❌ ${e.message}`);
  }
});

client.once("ready", () => {
  console.log(`✓ Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(DISCORD_BOT_TOKEN);
