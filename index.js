const { Client, GatewayIntentBits, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");
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

// --- FEATURE 1: ENVIRONMENT VARIABLES VALIDATION AT STARTUP ---
const REQUIRED_ENVS = ["BOT_TOKEN", "API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY"];
REQUIRED_ENVS.forEach((envName) => {
  if (!process.env[envName]) {
    console.error(`[❌ ERROR] Environment variable ${envName} is missing in your .env file!`);
    process.exit(1);
  }
});

// --- CONFIGURATION ---
const CONTEXT_SCOPE = "channel_user"; 
const MAX_HISTORY = 10; 
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; 

// --- COOLDOWN CONFIGURATION (5-Second Delay) ---
const COOLDOWN_TIME = 5000; 
const cooldowns = new Map();

// --- BANNED WORDS LIST ---
const BANNED_WORDS = ["exploit", "crash", "bypass system", "force shutdown"];

// --- MODEL SELECTION ---
const VISION_MODELS = [
  { provider: "google-native", name: "gemini-2.5-flash" }, 
  { provider: "google-native", name: "gemini-2.0-flash" },
  { provider: "openrouter", name: "google/gemini-2.0-flash-001" },
  { provider: "openrouter", name: "meta-llama/llama-3.2-90b-vision-instruct:free" },
  { provider: "google-native", name: "gemini-2.5-flash-lite" },
  { provider: "google-native", name: "gemini-3-flash-preview" },
  { provider: "google-native", name: "gemini-3.1-flash-lite-preview" },  
  { provider: "google-native", name: "gemini-2.5-pro" },
];

const TEXT_MODELS = [    
  { provider: "google-native", name: "gemini-2.5-flash" }, 
  { provider: "openrouter", name: "deepseek/deepseek-r1:free" }, 
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

// --- INITIALIZE PROVIDERS ---
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
    ],
    presence: {
        status: 'online',
        activities: [{
            name: "Custom Status",
            state: "/ask or /help",
            type: 4 
        }]
    }
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
    
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        console.log('[🔄] Starting Slash Commands (/) registration to Discord...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('[✅] Successfully registered Slash Commands globally!');
    } catch (error) {
        console.error('[❌] Failed to register Slash Commands:', error);
    }
});

const sessions = new Map();

// --- HELPER FUNCTIONS ---

function getSessionId(interaction) {
  switch (CONTEXT_SCOPE) {
    case "user": return interaction.user.id;
    case "channel": return interaction.channelId;
    case "server": return interaction.guildId ? interaction.guildId : interaction.channelId;
    case "channel_user": default: return `${interaction.channelId}-${interaction.user.id}`;
  }
}

function sanitizeMessagesForModel(messages, isVisionModel) {
  return messages.map(msg => {
    if (msg.role === "system") return msg;
    if (typeof msg.content === "string") return msg;
    
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
    console.error(`[Audio/Video Error]: ${error.message}`);
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
      codeLanguage = isInsideCodeBlock ? line.trim().substring(3) : "";
    }
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (isInsideCodeBlock) {
        chunks.push(currentChunk + "\n```");
        currentChunk = "```" + codeLanguage + "\n" + line + "\n";
      } else {
        chunks.push(currentChunk);
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
      console.log(`[🤖] Attempting ${model.provider}: ${model.name}`);
      const safeMessages = sanitizeMessagesForModel(messagesArray, isVisionContext);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("API_TIMEOUT_15S")), 15000)
      );

      let apiCallPromise;

      if (model.provider === "openrouter") {
        apiCallPromise = (async () => {
          const completion = await openrouter.chat.completions.create({ model: model.name, messages: safeMessages }, { timeout: 14000 });
          return { text: completion.choices[0].message.content, modelInfo: `${model.name} via OpenRouter` };
        })();
      } 
      
      else if (model.provider === "groq") {
        apiCallPromise = (async () => {
          const completion = await groq.chat.completions.create({ model: model.name, messages: safeMessages }, { timeout: 14000 });
          return { text: completion.choices[0].message.content, modelInfo: `${model.name} via Groq` };
        })();
      }
      
      else if (model.provider === "google-native") {
        apiCallPromise = (async () => {
          const systemPrompt = safeMessages.find(msg => msg.role === "system")?.content || "";
          const genModel = genAI.getGenerativeModel({ model: model.name, systemInstruction: systemPrompt });
          
          const formattedHistory = safeMessages.slice(1, -1).map(msg => {
              let textContent = "";
              if (typeof msg.content === "string") textContent = msg.content;
              else if (Array.isArray(msg.content)) textContent = msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
              return { role: msg.role === "assistant" ? "model" : "user", parts: [{ text: textContent }] };
          });
          
          const chat = genModel.startChat({ history: formattedHistory.length > 0 ? formattedHistory : undefined });
          const lastMsg = safeMessages[safeMessages.length - 1];
          
          if (Array.isArray(lastMsg.content)) {
            const textPart = lastMsg.content.find(c => c.type === "text")?.text || "";
            const imageParts = await Promise.all(
              lastMsg.content.filter(c => c.type === "image_url").map(async (img) => {
                const response = await axios.get(img.image_url.url, { responseType: 'arraybuffer' });
                return { inlineData: { data: Buffer.from(response.data).toString("base64"), mimeType: "image/png" } };
              })
            );
            const result = await chat.sendMessage([textPart, ...imageParts]);
            return { text: result.response.text(), modelInfo: `${model.name} (Google Native)` };
          } else {
            const result = await chat.sendMessage(lastMsg.content);
            return { text: result.response.text(), modelInfo: `${model.name} (Google Native)` };
          }
        })();
      }

      const result = await Promise.race([apiCallPromise, timeoutPromise]);
      console.log(`[✅] Success: ${model.name}`);
      return result;

    } catch (error) {
      const errorMsg = error.message || "";
      if (errorMsg === "API_TIMEOUT_15S") {
         console.warn(`[⚠️] ${model.provider} (${model.name}) freeze timeout detected (15s). Skipping model...`);
      } else if (errorMsg.includes("429")) {
         console.warn(`[⚠️] ${model.provider} (${model.name}) rate limited (429). Jumping to next fallback...`);
      } else {
         console.warn(`[⚠️] ${model.provider} (${model.name}) failed: ${errorMsg}`);
      }
      continue; 
    }
  }
  
  throw new Error("All providers and models failed.");
}

