const dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}
const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
require("dotenv").config();
const { OpenAI } = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdf = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");

// --- ENVIRONMENT VARIABLES VALIDATION ---
const REQUIRED_ENVS = ["BOT_TOKEN", "API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY"];
REQUIRED_ENVS.forEach((envName) => {
  if (!process.env[envName]) {
    console.error(`[❌ ERROR] Environment variable ${envName} is missing!`);
    process.exit(1);
  }
});

const PREFIX = "?"; 
const MAX_HISTORY = 10; 
const MAX_FILE_SIZE = 10 * 1024 * 1024; 
const COOLDOWN_TIME = 5000; 
const cooldowns = new Map();
// modelName -> timestamp kapan boleh dipakai lagi (dipakai saat kena 429)
const MODEL_COOLDOWN = new Map();
const BANNED_WORDS = ["exploit", "crash", "bypass system", "force shutdown"];

// --- MODEL CONFIGURATIONS (UPDATED — verified live 2026-11-07) ---
// FREE-ONLY. Setiap entri sudah dites langsung ke API provider.
// PENTING: model ":free" di OpenRouter berbagi kuota yang sama (~50 req/hari),
// jadi urutan di bawah mengutamakan provider yang kuotanya TERPISAH
// (Groq + Google) di depan agar 429 OpenRouter tidak mematikan seluruh bot.
// Model yang terbukti 429/error tetap disimpan sebagai cadangan paling akhir.
const VISION_MODELS = [
  // === GOOGLE NATIVE (kuota terpisah, terbukti OK) ===
  { provider: "google-native", name: "gemini-3.5-flash" }, // OK (verified)
  { provider: "google-native", name: "gemini-2.5-flash" }, // OK (verified)
  // === OPENROUTER (FREE multimodal — bisa 429) ===
  { provider: "openrouter", name: "nvidia/nemotron-3.5-super-vl:free" }, // OK, 1M ctx (text+image+video)
  { provider: "openrouter", name: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" }, // OK (text+audio+image+video)
  { provider: "openrouter", name: "dots-studio/dots-3-note-preview:free" }, // OK 512K ctx (text+image)
  { provider: "openrouter", name: "google/gemma-4-31b-it:free" }, // 429-prone, cadangan
  { provider: "openrouter", name: "google/gemma-4-26b-a4b-it:free" }, // 429-prone, cadangan
  { provider: "openrouter", name: "openrouter/free" }, // meta-router, upaya terakhir
];

// === TEXT MODELS (FREE-ONLY — verified live 2026-11-07) ===
// Urutan: Groq & Google dulu (kuota terpisah), OpenRouter :free belakangan.
const TEXT_MODELS = [
  // === GROQ (kuota terpisah, cepat, terverifikasi OK) ===
  { provider: "groq", name: "openai/gpt-oss-120b" }, // OK (verified)
  { provider: "groq", name: "qwen/qwen3.8-27b" }, // OK (verified)
  { provider: "groq", name: "openai/gpt-oss-20b" }, // OK (verified)
  // === GOOGLE NATIVE (kuota terpisah, terverifikasi OK) ===
  { provider: "google-native", name: "gemini-3.5-flash" }, // OK (verified)
  { provider: "google-native", name: "gemini-2.5-flash" }, // OK (verified)
  // === OPENROUTER (FREE — berbagi kuota, rawan 429) ===
  { provider: "openrouter", name: "nvidia/nemotron-3-ultra-550b-a55b:free" }, // OK, 1M ctx, 550B MoE
  { provider: "openrouter", name: "nvidia/nemotron-3.5-lightning:free" }, // OK, 1M ctx
  { provider: "openrouter", name: "nvidia/nemotron-3.5-super-vl:free" }, // OK, 1M ctx (multimodal)
  { provider: "openrouter", name: "recursive/flint-v1.0:free" }, // OK, 262K ctx
  { provider: "openrouter", name: "cohere/north-mini-code:free" }, // OK, 256K ctx, kode
  { provider: "openrouter", name: "xingchen-agi/xing4.0-29b-a4b:free" }, // 429-prone, cadangan
  { provider: "openrouter", name: "openrouter/free" }, // meta-router, upaya terakhir
];



const OR_API_KEY = process.env.API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const openrouter = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: OR_API_KEY });
const groq = new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ]
});

// --- DEPLOY SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Ask anything to the AI Assistant")
        .addStringOption(option => 
            option.setName("prompt")
                .setDescription("Your question or instruction (leave empty to open the ask form)")
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option.setName("file")
                .setDescription("Upload a PDF, Audio, Video, or Image file (Max 10MB)")
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName("message_id")
                .setDescription("Paste the Discord Message ID you want to reply to as context")
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName("reset")
        .setDescription("Clear your conversation chat history with the AI"),
    new SlashCommandBuilder()
        .setName("help")
        .setDescription("Show the complete guide and user manual for this bot"),
    new SlashCommandBuilder()
        .setName("admin")
        .setDescription("Open the admin control panel (owner only)")
        .setDefaultMemberPermissions(0)
].map(command => command.toJSON());

function setBotPresence(client) {
    if (!client.user) return;
    client.user.setPresence({
        activities: [{ name: "customstatus", type: ActivityType.Custom, state: `${PREFIX}ask or /help` }],
        status: "online",
    });
}

client.on('ready', async () => {
    console.log(`\n[🚀] Bot is ready as ${client.user.tag}`);
    setBotPresence(client);
    setInterval(() => setBotPresence(client), 10 * 60 * 1000);

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        console.log('[🔄] Updating Slash Commands (/) registration to Discord...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[✅] Successfully registered Slash Commands globally!\n');
    } catch (error) {
        console.error('[❌] Failed to register Slash Commands:', error);
    }
});

const sessions = new Map();
const userModelPreference = new Map(); // userId -> modelName

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 jam idle
// Bersihkan session & preferensi yang tidak aktif secara periodik (cegah memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - (session.lastActive ?? now) > SESSION_TTL_MS) sessions.delete(key);
  }
  for (const [key, value] of userModelPreference) {
    if (now - (value?.lastActive ?? now) > SESSION_TTL_MS) userModelPreference.delete(key);
  }
}, 30 * 60 * 1000).unref();

function getSessionId(channelId, userId) {
  return `${channelId}-${userId}`;
}

