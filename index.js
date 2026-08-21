const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActivityType } = require("discord.js");
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
const BANNED_WORDS = ["exploit", "crash", "bypass system", "force shutdown"];

// --- MODEL CONFIGURATIONS (UPDATED & STABLE) ---
const VISION_MODELS = [
  // 1. Google Native (Prioritas Utama untuk Vision: Cepat & Akurat)
  { provider: "google-native", name: "gemini-2.5-flash" },
  { provider: "google-native", name: "gemini-2.0-flash" },
  { provider: "google-native", name: "gemini-2.5-pro" },
  // 2. OpenRouter (Fallback Vision Gratis)
  { provider: "openrouter", name: "google/gemini-2.0-flash-001" },
  { provider: "openrouter", name: "meta-llama/llama-3.2-90b-vision-instruct:free" },
  { provider: "openrouter", name: "meta-llama/llama-3.2-11b-vision-instruct:free" },
  { provider: "openrouter", name: "qwen/qwen-2.5-vl-72b-instruct:free" }
];

const TEXT_MODELS = [
  // 1. Groq (Kecepatan inferensi tinggi)
  { provider: "groq", name: "llama-3.3-70b-versatile" },
  { provider: "groq", name: "llama-3.1-8b-instant" },
  // 2. Google Native (Konteks besar & penalaran dalam)
  { provider: "google-native", name: "gemini-2.5-flash" },
  { provider: "google-native", name: "gemini-2.0-flash" },
  { provider: "google-native", name: "gemini-2.5-pro" },
  // 3. OpenRouter (Fallback teks gratis)
  { provider: "openrouter", name: "deepseek/deepseek-r1" },
  { provider: "openrouter", name: "deepseek/deepseek-chat" },
  { provider: "openrouter", name: "meta-llama/llama-3.3-70b-instruct:free" },
  { provider: "openrouter", name: "qwen/qwen-2.5-72b-instruct:free" },
  { provider: "openrouter", name: "mistralai/mistral-small-24b-instruct-2501:free" }
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
                .setDescription("Your question or instruction")
                .setRequired(true)
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
        .setDescription("Show the complete guide and user manual for this bot")
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

function getSessionId(channelId, userId) {
  return `${channelId}-${userId}`;
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

// Transkripsi audio dialihkan ke Groq (Whisper-large-v3)
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

// Pemotongan string yang solid untuk standar 2000 karakter Discord
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
            // Paksa pemotongan untuk baris kode/teks tanpa enter yang sangat panjang
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

async function fetchWithFallback(messagesArray, isVisionContext) {
  const modelList = isVisionContext ? VISION_MODELS : TEXT_MODELS;
  const timeoutMS = 60000; 

  for (const model of modelList) {
    let timeoutId;
    try {
      console.log(`[🔄 MODEL] Mencoba menghubungkan ke: ${model.name} (${model.provider})`);
      const safeMessages = sanitizeMessagesForModel(messagesArray, isVisionContext);
      
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout ${timeoutMS / 1000}s terlampaui`)), timeoutMS);
      });
      
      let apiCallPromise;

      if (model.provider === "openrouter") {
        apiCallPromise = (async () => {
          const completion = await openrouter.chat.completions.create({ 
            model: model.name, messages: safeMessages 
          });
          if (!completion.choices?.length) throw new Error("Data kosong dari hulu");
          return { text: completion.choices[0].message.content };
        })();
      } 
      else if (model.provider === "groq") {
        apiCallPromise = (async () => {
          const completion = await groq.chat.completions.create({
            model: model.name, messages: safeMessages
          });
          if (!completion.choices?.length) throw new Error("Data kosong dari hulu");
          return { text: completion.choices[0].message.content };
        })();
      }
      else if (model.provider === "google-native") {
        apiCallPromise = (async () => {
          const systemPrompt = safeMessages.find(msg => msg.role === "system")?.content || "";
          const genModel = genAI.getGenerativeModel({ model: model.name, systemInstruction: systemPrompt });
          
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
      clearTimeout(timeoutId); // Cegah memory leak
      
      if (result && result.text) {
        console.log(`[✅ MODEL] Sukses menerima data dari ${model.name}`);
        return result;
      }
      throw new Error("Objek teks tidak ditemukan");

    } catch (e) { 
      if (timeoutId) clearTimeout(timeoutId);
      console.warn(`[⚠️ FALLBACK] Model ${model.name} gagal. Error: ${e.message}`);
      continue; 
    }
  }

  throw new Error("Semua model AI gagal merespons atau kuota API habis.");
}

async function processAiRequest(context, promptText, fileAttachment, targetMessageId) {
  const isInteraction = !!context.commandName;
  const user = isInteraction ? context.user : context.author;
  const sessionId = getSessionId(context.channelId, user.id);

  console.log(`\n[📥 PROMPT] Masuk dari: ${user.tag} | Isi: "${promptText.substring(0,50)}..."`);

  const lastUsed = cooldowns.get(user.id);
  if (lastUsed && (Date.now() - lastUsed < COOLDOWN_TIME)) {
    return isInteraction ? context.reply({ content: "⏳ Cooldown.", ephemeral: true }) : context.reply("⏳ Cooldown.");
  }
  cooldowns.set(user.id, Date.now());

  if (BANNED_WORDS.some(word => promptText.toLowerCase().includes(word))) {
    const msg = "❌ Request denied by system filter safety guidelines.";
    return isInteraction ? context.reply({ content: msg, ephemeral: true }) : context.reply(msg);
  }

  if (fileAttachment && fileAttachment.size > MAX_FILE_SIZE) {
    const msg = "❌ Attached payload exceeds maximum 10MB limit threshold.";
    return isInteraction ? context.reply({ content: msg, ephemeral: true }) : context.reply(msg);
  }

  let progressStateMessage;
  if (isInteraction) {
    await context.deferReply(); 
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
      }
    }

    const finalPrompt = `${extractedData}\nUSER: ${promptText}`.trim();
    let currentPayload = isImage ? [{ type: "text", text: finalPrompt }, { type: "image_url", image_url: { url: fileAttachment.url } }] : finalPrompt;

    if (isImage) userSession.hasImageInHistory = true;
    userSession.messages.push({ role: "user", content: currentPayload });

    // Panggil Pipeline Backend
    const { text: responseText } = await fetchWithFallback(userSession.messages, userSession.hasImageInHistory);

    userSession.messages.push({ role: "assistant", content: responseText });
    
    // Cegah error validasi Google Gemini dengan mempertahankan pola history
    if (userSession.messages.length > (MAX_HISTORY * 2) + 1) {
        let slicedHistory = userSession.messages.slice(-(MAX_HISTORY * 2));
        if (slicedHistory[0].role === "assistant") slicedHistory = slicedHistory.slice(1);
        userSession.messages = [userSession.messages[0], ...slicedHistory];
    }
    sessions.set(sessionId, userSession);

    const finalResponse = `> **Prompt:** ${promptText}\n\n${responseText}`;
    const chunks = splitMessage(finalResponse);

    console.log(`[📤 DISCORD] Mengirim ${chunks.length} blok pesan ke server...`);
    if (isInteraction) {
      await context.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.followUp(chunks[i]);
      }
    } else {
      if (progressStateMessage) await progressStateMessage.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.channel.send(chunks[i]);
      }
    }
    console.log("[✅ DONE] Pesan sukses terkirim ke Discord.");

  } catch (error) {
    console.error("\n[❌ CRITICAL ERROR]:", error);
    const errorAlert = `\`❌ Terjadi kesalahan: ${error.message}\``;
    try {
        if (isInteraction) await context.editReply(errorAlert);
        else if (progressStateMessage) await progressStateMessage.edit(errorAlert);
    } catch (e) { console.error("[❌ DISCORD UI ERROR] Gagal mengedit pesan peringatan:", e); }
  }
}

// --- EVENT HANDLERS ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`\n[⚡ EVENT] Trigger Slash Command: /${interaction.commandName} oleh ${interaction.user.tag}`);

  if (interaction.commandName === "help") {
    const helpEmbed = new EmbedBuilder()
      .setColor("#5865F2") 
      .setTitle("🤖 AI Assistant Hybrid Manual Guide")
      .setDescription("Sistem ini mendukung Slash Commands (`/`) dan Prefix Triggers (`?`).")
      .addFields(
        { name: "⚡ Prefix Commands (Disarankan untuk membalas pesan & lampiran)", value: `• \`${PREFIX}ask [pertanyaan]\`\n• \`${PREFIX}reset\` — Hapus memori percakapan.` },
        { name: "🎯 Slash Commands", value: "• `/ask prompt: [teks] file: [opsional] message_id: [opsional]`\n• `/reset`\n• `/help`" }
      );
    return interaction.reply({ embeds: [helpEmbed] }).catch(() => {});
  }

  if (interaction.commandName === "reset") {
    sessions.delete(getSessionId(interaction.channelId, interaction.user.id));
    return interaction.reply({ content: "🧹 **Sesi memori dibersihkan!**" }).catch(() => {});
  }

  if (interaction.commandName === "ask") {
    const promptText = interaction.options.getString("prompt").trim();
    const uploadedFile = interaction.options.getAttachment("file");
    const targetMessageId = interaction.options.getString("message_id");
    await processAiRequest(interaction, promptText, uploadedFile, targetMessageId);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  console.log(`\n[💬 EVENT] Trigger Prefix Command dari ${message.author.tag}`);

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === "reset") {
    sessions.delete(getSessionId(message.channelId, message.author.id));
    return message.reply("🧹 **Sesi memori dibersihkan!**").catch(() => {});
  }

  if (command === "ask") {
    const promptText = args.join(" ").trim();
    if (!promptText) return message.reply(`❌ Format tidak valid: \`${PREFIX}ask [pertanyaan]\``).catch(() => {});
    const uploadedFile = message.attachments.first() || null;
    let targetMessageId = null;
    if (message.reference && message.reference.messageId) {
      targetMessageId = message.reference.messageId;
    }
    await processAiRequest(message, promptText, uploadedFile, targetMessageId);
  }
});

client.login(BOT_TOKEN);