// --- CORE INTERACTION EVENT ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const sessionId = getSessionId(interaction);

  // --- HANDLER: /HELP COMMAND ---
  if (interaction.commandName === "help") {
    const helpEmbed = new EmbedBuilder()
      .setColor("#5865F2") 
      .setTitle("🤖 AI Assistant Bot User Manual")
      .setDescription("Welcome! This is a smart AI assistant powered by multiple backends (Google Native, Groq, OpenRouter) with automatic language detection mirroring capabilities.")
      .addFields(
        { name: "📋 Available Commands (/) Slashing", value: "• `/ask [prompt]` - Ask any question to the AI with real-time state emulation.\n• `/reset` - Clear your personal chat history/memory context with the AI.\n• `/help` - Bring up this help menu interface manual." },
        { name: "📎 Advanced File Analysis Integration", value: "When processing `/ask`, you can optionally upload an attachment **up to 10 MB**:\n📂 **PDF**: Automatically parses and extracts textual document data.\n🖼️ **Images**: Enables multimodal vision analysis mode for visual assets.\n🎵 **Audio & Video**: Transcribes human spoken speech to text using Whisper API." },
        { name: "⚡ Premium Architecture Mechanisms", value: "• **Multi-Provider Fallback**: If a primary model fails or gets rate limited, it switches to fallbacks within 15 seconds.\n• **Anti-Spam Cooldown Rate**: Imposes a mandatory 5-second waiting interval threshold per user.\n• **Auto-Language Mirroring**: The AI reads your prompt's language and outputs responses in that exact match." }
      )
      .setFooter({ text: "Developed by M • Production Stable Build 2026", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    return interaction.reply({ embeds: [helpEmbed], ephemeral: false });
  }

  // --- HANDLER: /RESET COMMAND ---
  if (interaction.commandName === "reset") {
    if (sessions.has(sessionId)) {
      sessions.delete(sessionId);
      return interaction.reply({ content: "🧹 **Your conversation session history has been successfully reset!**", ephemeral: false });
    } else {
      return interaction.reply({ content: "Your session history context is already empty.", ephemeral: true });
    }
  }

  // --- HANDLER: /ASK COMMAND ---
  if (interaction.commandName === "ask") {
    const promptText = interaction.options.getString("prompt").trim();
    const uploadedFile = interaction.options.getAttachment("file");

    // --- USER COOLDOWN RATELIMIT ---
    const lastUsed = cooldowns.get(interaction.user.id);
    if (lastUsed && (Date.now() - lastUsed < COOLDOWN_TIME)) {
      const timeLeft = ((COOLDOWN_TIME - (Date.now() - lastUsed)) / 1000).toFixed(1);
      return interaction.reply({ content: `⏳ **Hold on!** Please wait **${timeLeft} seconds** before sending another query request.`, ephemeral: true });
    }
    cooldowns.set(interaction.user.id, Date.now());

    // --- PROMPT INJECTION SAFETY FILTER ---
    const containsBannedWord = BANNED_WORDS.some(word => promptText.toLowerCase().includes(word));
    if (containsBannedWord) {
      return interaction.reply({ content: "❌ **Access Denied! Your prompt was blocked by the security system filter.**", ephemeral: true });
    }

    // --- FILE ATTACHMENT MAXIMUM SIZE VALIDATION ---
    if (uploadedFile && uploadedFile.size > MAX_FILE_SIZE) {
      const sizeInMB = (uploadedFile.size / (1024 * 1024)).toFixed(2);
      const limitInMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
      return interaction.reply({ content: `❌ **Processing Failed!** The file \`${uploadedFile.name}\` is **${sizeInMB} MB**. The maximum size allowed threshold is **${limitInMB} MB**.`, ephemeral: true });
    }

    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    // --- TYPING SIGNAL GENERATION & RESERVATION (DEFER REPLY) ---
    await interaction.deferReply();
    
    const typingInterval = setInterval(() => {
      interaction.channel.sendTyping().catch(() => {});
    }, 7000); 

    try {
      let userSession = sessions.get(sessionId);
      if (!userSession || (Date.now() - userSession.lastUpdated > ONE_DAY_MS)) {
        userSession = { 
          messages: [{ 
              role: "system", 
              content: "You are a smart Discord assistant made by M. Always answer clearly. CRITICAL INSTRUCTION: You MUST auto-detect the language used in the user's prompt and respond in that EXACT SAME language. If the user writes in English, reply in English. If the user writes in Indonesian, reply in Indonesian. Mirror their language completely." 
          }], 
          lastUpdated: Date.now(),
          hasImageInHistory: false 
        };
        sessions.set(sessionId, userSession);
      }
      userSession.lastUpdated = Date.now();

      let extractedData = "";
      let images = new Collection();
      let pdfs = new Collection();
      let media = new Collection();

      if (uploadedFile) {
        await interaction.editReply("📂 *Processing and parsing attached file data extensions...*").catch(() => {});
        const fileId = uploadedFile.id;
        if (uploadedFile.contentType === "application/pdf") pdfs.set(fileId, uploadedFile);
        else if (uploadedFile.contentType?.startsWith("video/") || uploadedFile.contentType?.startsWith("audio/")) media.set(fileId, uploadedFile);
        else if (uploadedFile.contentType?.startsWith("image/")) images.set(fileId, uploadedFile);
      }

      const pdfPromises = pdfs.map(async (att) => {
          const res = await axios.get(att.url, { responseType: 'arraybuffer' });
          const data = await pdf(Buffer.from(res.data));
          return `\n[PDF: ${att.name}]\n${data.text.substring(0, 5000)}...\n`;
      });

      const mediaPromises = media.map(async (att) => {
          const isAudio = att.contentType.startsWith("audio/");
          const transcript = await transcribeMedia(att.url, tempDir, isAudio);
          return `\n[MEDIA TRANSCRIPT (${isAudio ? 'Audio' : 'Video'})]: ${transcript}\n`;
      });

      const results = await Promise.all([...pdfPromises, ...mediaPromises]);
      extractedData += results.join("");

      const hasNewImage = images.size > 0;
      const finalPrompt = `${extractedData}\nUSER: ${promptText}`.trim();
      let currentPayload;

      if (hasNewImage) {
        userSession.hasImageInHistory = true;
        currentPayload = [{ type: "text", text: finalPrompt }];
        images.forEach(a => currentPayload.push({ type: "image_url", image_url: { url: a.url } }));
      } else {
        currentPayload = finalPrompt;
      }

      const isVisionContext = hasNewImage || userSession.hasImageInHistory;
      const requestMessages = [...userSession.messages, { role: "user", content: currentPayload }];
      
      await interaction.editReply("🧠 *The AI is formulating your response solution...*").catch(() => {});

      const { text: responseText } = await fetchWithFallback(requestMessages, isVisionContext);

      clearInterval(typingInterval);

      userSession.messages.push({ role: "user", content: currentPayload }); 
      userSession.messages.push({ role: "assistant", content: responseText });

      if (userSession.messages.length > MAX_HISTORY * 2 + 1) { 
          userSession.messages = [userSession.messages[0], ...userSession.messages.slice(-(MAX_HISTORY * 2))];
      }

      // --- REMOVED FOOTER INFO HERE ---
      const finalResponseWithFooter = `> **Prompt:** ${promptText}\n\n${responseText}`;
      const chunks = splitMessage(finalResponseWithFooter);

      // Emulate stream output payload directly via editing the deferred token placeholder
      await interaction.editReply(chunks[0]).catch(() => {});

      // Dispatch secondary segmented text frames safely under rate limits
      if (chunks.length > 1) {
        for (let i = 1; i < chunks.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000)); 
          await interaction.followUp(chunks[i]);
        }
      }

    } catch (error) {
      console.error(error);
      clearInterval(typingInterval); 
      await interaction.editReply("```❌ All upstream API providers are busy or timed out. Please try sending your request again later.```").catch(() => {});
    }
  }
});

// --- SESSION SWEEPER CRON LOOP ---
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUpdated > ONE_DAY_MS) sessions.delete(id);
  }
}, 6 * 60 * 60 * 1000);

client.login(BOT_TOKEN);