// Helper to get user's preferred model or fallback to first in list
function getUserPreferredModel(userId, isVisionContext) {
  const saved = userModelPreference.get(userId);
  if (saved && saved.name) return saved.name;
  const list = isVisionContext ? VISION_MODELS : TEXT_MODELS;
  return list[0]?.name || "";
}

// Simpan preferensi model user beserta penanda aktivitas
function setUserModelPreference(userId, modelName) {
  userModelPreference.set(userId, { name: modelName, lastActive: Date.now() });
}

// Helper to check if user is bot owner (admin)
function isAdmin(userId) {
  const ownerId = process.env.OWNER_ID;
  return ownerId && ownerId === userId;
}

// --- CAPABILITY / PERMISSION LAYER ---
// Satu sumber kebenaran untuk "siapa boleh apa". UI (tombol/embed) maupun
// handler memakai helper yang sama, sehingga fitur yang tidak boleh diakses
// tidak pernah dirender DAN tidak pernah tereksekusi.
// Tambah capability baru cukup di sini; UI otomatis mengikuti.
const CAPABILITIES = {
  // Selalu tersedia untuk semua user
  ask_ai: () => true,
  reset_memory: () => true,
  switch_model: () => true,
  view_help: () => true,
  // Khusus owner
  admin_panel: (userId) => isAdmin(userId),
  admin_stats: (userId) => isAdmin(userId),
  admin_clear_sessions: (userId) => isAdmin(userId),
  admin_reload_commands: (userId) => isAdmin(userId),
  admin_view_config: (userId) => isAdmin(userId),
};

// Cek apakah user punya capability tertentu. Default: DENY (fail-closed).
function can(userId, capability) {
  const rule = CAPABILITIES[capability];
  if (typeof rule !== "function") return false;
  try {
    return rule(userId) === true;
  } catch {
    return false;
  }
}

// Guard untuk handler interaction. Jika tidak berhak, balas pesan umum yang
// TIDAK membocorkan keberadaan fitur, lalu kembalikan false.
async function requireCapability(interaction, capability) {
  if (can(interaction.user.id, capability)) return true;
  console.warn(
    `[🔒 DENY] ${interaction.user.tag} (${interaction.user.id}) mencoba akses "${capability}"`
  );
  const respond = interaction.replied || interaction.deferred
    ? () => interaction.editReply({ content: "❌ Fitur ini tidak tersedia untuk Anda.", components: [] })
    : () => interaction.reply({ content: "❌ Fitur ini tidak tersedia untuk Anda.", ephemeral: true });
  await respond().catch(() => {});
  return false;
}

// Pastikan tombol memang milik user yang mengklik (mencegah "numpang" customId).
function isButtonOwner(interaction, ownerIdInCustomId) {
  return ownerIdInCustomId === interaction.user.id;
}

// Build model selector dropdown
function buildModelSelectMenu(userId, isVisionContext) {
  const isVision = !!isVisionContext;
  const list = isVision ? VISION_MODELS : TEXT_MODELS;
  const current = getUserPreferredModel(userId, isVision);

  const options = list.slice(0, 25).map(m => ({
    label: m.name.split('/').pop().replace(/[:]/g, ' '),
    description: m.provider,
    value: m.name,
    default: m.name === current
  }));

  return new StringSelectMenuBuilder()
    .setCustomId(`ai_bot:model_select:${userId}`)
    .setPlaceholder(isVision ? 'Select Vision Model' : 'Select Text Model')
    .addOptions(options);
}

// Build action buttons for AI response (returns both action rows)
function buildResponseActionRows(userId) {
  const mainRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`ai_bot:regenerate:${userId}`)
        .setLabel('🔁 Regenerate')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`ai_bot:switch_model:${userId}`)
        .setLabel('🔄 Switch Model')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ai_bot:copy_text:${userId}`)
        .setLabel('📋 Copy')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ai_bot:delete_msg:${userId}`)
        .setLabel('🗑️ Delete')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`ai_bot:settings:${userId}`)
        .setLabel('⚙️ Settings')
        .setStyle(ButtonStyle.Secondary)
    );

  const askRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`ai_bot:ask_open:${userId}`)
        .setLabel('🤖 Ask AI')
        .setStyle(ButtonStyle.Primary)
    );

  return [mainRow, askRow];
}

// Build settings modal
function buildSettingsModal(channelId, userId) {
  const session = sessions.get(getSessionId(channelId, userId)) || {};
  const currentTemp = session.temperature ?? 0.7;
  const currentLanguage = session.language ?? "";

  return new ModalBuilder()
    .setCustomId(`ai_bot:settings_modal:${userId}`)
    .setTitle('⚙️ Bot Settings')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('temperature')
          .setLabel('Temperature (0.0 - 1.0)')
          .setPlaceholder('e.g., 0.7')
          .setStyle(TextInputStyle.Short)
          .setValue(String(currentTemp))
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('language')
          .setLabel('Response Language')
          .setPlaceholder('e.g., English, Indonesian')
          .setStyle(TextInputStyle.Short)
          .setValue(currentLanguage)
          .setRequired(false)
      )
    );
}

// Extract a Discord message snowflake from a raw ID or a message link
function parseMessageId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const matches = trimmed.match(/(\d{17,20})/g);
  return matches ? matches[matches.length - 1] : null;
}

// Turn a direct file/image URL into a pseudo-attachment the pipeline can process
function buildAskFromUrl(url) {
  if (!url || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const name = decodeURIComponent(parsed.pathname.split('/').pop()) || 'file';
    return { name, url: parsed.href };
  } catch (_) {
    return null;
  }
}

// Build the GUI ask modal (/ask form)
function buildAskModal(userId, channelId) {
  const session = sessions.get(getSessionId(channelId, userId)) || {};
  const currentLanguage = session.language ?? "";
  const currentTemp = session.temperature ?? 0.7;

  return new ModalBuilder()
    .setCustomId(`ai_bot:ask_modal:${userId}`)
    .setTitle('🤖 Ask AI')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ask_prompt')
          .setLabel('❓ Your question / instruction')
          .setPlaceholder('Type your question here… (e.g. Jelaskan teori relativitas)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ask_file_url')
          .setLabel('🔗 File / Image URL (optional)')
          .setPlaceholder('Direct link: image, PDF, audio, or video (https://…)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ask_context')
          .setLabel('💬 Reply-to message as context (optional)')
          .setPlaceholder('Paste a Discord message ID or message link here')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ask_temperature')
          .setLabel('🌡️ Temperature (0.0 - 1.0)')
          .setPlaceholder('e.g., 0.7')
          .setStyle(TextInputStyle.Short)
          .setValue(String(currentTemp))
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ask_language')
          .setLabel('🌐 Response language (optional)')
          .setPlaceholder('e.g., Indonesian, English')
          .setStyle(TextInputStyle.Short)
          .setValue(currentLanguage)
          .setRequired(false)
      )
    );
}

