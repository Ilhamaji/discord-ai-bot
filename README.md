<div align="center">

# Discord AI Bot

**Multi-provider Discord AI assistant** — satu bot, banyak model LLM, dengan fallback otomatis saat kena rate limit.

[![Status](https://img.shields.io/badge/status-active-brightgreen?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org)

</div>

---

## Tentang

Bot Discord berbasis **Discord.js v14** yang menghubungkan satu antarmuka chat ke beberapa provider AI sekaligus: **OpenRouter**, **Google Gemini (native)**, dan **Groq**. Fokus utamanya adalah **ketahanan**: ketika satu model kena `429 Too Many Requests`, bot otomatis berpindah ke model berikutnya tanpa mengganggu percakapan.

## Fitur

- **Fallback antar-provider.** Daftar model diurutkan menurut kuota terpisah: Groq & Gemini lebih dulu, OpenRouter di belakang. Saat satu model kena `429`, bot pindah ke model berikutnya dan percakapan tetap jalan.
- **Cooldown per model.** Model yang kena rate limit ditandai dan dilewati sementara, bukan dicoba terus-menerus.
- **Input teks, gambar, PDF, dan voice note.** Vision via Gemini, PDF dibaca `pdf-parse`, audio ditranskripsi lewat `fluent-ffmpeg`.
- **Konteks 10 pesan terakhir** per channel.
- **Batas 10 MB** per file.
- **Anti-spam:** cooldown 5 detik per user dan filter kata terlarang.
- **UI Discord:** slash command, button, select menu, dan modal.
- **Anti-crash:** handler `unhandledRejection` / `uncaughtException` untuk error jaringan Discord yang biasanya mematikan bot.

## Tech Stack

| Bagian | Teknologi |
| --- | --- |
| Runtime | Node.js 18+ |
| Library | Discord.js v14 |
| AI Provider | OpenRouter, Google Generative AI, Groq |
| Ekstraksi file | `pdf-parse`, `fluent-ffmpeg` |
| Deploy | PM2 (`ecosystem.config.js`) |

## Menjalankan

### 1. Clone & install

```bash
git clone https://github.com/Ilhamaji/discord-ai-bot.git
cd discord-ai-bot
npm install
```

### 2. Buat file `.env`

Semua variabel di bawah **wajib** — bot akan `process.exit(1)` bila salah satu kosong.

```env
BOT_TOKEN=          # Discord bot token
API_KEY=            # OpenRouter API key
GOOGLE_API_KEY=     # Google AI / Gemini API key
GROQ_API_KEY=       # Groq API key
```

Contoh lengkap tersedia di `.env_example`.

### 3. Jalankan

```bash
node index.js
```

### 4. Deploy ke server (opsional)

```bash
./deploy.sh          # atau
pm2 start ecosystem.config.js
```

## Cara Pakai

Bot menerima dua gaya perintah.

**Prefix `?`**

```
?jelaskan konsep rekursi dengan analogi sederhana
?ask [pertanyaan]      # bentuk eksplisit
?reset                 # hapus memori percakapan
?help                  # tampilkan bantuan
```

**Slash command** — `/help` dan perintah lain yang didaftarkan saat startup (`Routes.applicationCommands`).

Kirim gambar, PDF, atau voice note bersama teks pertanyaan — bot memilih model vision/audio yang sesuai.

## Struktur

```
index.js              # entrypoint: config provider, model chain, handler pesan
deploy.sh             # script deploy
ecosystem.config.js   # konfigurasi PM2
.env_example          # template environment
```

## Catatan

Daftar model di `index.js` telah diverifikasi langsung ke tiap provider (lihat komentar `verified live` di dalam kode). Model gratis berbagi kuota harian, jadi urutan model sengaja diatur agar provider dengan kuota terpisah dipakai lebih dulu.

---

<div align="center">
Dibuat oleh <a href="https://github.com/Ilhamaji">Ilham Aji</a>
</div>
