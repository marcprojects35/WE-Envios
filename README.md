# WE-Envios

WhatsApp bulk messaging platform with a real-time web dashboard. Connect your WhatsApp account via QR code and send personalized messages to contact lists imported from spreadsheets.

---

## Features

- QR code authentication via WebSocket (no phone number required)
- Bulk message dispatch with per-contact personalization
- Import contacts from `.xlsx` / `.csv` spreadsheets
- Real-time progress tracking with live delivery stats
- Pause, resume, and stop active sending sessions
- Automatic number validation and format normalization (BR)
- Contact name resolution from WhatsApp

## Stack

- **Runtime** — Node.js (ESM)
- **WhatsApp** — [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)
- **Server** — Express + `ws` (WebSocket)
- **Frontend** — Vanilla HTML/JS served statically
- **Spreadsheets** — XLSX

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open `http://localhost:3000`, scan the QR code with WhatsApp, then upload your contact list and compose your message.

## Deployment

Preconfigured for [Render](https://render.com) via `render.yaml`. Push to main and it deploys automatically.

## Contact List Format

| Column | Description |
|--------|-------------|
| `numero` | Phone number (with or without country code) |
| `nome` | Contact name (used in `{nome}` placeholder) |

Message template supports `{nome}` for per-contact personalization.

---

> **Note:** Use responsibly and in compliance with WhatsApp's Terms of Service. Mass messaging without consent may result in account suspension.