// Build help navigation action row
// Tombol admin HANYA dirender jika user punya capability-nya, sehingga user
// biasa tidak pernah melihat keberadaan fitur tersebut.
function buildHelpActionRow(userId) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ai_bot:ask_open:${userId}`)
      .setLabel('🤖 Ask AI')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ai_bot:help_commands:${userId}`)
      .setLabel('📖 Commands')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ai_bot:help_settings:${userId}`)
      .setLabel('⚙️ Settings')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ai_bot:help_examples:${userId}`)
      .setLabel('🎯 Examples')
      .setStyle(ButtonStyle.Success),
  ];

  if (can(userId, 'admin_panel')) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ai_bot:help_admin:${userId}`)
        .setLabel('🔧 Admin')
        .setStyle(ButtonStyle.Danger)
    );
  }

  return new ActionRowBuilder().addComponents(buttons);
}

// Build admin action row (reusable to reduce duplication)
function buildAdminActionRow(userId, { backToHelp = false } = {}) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ai_bot:admin_stats:${userId}`)
      .setLabel('📊 Bot Stats')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ai_bot:admin_clear:${userId}`)
      .setLabel('🧹 Clear Sessions')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ai_bot:admin_reload:${userId}`)
      .setLabel('🔄 Reload Commands')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ai_bot:admin_config:${userId}`)
      .setLabel('⚙️ View Config')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(backToHelp ? `ai_bot:help_commands:${userId}` : `ai_bot:help_admin:${userId}`)
      .setLabel(backToHelp ? '🔙 Back' : '🔙 Back to Admin')
      .setStyle(ButtonStyle.Secondary)
  ];
  return new ActionRowBuilder().addComponents(buttons);
}

// Build single back-navigation button row
function buildBackButtonRow(customId, userId, label = "🔙 Back") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
  );
}

// Build admin panel embed
function buildAdminPanelEmbed() {
  const uptime = Math.floor(process.uptime());
  const hours = String(Math.floor(uptime / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((uptime % 3600) / 60)).padStart(2, '0');
  const seconds = String(uptime % 60).padStart(2, '0');

  return new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('🤖 AI Bot Admin Panel')
    .addFields(
      { name: '📊 Status', value: `Online\nUptime: ${hours}:${minutes}:${seconds}`, inline: true },
      { name: '👥 Guilds', value: String(client.guilds.cache.size), inline: true },
      { name: '👤 Users', value: String(client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0)), inline: true },
      { name: '💾 Sessions', value: String(sessions.size), inline: true }
    )
    .setTimestamp();
}

// Build help embed with navigation.
// userId dipakai agar isi manual menyesuaikan hak akses: perintah admin
// tidak dicantumkan sama sekali bagi user yang tidak berhak.
function buildHelpEmbed(userId) {
  const fields = [
    { name: '🤖 Ask AI', value: 'Klik tombol **🤖 Ask AI** di atas (atau jalankan `/ask` tanpa mengisi prompt) untuk membuka form pertanyaan.', inline: false },
    { name: '⚡ Prefix Commands (`?`)', value: `• \`${PREFIX}<pertanyaan>\` — langsung tanya AI, mis. \`${PREFIX}hi\`\n• \`${PREFIX}ask [pertanyaan]\` — sama, bentuk eksplisit\n• \`${PREFIX}reset\` — Hapus memori percakapan.\n• \`${PREFIX}help\` — Tampilkan bantuan ini.`, inline: false },
    { name: '🎯 Slash Commands', value: '• `/ask prompt: [teks] file: [opsional] message_id: [opsional]`\n• `/reset`\n• `/help`', inline: false }
  ];

  // Baris admin hanya muncul untuk pemilik bot
  if (can(userId, 'admin_panel')) {
    fields.push({ name: '🔧 Owner Commands', value: '• `/admin` — buka panel kontrol bot', inline: false });
  }

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🤖 AI Assistant Hybrid Manual Guide')
    .setDescription('Sistem ini mendukung Slash Commands (`/`), Prefix Triggers (`?`), dan tombol interaktif.')
    .addFields(fields);
}

function sanitizeMessagesForModel(messages, isVisionModel) {
  return messages.map(msg => {
    if (msg.role === "system" || typeof msg.content === "string") return msg;
    if (!isVisionModel && Array.isArray(msg.content)) {
      const textOnly = msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      return { ...msg, content: textOnly };
    }
    return msg;
  });
}

async function transcribeMedia(mediaUrl, tempDir, isAudioOnly = false) {
  const uniqueId = crypto.randomUUID();
  const inputPath = path.join(tempDir, `in_${uniqueId}.${isAudioOnly ? 'mp3' : 'mp4'}`);
  const audioPath = path.join(tempDir, `out_${uniqueId}.mp3`);
  try {
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(inputPath, Buffer.from(response.data));
    if (!isAudioOnly) {
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath).toFormat("mp3").duration(120).on("end", resolve).on("error", reject).save(audioPath);
      });
    }
    const fileToUpload = isAudioOnly ? inputPath : audioPath;
    const form = new FormData();
    form.append("file", fs.createReadStream(fileToUpload));
    form.append("model", "whisper-large-v3");
    
    const whisperRes = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
      headers: { ...form.getHeaders(), "Authorization": `Bearer ${GROQ_API_KEY}` },
      timeout: 60000 
    });
    return whisperRes.data.text || "(No audible speech detected)";
  } catch (error) {
    return `(Transcription failed: ${error.message})`;
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
}

function splitMessage(text, maxLength = 1950) {
    if (!text) return ["_No content generated_"];
    const chunks = [];
    const lines = text.split('\n');
    let current = "";

    for (const line of lines) {
        if (current.length + line.length + 1 <= maxLength) {
            current += (current === "" ? "" : "\n") + line;
        } else {
            if (current !== "") chunks.push(current);
            if (line.length > maxLength) {
                let subLine = line;
                while (subLine.length > 0) {
                    chunks.push(subLine.substring(0, maxLength));
                    subLine = subLine.substring(maxLength);
                }
                current = "";
            } else {
                current = line;
            }
        }
    }
    if (current !== "") chunks.push(current);
    return chunks.length > 0 ? chunks : ["_Empty_"];
}

