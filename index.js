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

const PREFIX = "?"; // Konfigurasi Prefix Teks Manual
const MAX_HISTORY = 10; 
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; 
const COOLDOWN_TIME = 5000; 
const cooldowns = new Map();
const BANNED_WORDS = ["exploit", "crash", "bypass system", "force shutdown"];

const VISION_MODELS = [
  { provider: "google-native", name: "gemini-2.5-flash" }, // Diutamakan karena terbaru, cepat, dan murah di 2026
  { provider: "google-native", name: "gemini-2.0-flash" },
  { provider: "openrouter", name: "google/gemini-2.0-flash-001" },
  { provider: "openrouter", name: "meta-llama/llama-3.2-90b-vision-instruct:free" },
  { provider: "google-native", name: "gemini-2.5-flash-lite" },
  { provider: "google-native", name: "gemini-3-flash-preview" },
  { provider: "google-native", name: "gemini-3.1-flash-lite-preview" },  
  { provider: "google-native", name: "gemini-2.5-pro" },
];

const TEXT_MODELS = [    
  { provider: "google-native", name: "gemini-2.5-flash" }, // Dipasang paling atas untuk menghemat biaya & performa stabil
  { provider: "openrouter", name: "deepseek/deepseek-r1:free" }, // Model gratis berperforma tinggi alternatif
  { provider: "google-native", name: "gemini-2.0-flash" },
  { provider: "groq", name: "llama-3.3-70b-versatile" },
  { provider: "groq", name: "openai/gpt-oss-120b" },
  { provider: "groq", name: "openai/gpt-oss-20b" },
  { provider: "groq", name: "llama-3.1-8b-instant" },
  { provider: "openrouter", name: "openai/gpt-oss-120b:free" },
  { provider: "openrouter", name: "meta-llama/llama-3.3-70b-instruct:free" },
  { provider: "openrouter", name: "qwen/qwen-2.5-72b-instruct:free" },
  { provider: "openrouter", name: "openrouter/free" }
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
        GatewayIntentBits.MessageContent // Diperlukan untuk membaca teks prefix (Wajib aktif di Developer Portal!)
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

client.on('ready', async () => {
    console.log(`[🚀] Bot is ready as ${client.user.tag}`);
    
    // --- SET PERMANENT STATUS ---
    client.user.setPresence({
        activities: [{ 
            name: "customstatus", 
            type: ActivityType.Custom, 
            state: `${PREFIX}ask or /help` 
        }],
        status: "online",
    });

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        console.log('[🔄] Updating Slash Commands (/) registration to Discord...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[✅] Successfully registered Slash Commands globally!');
    } catch (error) {
        console.error('[❌] Failed to register Slash Commands:', error);
    }
});

const sessions = new Map();

// --- HELPERS ---
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
    form.append("model", "openai/whisper-large-v3");
    const whisperRes = await axios.post("https://openrouter.ai/api/v1/audio/transcriptions", form, {
      headers: { ...form.getHeaders(), "Authorization": `Bearer ${OR_API_KEY}` },
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

function splitMessage(text, maxLength = 2000) {
  const chunks = [];
  let currentChunk = "";
  let isInsideCodeBlock = false;
  let codeLanguage = ""; 
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      isInsideCodeBlock = !isInsideCodeBlock;
      if (isInsideCodeBlock) codeLanguage = line.trim().substring(3).trim();
      else codeLanguage = "";
    }

    if (currentChunk.length + line.length + 1 > maxLength) {
      if (isInsideCodeBlock) {
        currentChunk += "\n```";
        chunks.push(currentChunk.trim());
        currentChunk = "```" + codeLanguage + "\n" + line + "\n";
      } else {
        chunks.push(currentChunk.trim());
        currentChunk = line + "\n";
      }
    } else {
      currentChunk += line + "\n";
    }
  }
  if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
  return chunks;
}