async function fetchWithFallback(messagesArray, isVisionContext, { userId = undefined, temperature = 0.7, language = "" } = {}) {
  const baseList = isVisionContext ? VISION_MODELS : TEXT_MODELS;
  // Prioritaskan model yang dipilih user (preferensi), sisanya sebagai fallback
  let modelList = baseList.slice();
  if (userId && userModelPreference.has(userId)) {
    const pref = userModelPreference.get(userId)?.name;
    if (pref) {
      const prefIdx = modelList.findIndex(m => m.name === pref);
      if (prefIdx > 0) {
        const [favorite] = modelList.splice(prefIdx, 1);
        modelList.unshift(favorite);
      }
    }
  }
  const timeoutMS = 60000;

  // Buang model yang sedang dalam masa cooldown akibat 429. Jika SEMUA model
  // sedang cooldown, tetap coba semuanya (lebih baik mencoba daripada gagal total).
  const now = Date.now();
  const freshList = modelList.filter(m => (MODEL_COOLDOWN.get(m.name) || 0) <= now);
  if (freshList.length > 0) {
    modelList = freshList;
  } else {
    console.warn("[⏳ RATE-LIMIT] Semua model sedang cooldown, tetap mencoba ulang.");
  } 

  for (const model of modelList) {
    let timeoutId;
    try {
      console.log(`[🔄 MODEL] Mencoba menghubungkan ke: ${model.name} (${model.provider})`);
      const safeMessages = sanitizeMessagesForModel(messagesArray, isVisionContext);
      
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout ${timeoutMS / 1000}s terlampaui`)), timeoutMS);
      });
      
      const genConfig = {
        temperature: typeof temperature === "number" ? temperature : 0.7
      };
      let apiCallPromise;

      if (model.provider === "openrouter") {
        apiCallPromise = (async () => {
          const completion = await openrouter.chat.completions.create({ 
            model: model.name, messages: safeMessages, ...genConfig
          });
          if (!completion.choices?.length) throw new Error("Data kosong dari hulu");
          return { text: completion.choices[0].message.content };
        })();
      } 
      else if (model.provider === "groq") {
        apiCallPromise = (async () => {
          const completion = await groq.chat.completions.create({
            model: model.name, messages: safeMessages, ...genConfig
          });
          if (!completion.choices?.length) throw new Error("Data kosong dari hulu");
          return { text: completion.choices[0].message.content };
        })();
      }
      else if (model.provider === "google-native") {
        apiCallPromise = (async () => {
          const systemPrompt = safeMessages.find(msg => msg.role === "system")?.content || "";
          const genModel = genAI.getGenerativeModel({ model: model.name, systemInstruction: systemPrompt, generationConfig: genConfig });
          
          const historySlice = safeMessages.slice(1, -1);
          const formattedHistory = historySlice.map(msg => {
              let textContent = typeof msg.content === "string" ? msg.content : msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
              return { role: msg.role === "assistant" ? "model" : "user", parts: [{ text: textContent }] };
          });
          
          const chat = genModel.startChat({ history: formattedHistory.length > 0 ? formattedHistory : undefined });
          const lastMsg = safeMessages[safeMessages.length - 1];
          
          if (Array.isArray(lastMsg.content)) {
            const textPart = lastMsg.content.find(c => c.type === "text")?.text || "";
            const imageParts = await Promise.all(lastMsg.content.filter(c => c.type === "image_url").map(async (img) => {
                const response = await axios.get(img.image_url.url, { responseType: 'arraybuffer' });
                return { inlineData: { data: Buffer.from(response.data).toString("base64"), mimeType: "image/png" } };
            }));
            const result = await chat.sendMessage([textPart, ...imageParts]);
            return { text: result.response.text() };
          } else {
            const result = await chat.sendMessage(lastMsg.content);
            return { text: result.response.text() };
          }
        })();
      }

      const result = await Promise.race([apiCallPromise, timeoutPromise]);
      clearTimeout(timeoutId); 
      
      if (result && result.text) {
        console.log(`[✅ MODEL] Sukses menerima data dari ${model.name}`);
        return result;
      }
      throw new Error("Objek teks tidak ditemukan");

    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      const status = e?.status || e?.response?.status;
      const isRateLimit = status === 429 || /429|rate.?limit|quota/i.test(String(e?.message || ""));
      if (isRateLimit) {
        // Tandai model kena limit selama 60 detik agar request berikutnya
        // tidak membuang waktu mencoba model yang sama.
        MODEL_COOLDOWN.set(model.name, Date.now() + 60_000);
        console.warn(`[⏳ RATE-LIMIT] ${model.name} kena 429, di-skip 60s. Lanjut model berikutnya.`);
      } else {
        console.warn(`[⚠️ FALLBACK] Model ${model.name} gagal. Error: ${e.message}`);
      }
      continue;
    }
  }

  throw new Error("Semua model AI gagal merespons atau kuota API habis.");
}

// Balasan aman untuk interaction maupun pesan biasa.
// Interaction yang sudah di-defer wajib memakai editReply/followUp, dan interaction
// yang sudah lewat 3 detik tidak boleh dipakai reply() lagi (penyebab error
// "This command is outdated"). Ephemeral HANYA berlaku untuk reply pertama.
async function safeRespond(context, isInteraction, content, ephemeral = false) {
  try {
    if (!isInteraction) return await context.reply(content);
    if (context.deferred) {
      if (context.replied) return await context.followUp({ content, ephemeral });
      return await context.editReply({ content });
    }
    if (context.replied) return await context.followUp({ content, ephemeral: true });
    return await context.reply({ content, ephemeral });
  } catch (e) {
    // Interaction kedaluwarsa: kirim via channel agar user tetap dapat jawaban
    console.warn(`[⚠️ RESPOND] Reply interaction gagal (${e.message}), fallback ke channel.`);
    try { await context.channel?.send(content); } catch { /* diabaikan */ }
  }
}

async function processAiRequest(context, promptText, fileAttachment, targetMessageId, regenerateTarget) {
  const isInteraction = !!context.commandName;
  const user = isInteraction ? context.user : (context.author ?? context.user);
  if (!user || !user.id) {
    console.error("[❌ ERROR] Tidak ada objek user yang valid pada konteks permintaan.");
    try { context.channel?.send("❌ Terjadi kesalahan internal (user tidak ditemukan)."); } catch {}
    return;
  }
  const sessionId = getSessionId(context.channelId, user.id);

  console.log(`\n[📥 PROMPT] Masuk dari: ${user.tag} | Isi: "${promptText.substring(0,50)}..."`);

  const lastUsed = cooldowns.get(user.id);
  if (lastUsed && (Date.now() - lastUsed < COOLDOWN_TIME)) {
    return safeRespond(context, isInteraction, "⏳ Cooldown.", true);
  }
  cooldowns.set(user.id, Date.now());

  if (BANNED_WORDS.some(word => promptText.toLowerCase().includes(word))) {
    const msg = "❌ Request denied by system filter safety guidelines.";
    return safeRespond(context, isInteraction, msg, true);
  }

  if (fileAttachment && fileAttachment.size > MAX_FILE_SIZE) {
    const msg = "❌ Attached payload exceeds maximum 10MB limit threshold.";
    return safeRespond(context, isInteraction, msg, true);
  }

  let progressStateMessage;
  if (isInteraction) {
    try {
      await context.deferReply();
    } catch (e) {
      // Interaction sudah kedaluwarsa / sudah dibalas -> beri tahu user dengan sopan
      console.warn(`[⚠️ INTERACTION] deferReply gagal: ${e.message}`);
      return;
    }
  } else {
    progressStateMessage = await context.reply("🧠 *Thinking...*").catch(() => null);
  }

  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  try {
    let userSession = sessions.get(sessionId) || { 
      messages: [{ role: "system", content: "You are a smart Discord assistant. Auto-detect and mirror user language." }], 
      hasImageInHistory: false 
    };

    // Saat regenerate, hapus jawaban lama yang menempel pada prompt terakhir
    if (regenerateTarget) {
      const msgs = userSession.messages;
      for (let i = msgs.length - 1; i > 0; i--) {
        if (msgs[i].role === "user") {
          msgs.splice(i + 1); // buang jawaban lama setelah prompt user terakhir
          break;
        }
      }
    }

    let extractedData = "";
    let isImage = false;

    if (targetMessageId) {
      console.log("[🔍 TARGET] Mengambil konteks pesan yang di-reply...");
      const targetMsg = await context.channel.messages.fetch(targetMessageId).catch(() => null);
      if (targetMsg) {
        extractedData += `\n[REFERENCED TEXT CONTEXT (Author: ${targetMsg.author.username})]: "${targetMsg.content}"\n`;
      }
    }

    if (fileAttachment) {
      console.log(`[📂 FILE] Memproses lampiran: ${fileAttachment.name}`);
      const filename = fileAttachment.name.toLowerCase();
      const mimeType = fileAttachment.contentType ? fileAttachment.contentType.toLowerCase() : "";

      if (filename.endsWith(".pdf") || mimeType === "application/pdf") {
        const res = await axios.get(fileAttachment.url, { responseType: 'arraybuffer' });
        const data = await pdf(Buffer.from(res.data));
        extractedData += `\n[PDF EXTRACTED TEXT: ${fileAttachment.name}]\n${data.text.substring(0, 4000)}\n`;
      } 
      else if (filename.endsWith(".mp3") || filename.endsWith(".mp4") || filename.endsWith(".wav") || filename.endsWith(".m4a") || mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
        const isAudioOnly = filename.endsWith(".mp3") || filename.endsWith(".wav") || filename.endsWith(".m4a") || mimeType.startsWith("audio/");
        const transcript = await transcribeMedia(fileAttachment.url, tempDir, isAudioOnly);
        extractedData += `\n[MEDIA TRANSCRIPT]: ${transcript}\n`;
      } 
      else if (mimeType.startsWith("image/") || filename.match(/\.(jpg|jpeg|png|webp)$/i)) {
        isImage = true;
        // Catat URL gambar agar bisa diregenerate nanti
        userSession.lastImageUrl = fileAttachment.url;
      }
    }

    // Terapkan bahasa pilihan user ke instruksi sistem
    let systemContent = userSession.messages[0]?.content || "You are a smart Discord assistant. Auto-detect and mirror user language.";
    if (userSession.language) {
      systemContent = `${systemContent}\nImportant: Always respond in ${userSession.language}.`;
      userSession.messages[0] = { role: "system", content: systemContent };
    }

    const finalPrompt = `${extractedData}\nUSER: ${promptText}`.trim();
    const imageUrl = fileAttachment ? fileAttachment.url : (isImage ? userSession.lastImageUrl : null);
    let currentPayload;
    if (isImage && imageUrl) {
      currentPayload = [{ type: "text", text: finalPrompt }, { type: "image_url", image_url: { url: imageUrl } }];
    } else {
      currentPayload = finalPrompt;
    }

    if (isImage) userSession.hasImageInHistory = true;
    userSession.messages.push({ role: "user", content: currentPayload });

    // Panggil Pipeline Backend (terapkan preferensi model + temperature/language)
    const { text: responseText } = await fetchWithFallback(userSession.messages, userSession.hasImageInHistory, {
      userId: user.id,
      temperature: userSession.temperature,
      language: userSession.language
    });

    userSession.messages.push({ role: "assistant", content: responseText });
    
    // Cegah error validasi Google Gemini dengan mempertahankan pola history
    if (userSession.messages.length > (MAX_HISTORY * 2) + 1) {
        let slicedHistory = userSession.messages.slice(-(MAX_HISTORY * 2));
        if (slicedHistory[0].role === "assistant") slicedHistory = slicedHistory.slice(1);
        userSession.messages = [userSession.messages[0], ...slicedHistory];
    }
    userSession.lastActive = Date.now();
    sessions.set(sessionId, userSession);

    const finalResponse = `> **Prompt:** ${promptText}\n\n${responseText}`;
    const chunks = splitMessage(finalResponse);

    console.log(`[📤 DISCORD] Mengirim ${chunks.length} blok pesan ke server...`);
    const actionRows = buildResponseActionRows(user.id);

    // --- Mode Regenerate: ganti jawaban lama di pesan yang sama ---
    if (regenerateTarget && typeof context.editReply === "function") {
      await context.editReply({ content: chunks[0], components: actionRows });
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.followUp({ content: chunks[i] });
      }
    } 
    else if (isInteraction) {
      await context.editReply({ content: chunks[0], components: actionRows });
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.followUp({ content: chunks[i] });
      }
    } else {
      if (progressStateMessage) await progressStateMessage.edit({ content: chunks[0], components: actionRows });
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.channel.send({ content: chunks[i] });
      }
    }
    console.log("[✅ DONE] Pesan sukses terkirim ke Discord.");

  } catch (error) {
    console.error("\n[❌ CRITICAL ERROR]:", error);
    const errorAlert = `\`❌ Terjadi kesalahan: ${error.message}\``;
    try {
        if (regenerateTarget && typeof context.editReply === "function") await context.editReply(errorAlert);
        else if (isInteraction) await context.editReply(errorAlert);
        else if (progressStateMessage) await progressStateMessage.edit(errorAlert);
    } catch (e) { console.error("[❌ DISCORD UI ERROR] Gagal mengedit pesan peringatan:", e); }
  }
}

// --- EVENT HANDLERS ---
client.on("interactionCreate", async (interaction) => {
  // Handle Chat Input Commands (/ask, /help, /reset, /admin)
  if (interaction.isChatInputCommand()) {
    console.log(`\n[⚡ EVENT] Trigger Slash Command: /${interaction.commandName} oleh ${interaction.user.tag}`);

    if (interaction.commandName === "help") {
      const helpEmbed = buildHelpEmbed(interaction.user.id);
      const actionRow = buildHelpActionRow(interaction.user.id);

      return interaction.reply({
        embeds: [helpEmbed],
        components: [actionRow]
      }).catch(() => {});
    }

    if (interaction.commandName === "reset") {
      sessions.delete(getSessionId(interaction.channelId, interaction.user.id));
      userModelPreference.delete(interaction.user.id);
      return interaction.reply({ content: "🧹 **Sesi memori dibersihkan!**" }).catch(() => {});
    }

    if (interaction.commandName === "ask") {
      const promptText = interaction.options.getString("prompt")?.trim() ?? "";
      const uploadedFile = interaction.options.getAttachment("file");
      const targetMessageId = interaction.options.getString("message_id");

      if (!promptText && !uploadedFile && !targetMessageId) {
        const modal = buildAskModal(interaction.user.id, interaction.channelId);
        return interaction.showModal(modal).catch(() => {});
      }

      await processAiRequest(interaction, promptText, uploadedFile, targetMessageId);
    }

    if (interaction.commandName === "admin") {
      if (!(await requireCapability(interaction, 'admin_panel'))) return;
      const adminEmbed = buildAdminPanelEmbed();
      const actionRow = buildAdminActionRow(interaction.user.id);

      return interaction.reply({
        embeds: [adminEmbed],
        components: [actionRow],
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }

  // Handle Button Interactions
  if (interaction.isButton()) {
    console.log(`\n[🔘 EVENT] Button Click: ${interaction.customId} oleh ${interaction.user.tag}`);

    const [, action, userId] = interaction.customId.split(':');

    // Ask button must call showModal as the first response (cannot defer first)
    if (action === 'ask_open') {
      if (userId !== interaction.user.id) {
        return interaction.reply({ content: "❌ This button is not for you.", ephemeral: true }).catch(() => {});
      }
      const modal = buildAskModal(interaction.user.id, interaction.channelId);
      return interaction.showModal(modal).catch(() => {});
    }

    await interaction.deferUpdate(); // Important to prevent "Unknown Interaction" error

    if (!isButtonOwner(interaction, userId)) {
      return interaction.editReply({
        content: "❌ Tombol ini bukan untuk Anda.",
        components: []
      }).catch(() => {});
    }

    // Lapisan kedua: setiap aksi yang butuh hak khusus dicek di sini juga,
    // sehingga tombol lama (mis. embed yang sudah terkirim) tidak bisa dipakai
    // untuk menembus fitur yang seharusnya tersembunyi.
    const ACTION_CAPABILITY = {
      admin_panel: 'admin_panel',
      admin_stats: 'admin_stats',
      admin_clear: 'admin_clear_sessions',
      admin_reload: 'admin_reload_commands',
      admin_config: 'admin_view_config',
    };
    const requiredCap = ACTION_CAPABILITY[action];
    if (requiredCap && !can(interaction.user.id, requiredCap)) {
      console.warn(`[🔒 DENY] ${interaction.user.tag} menembus tombol "${action}"`);
      return interaction.editReply({
        content: "❌ Fitur ini tidak tersedia untuk Anda.",
        components: []
      }).catch(() => {});
    }

    switch (action) {
      case 'regenerate': {
        // Find last user message in session to regenerate
        const sessionId = getSessionId(interaction.channelId, interaction.user.id);
        const session = sessions.get(sessionId);
        const lastUserMsg = session && session.messages.length >= 2
          ? [...session.messages].reverse().find(m => m.role === "user")
          : undefined;
        if (session && lastUserMsg) {
          let promptText = "";
          let fileAttachment = null;

          if (typeof lastUserMsg.content === 'string') {
            promptText = lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.content)) {
            const textPart = lastUserMsg.content.find(c => c.type === 'text');
            promptText = textPart ? textPart.text : "";
          }

          // Perlakuan seolah-olah ini adalah interaction agar processAiRequest
          // dapat meng-edit ulang pesan yang sama (menghapus terjemahan lama).
          const mockContext = {
            commandName: "ask",
            channelId: interaction.channelId,
            channel: interaction.channel,
            user: interaction.user,
            deferReply: () => Promise.resolve(),
            editReply: (o) => interaction.editReply(o),
            followUp: (o) => interaction.followUp(o),
            reply: () => Promise.resolve()
          };

          await processAiRequest(mockContext, promptText, fileAttachment, null, { replaceOriginal: true });
        } else {
          await interaction.editReply({
            content: "❌ No previous request to regenerate.",
            components: []
          }).catch(() => {});
        }
        break;
      }

      case 'switch_model': {
        const isVision = sessions.get(getSessionId(interaction.channelId, interaction.user.id))?.hasImageInHistory ?? false;
        const selectMenu = buildModelSelectMenu(interaction.user.id, isVision);
        const actionRow = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.editReply({
          content: "🔄 **Select AI Model:**",
          components: [actionRow]
        }).catch(() => {});
        break;
      }

      case 'copy_text': {
        // Find last response in session
        const sessionId = getSessionId(interaction.channelId, interaction.user.id);
        const session = sessions.get(sessionId);
        const lastAssistantMsg = session && session.messages.length >= 2
          ? [...session.messages].reverse().find(m => m.role === "assistant")
          : undefined;
        if (lastAssistantMsg) {
          let textContent = "";
          if (typeof lastAssistantMsg.content === 'string') {
            textContent = lastAssistantMsg.content;
          } else if (Array.isArray(lastAssistantMsg.content)) {
            textContent = lastAssistantMsg.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }

          await interaction.followUp({
            content: `📋 **Text to copy:**\n\`\`\`\n${textContent.substring(0, 1900)}\n\`\`\``,
            ephemeral: true
          }).catch(() => {});
        } else {
          await interaction.followUp({
            content: "❌ No response to copy.",
            ephemeral: true
          }).catch(() => {});
        }
        break;
      }

      case 'delete_msg': {
        try {
          await interaction.message.delete();
        } catch (error) {
          await interaction.editReply({
            content: "❌ Failed to delete message.",
            components: []
          }).catch(() => {});
        }
        break;
      }

      case 'settings': {
        const modal = buildSettingsModal(interaction.channelId, interaction.user.id);
        await interaction.showModal(modal).catch(() => {});
        break;
      }

      // Help navigation buttons
      case 'help_commands': {
        const helpEmbed = buildHelpEmbed(interaction.user.id);
        await interaction.editReply({
          embeds: [helpEmbed],
          components: [buildHelpActionRow(interaction.user.id)]
        }).catch(() => {});
        break;
      }

      case 'help_settings': {
        const settingsEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('⚙️ Bot Settings')
          .setDescription('Configure your personal bot preferences')
          .addFields(
            { name: '🌡️ Temperature', value: 'Controls randomness (0.0 = focused, 1.0 = creative)', inline: true },
            { name: '🌐 Language', value: 'Preferred response language', inline: true },
            { name: '🤖 Model', value: 'Your selected AI model preference', inline: true }
          );

        await interaction.editReply({
          embeds: [settingsEmbed],
          components: [buildBackButtonRow(`ai_bot:help_commands:${interaction.user.id}`, interaction.user.id)]
        }).catch(() => {});
        break;
      }

      case 'help_examples': {
        const examplesEmbed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎯 Usage Examples')
          .setDescription('Examples of how to use the bot effectively')
          .addFields(
            { name: '💬 Basic Question', value: '`?ask What is the capital of France?`', inline: false },
            { name: '📄 With File', value: '`?ask + [attach PDF]` to summarize documents', inline: false },
            { name: '🖼️ Image Analysis', value: '`?ask + [attach image]` to describe or analyze images', inline: false },
            { name: '🔊 Audio/Video', value: '`?ask + [attach media]` to transcribe and analyze', inline: false },
            { name: '💬 Reply Context', value: 'Reply to a message with `?ask` to use it as context', inline: false },
            { name: '⚙️ Settings', value: 'Use buttons below AI responses to adjust preferences', inline: false }
          );

        await interaction.editReply({
          embeds: [examplesEmbed],
          components: [buildBackButtonRow(`ai_bot:help_commands:${interaction.user.id}`, interaction.user.id)]
        }).catch(() => {});
        break;
      }

      case 'help_admin': {
        if (!(await requireCapability(interaction, 'admin_panel'))) break;
        const adminEmbed = buildAdminPanelEmbed();
        const actionRow = buildAdminActionRow(interaction.user.id, { backToHelp: true });

        await interaction.editReply({
          embeds: [adminEmbed],
          components: [actionRow]
        }).catch(() => {});
        break;
      }

      // Admin buttons
      case 'admin_stats': {
        if (!(await requireCapability(interaction, 'admin_stats'))) break;
        const adminEmbed = buildAdminPanelEmbed();
        await interaction.editReply({
          embeds: [adminEmbed],
          components: [buildAdminActionRow(interaction.user.id)]
        }).catch(() => {});
        break;
      }

      case 'admin_clear': {
        if (!(await requireCapability(interaction, 'admin_clear_sessions'))) break;
        sessions.clear();
        userModelPreference.clear();
        await interaction.editReply({
          content: "🧹 **All user sessions cleared!**",
          components: [buildBackButtonRow(`ai_bot:help_admin:${interaction.user.id}`, interaction.user.id, "🔙 Back to Admin")]
        }).catch(() => {});
        break;
      }

      case 'admin_reload': {
        if (!(await requireCapability(interaction, 'admin_reload_commands'))) break;
        try {
          const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
          await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
          await interaction.editReply({
            content: "🔄 **Slash commands reloaded successfully!**",
            components: [buildBackButtonRow(`ai_bot:help_admin:${interaction.user.id}`, interaction.user.id, "🔙 Back to Admin")]
          }).catch(() => {});
        } catch (error) {
          await interaction.editReply({
            content: `❌ Failed to reload commands: ${error.message}`,
            components: [buildBackButtonRow(`ai_bot:help_admin:${interaction.user.id}`, interaction.user.id, "🔙 Back to Admin")]
          }).catch(() => {});
        }
        break;
      }

      case 'admin_config': {
        if (!(await requireCapability(interaction, 'admin_view_config'))) break;
        const configEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('⚙️ Bot Configuration')
          .addFields(
            { name: '🔑 API Keys', value: 'Masked for security', inline: false },
            { name: '🌐 Prefix', value: `\`${PREFIX}\``, inline: true },
            { name: '⏱️ Cooldown', value: `${COOLDOWN_TIME/1000}s`, inline: true },
            { name: '📝 Max History', value: `${MAX_HISTORY} turns`, inline: true },
            { name: '📁 Max File Size', value: `${MAX_FILE_SIZE / (1024*1024)} MB`, inline: true }
          );

        await interaction.editReply({
          embeds: [configEmbed],
          components: [buildBackButtonRow(`ai_bot:help_admin:${interaction.user.id}`, interaction.user.id, "🔙 Back to Admin")]
        }).catch(() => {});
        break;
      }

      default:
        await interaction.editReply({
          content: "❓ Unknown button action.",
          components: []
        }).catch(() => {});
    }
    return;
  }

  // Handle Select Menu Interactions
  if (interaction.isStringSelectMenu()) {
    console.log(`\n[📋 EVENT] Select Menu: ${interaction.customId} oleh ${interaction.user.tag}`);
    await interaction.deferUpdate();

    const [, , action, userId] = interaction.customId.split(':');
    if (userId !== interaction.user.id) {
      return interaction.editReply({
        content: "❌ This menu is not for you.",
        components: []
      }).catch(() => {});
    }

    if (action === 'model_select') {
      const selectedModel = interaction.values[0];
      setUserModelPreference(interaction.user.id, selectedModel);

      await interaction.editReply({
        content: `✅ **Model selected:** \`${selectedModel}\`\nThis will be used for your future requests.`,
        components: []
      }).catch(() => {});
    }
    return;
  }

  // Handle Modal Submits
  if (interaction.isModalSubmit()) {
    console.log(`\n[📝 EVENT] Modal Submit: ${interaction.customId} oleh ${interaction.user.tag}`);

    const [, , action, userId] = interaction.customId.split(':');
    if (userId !== interaction.user.id) {
      return interaction.reply({ content: "❌ This modal is not for you.", ephemeral: true }).catch(() => {});
    }

    // Ask modal -> run the full AI request flow (non-ephemeral, in-channel)
    if (action === 'ask_modal') {
      const promptText = interaction.fields.getTextInputValue('ask_prompt').trim();
      const fileUrlRaw = interaction.fields.getTextInputValue('ask_file_url');
      const contextRaw = interaction.fields.getTextInputValue('ask_context');
      const tempRaw = interaction.fields.getTextInputValue('ask_temperature');
      const languageRaw = interaction.fields.getTextInputValue('ask_language');

      const sessionId = getSessionId(interaction.channelId, interaction.user.id);
      const session = sessions.get(sessionId) || {
        messages: [{ role: "system", content: "You are a smart Discord assistant. Auto-detect and mirror user language." }],
        hasImageInHistory: false
      };

      if (tempRaw.trim()) {
        const temp = parseFloat(tempRaw);
        if (!isNaN(temp) && temp >= 0 && temp <= 1) session.temperature = temp;
      }
      if (languageRaw.trim()) session.language = languageRaw.trim();
      session.lastActive = Date.now();
      sessions.set(sessionId, session);

      const fileAttachment = buildAskFromUrl(fileUrlRaw);
      const targetMessageId = parseMessageId(contextRaw);

      const mockContext = {
        commandName: "ask",
        channelId: interaction.channelId,
        channel: interaction.channel,
        user: interaction.user,
        deferReply: () => interaction.deferReply(),
        editReply: (o) => interaction.editReply(o),
        followUp: (o) => interaction.followUp(o),
        reply: (o) => interaction.reply(o)
      };

      await processAiRequest(mockContext, promptText, fileAttachment, targetMessageId);
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (userId !== interaction.user.id) {
      return interaction.editReply({
        content: "❌ This modal is not for you.",
        ephemeral: true
      }).catch(() => {});
    }

    if (action === 'settings_modal') {
      const temperatureInput = interaction.fields.getTextInputValue('temperature');
      const languageInput = interaction.fields.getTextInputValue('language');

      // Update session with new settings
      const sessionId = getSessionId(interaction.channelId, interaction.user.id);
      const session = sessions.get(sessionId) || {
        messages: [{ role: "system", content: "You are a smart Discord assistant. Auto-detect and mirror user language." }],
        hasImageInHistory: false
      };

      if (temperatureInput) {
        const temp = parseFloat(temperatureInput);
        if (!isNaN(temp) && temp >= 0 && temp <= 1) {
          session.temperature = temp;
        }
      }
      if (languageInput) {
        session.language = languageInput;
      }

      session.lastActive = Date.now();
      sessions.set(sessionId, session);

      await interaction.editReply({
        content: "✅ **Settings saved!**\nYour preferences have been updated.",
        ephemeral: true
      }).catch(() => {});
    }
    return;
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const rawPrompt = message.content.slice(PREFIX.length).trim();
  if (!rawPrompt) return; // pesan hanya "?" -> abaikan

  console.log(`\n[💬 EVENT] Trigger Prefix Command dari ${message.author.tag}`);

  const args = rawPrompt.split(/ +/);
  const command = args.shift().toLowerCase();

  // --- ?reset : hapus memori percakapan ---
  if (command === "reset") {
    sessions.delete(getSessionId(message.channelId, message.author.id));
    return message.reply("🧹 **Sesi memori dibersihkan!**").catch(() => {});
  }

  // --- ?help : daftar perintah ---
  if (command === "help" || command === "h") {
    return message.reply(
      `**📖 Prefix \`${PREFIX}\` — Cara Pakai**\n` +
      `• \`${PREFIX}<pertanyaan>\` — tanya AI langsung, mis. \`${PREFIX}hi\`\n` +
      `• \`${PREFIX}ask <pertanyaan>\` — sama seperti di atas (eksplisit)\n` +
      `• \`${PREFIX}reset\` — hapus memori percakapan\n` +
      `• \`${PREFIX}help\` — tampilkan bantuan ini\n` +
      `• Balas pesan orang lain dengan \`${PREFIX}<pertanyaan>\` untuk menjadikannya konteks.\n` +
      `• Lampirkan gambar/PDF/audio pada pesan untuk analisis multi-modal.`
    ).catch(() => {});
  }

  // --- ?ask <pertanyaan> : form eksplisit ---
  if (command === "ask") {
    const promptText = args.join(" ").trim();
    if (!promptText) return message.reply(`❌ Format tidak valid: \`${PREFIX}ask [pertanyaan]\``).catch(() => {});
    const uploadedFile = message.attachments.first() || null;
    let targetMessageId = null;
    if (message.reference && message.reference.messageId) {
      targetMessageId = message.reference.messageId;
    }
    return await processAiRequest(message, promptText, uploadedFile, targetMessageId);
  }

  // --- ?<apa saja> : seluruh isi pesan diperlakukan sebagai prompt AI ---
  // Menjaga "?hi", "?halo", "?jelaskan X" tetap dibalas, bukan diabaikan.
  const uploadedFile = message.attachments.first() || null;
  let targetMessageId = null;
  if (message.reference && message.reference.messageId) {
    targetMessageId = message.reference.messageId;
  }
  await processAiRequest(message, rawPrompt, uploadedFile, targetMessageId);
});

client.login(BOT_TOKEN);