async function fetchWithFallback(messagesArray, isVisionContext) {
  const modelList = isVisionContext ? VISION_MODELS : TEXT_MODELS;
  for (const model of modelList) {
    try {
      const safeMessages = sanitizeMessagesForModel(messagesArray, isVisionContext);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("API_TIMEOUT_15S")), 15000));
      let apiCallPromise;

      if (model.provider === "openrouter") {
        apiCallPromise = (async () => {
          const completion = await openrouter.chat.completions.create({ model: model.name, messages: safeMessages }, { timeout: 14000 });
          return { text: completion.choices[0].message.content };
        })();
      } else if (model.provider === "google-native") {
        apiCallPromise = (async () => {
          const systemPrompt = safeMessages.find(msg => msg.role === "system")?.content || "";
          const genModel = genAI.getGenerativeModel({ model: model.name, systemInstruction: systemPrompt });
          const formattedHistory = safeMessages.slice(1, -1).map(msg => {
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
      return await Promise.race([apiCallPromise, timeoutPromise]);
    } catch (e) { continue; }
  }
  throw new Error("All models failed.");
}

// --- CORE LOGIC HANDLER FOR BOTH INTERACTION AND PREFIX MESSAGE ---
async function processAiRequest(context, promptText, fileAttachment, targetMessageId) {
  const isInteraction = !!context.commandName;
  const userId = isInteraction ? context.user.id : context.author.id;
  const channelId = context.channelId;
  const sessionId = getSessionId(channelId, userId);

  // Cooldown Validation
  const lastUsed = cooldowns.get(userId);
  if (lastUsed && (Date.now() - lastUsed < COOLDOWN_TIME)) {
    const msg = "⏳ Cooldown active. Please wait.";
    return isInteraction ? context.reply({ content: msg, ephemeral: true }) : context.reply(msg);
  }
  cooldowns.set(userId, Date.now());

  // Safety Banned Words Validation
  if (BANNED_WORDS.some(word => promptText.toLowerCase().includes(word))) {
    const msg = "❌ Request denied by system filter safety guidelines.";
    return isInteraction ? context.reply({ content: msg, ephemeral: true }) : context.reply(msg);
  }

  // File size check
  if (fileAttachment && fileAttachment.size > MAX_FILE_SIZE) {
    const msg = "❌ Attached payload exceeds maximum 10MB limit threshold.";
    return isInteraction ? context.reply({ content: msg, ephemeral: true }) : context.reply(msg);
  }

  // Visual Deferred Feedback
  let progressStateMessage;
  if (isInteraction) {
    await context.deferReply();
  } else {
    progressStateMessage = await context.reply("🧠 *Thinking and parsing instructions...*").catch(() => null);
  }

  const updateStatusText = async (text) => {
    if (isInteraction) await context.editReply(text).catch(() => {});
    else if (progressStateMessage) await progressStateMessage.edit(text).catch(() => {});
  };

  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  try {
    let userSession = sessions.get(sessionId) || { 
      messages: [{ role: "system", content: "You are a smart Discord assistant. Auto-detect and mirror user language. ?ask is your prefix" }], 
      lastUpdated: Date.now(), hasImageInHistory: false 
    };
    userSession.lastUpdated = Date.now();

    let extractedData = "";

    // 1. Fetch Target Message Context (If target ID provided or native Discord reply used)
    if (targetMessageId) {
      await updateStatusText("🔍 *Fetching target reference context...*");
      const targetMsg = await context.channel.messages.fetch(targetMessageId).catch(() => null);
      if (targetMsg) {
        extractedData += `\n[REFERENCED TEXT CONTEXT (Author: ${targetMsg.author.username})]: "${targetMsg.content}"\n`;
      }
    }

    // 2. Parse file extraction
    let isImage = false;
    if (fileAttachment) {
      await updateStatusText("📂 *Processing attachment extensions...*");
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
      else if (filename.endsWith(".jpg") || filename.endsWith(".jpeg") || filename.endsWith(".png") || filename.endsWith(".webp") || mimeType.startsWith("image/")) {
        isImage = true;
      }
    }

    const finalPrompt = `${extractedData}\nUSER: ${promptText}`.trim();
    let currentPayload = isImage ? [{ type: "text", text: finalPrompt }, { type: "image_url", image_url: { url: fileAttachment.url } }] : finalPrompt;

    if (isImage) userSession.hasImageInHistory = true;
    const isVisionContext = isImage || userSession.hasImageInHistory;

    const requestMessages = [...userSession.messages, { role: "user", content: currentPayload }];
    await updateStatusText("🧠 *Formulating solution payload...*");

    const { text: responseText } = await fetchWithFallback(requestMessages, isVisionContext);

    userSession.messages.push({ role: "user", content: currentPayload }); 
    userSession.messages.push({ role: "assistant", content: responseText });
    sessions.set(sessionId, userSession);

    const finalResponse = `> **Prompt:** ${promptText}\n\n${responseText}`;
    const chunks = splitMessage(finalResponse);

    // Final Dispatch outputs
    if (isInteraction) {
      await context.editReply(chunks[0]).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.followUp(chunks[i]);
      }
    } else {
      if (progressStateMessage) await progressStateMessage.edit(chunks[0]).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        await context.channel.send(chunks[i]);
      }
    }

  } catch (error) {
    const errorAlert = "`❌ An error occurred while computing your upstream backend pipeline.`";
    if (isInteraction) await context.editReply(errorAlert).catch(() => {});
    else if (progressStateMessage) await progressStateMessage.edit(errorAlert).catch(() => {});
  }
}

// --- MODULE EVENT 1: SLASH COMMAND INTERACTION HANDLER ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "help") {
    const helpEmbed = new EmbedBuilder()
      .setColor("#5865F2") 
      .setTitle("🤖 AI Assistant Hybrid Manual Guide")
      .setDescription("This system adapts to both Slash Commands (`/`) and Native Prefix Triggers (`?`). Choose whichever fits your workflow efficiency targets best!")
      .addFields(
        { name: "⚡ Option 1: Native Prefix Commands (Recommended for Files & Replies)", value: `• \`${PREFIX}ask [Your question]\` — Prompts the AI model.\n• \`${PREFIX}reset\` — Clears conversation session context memory.\n\n*Advantages:* You can use Discord's native **Reply** feature targeting any text message or upload multiple files directly alongside your \`${PREFIX}ask\` prompt block seamlessly.` },
        { name: "🎯 Option 2: Global Slash Commands", value: "• `/ask prompt: [text] file: [optional] message_id: [optional]`\n• `/reset` — Clears conversation context history memory.\n• `/help` — Generates this structural view interface menu documentation frame manual." }
      )
      .setFooter({ text: "Hybrid Architecture Mode Build 2026" });
    return interaction.reply({ embeds: [helpEmbed] }).catch(() => {});
  }

  if (interaction.commandName === "reset") {
    sessions.delete(getSessionId(interaction.channelId, interaction.user.id));
    return interaction.reply({ content: "🧹 **Conversation scope cleared successfully!**" }).catch(() => {});
  }

  if (interaction.commandName === "ask") {
    const promptText = interaction.options.getString("prompt").trim();
    const uploadedFile = interaction.options.getAttachment("file");
    const targetMessageId = interaction.options.getString("message_id");
    await processAiRequest(interaction, promptText, uploadedFile, targetMessageId);
  }
});

// --- MODULE EVENT 2: NATIVE TEXT PREFIX COMMAND HANDLER ---
client.on("messageCreate", async (message) => {
  // 1. Validasi keamanan dasar (Abaikan bot dan pesan kosong)
  if (message.author.bot || !message.content) return;

  // 2. Cek kesesuaian prefix
  if (!message.content.startsWith(PREFIX)) return;

  // 3. Mengurai argumen dengan memisahkan spasi ganda ekstra secara dinamis
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // --- REGISTRASI PERINTAH PREFIX: RESET ---
  if (command === "reset") {
    sessions.delete(getSessionId(message.channelId, message.author.id));
    return message.reply("🧹 **Conversation scope cleared successfully!**").catch(() => {});
  }

  // --- REGISTRASI PERINTAH PREFIX: ASK ---
  if (command === "ask") {
    const promptText = args.join(" ").trim();
    
    // Jika hanya mengetik "?ask " tanpa teks pertanyaan tambahan
    if (!promptText) {
      return message.reply(`❌ **Invalid Input!** Format instruction template syntax: \`${PREFIX}ask [your prompt here]\``).catch(() => {});
    }

    // Mengambil attachment jika ada file yang diunggah langsung bersamaan dengan text prefix
    const uploadedFile = message.attachments.first() || null;

    // Otomatisasi deteksi jika user me-reply pesan orang lain menggunakan fitur native Discord Reply
    let targetMessageId = null;
    if (message.reference && message.reference.messageId) {
      targetMessageId = message.reference.messageId;
    }

    // Jalankan pipeline logika inti AI
    await processAiRequest(message, promptText, uploadedFile, targetMessageId);
  }
});

client.login(BOT_TOKEN);
