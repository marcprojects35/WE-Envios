import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import XLSX from "xlsx";
import qrcode from "qrcode";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "5mb" }));
app.use(express.static(join(__dirname, "public")));

// ─── Estado global ─────────────────────────────────────────────────────────────
let sock = null;
let connectionStatus = "disconnected";
let contacts = [];
const waContacts = {};

const sending = {
  active: false,
  paused: false,
  stop: false,
  total: 0,
  sent: 0,
  errors: 0,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yield_ = () => new Promise((r) => setImmediate(r));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) try { c.send(msg); } catch {}
  });
}

function normalizeNumber(raw) {
  let num = String(raw).replace(/\D/g, "");
  if (!num.startsWith("55")) num = "55" + num;
  return num;
}

async function resolveJid(rawNumber) {
  const num = normalizeNumber(rawNumber);
  try {
    const res = await Promise.race([sock.onWhatsApp(num), sleep(4000).then(() => null)]);
    if (res?.[0]?.exists && res[0]?.jid) return res[0].jid;
    if (num.length === 13 && num[4] === "9") {
      const alt = num.slice(0, 4) + num.slice(5);
      const res2 = await Promise.race([sock.onWhatsApp(alt), sleep(4000).then(() => null)]);
      if (res2?.[0]?.exists && res2[0]?.jid) return res2[0].jid;
      return `${alt}@s.whatsapp.net`;
    }
  } catch {}
  return `${num}@s.whatsapp.net`;
}

function getWaName(jid, fallback) {
  const c = waContacts[jid] || waContacts[jid?.replace("@s.whatsapp.net", "") + "@s.whatsapp.net"];
  return c?.name || c?.notify || fallback || "";
}

// ─── Conexão WhatsApp ──────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["WE Envios", "Chrome", "1.0.0"],
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
    });

    sock.ev.on("contacts.upsert", (list) => {
      for (const c of list) if (c.id) waContacts[c.id] = c;
    });
    sock.ev.on("contacts.update", (list) => {
      for (const c of list) if (c.id) waContacts[c.id] = { ...(waContacts[c.id] || {}), ...c };
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          connectionStatus = "qr";
          broadcast({ type: "status", status: "qr" });
          broadcast({ type: "qr", qr: await qrcode.toDataURL(qr) });
        } catch {}
      }
      if (connection === "close") {
        connectionStatus = "disconnected";
        broadcast({ type: "status", status: "disconnected" });
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
      }
      if (connection === "open") {
        connectionStatus = "connected";
        broadcast({ type: "status", status: "connected" });
        broadcast({ type: "qr", qr: null });
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    console.error("Erro ao conectar:", err.message);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// ─── Loop de envio não-bloqueante ──────────────────────────────────────────────
async function runSendLoop(message, delayMs) {
  sending.active = true;
  sending.paused = false;
  sending.stop = false;
  sending.sent = 0;
  sending.errors = 0;

  const pendingIndexes = contacts
    .map((c, i) => (c.status === "pending" ? i : -1))
    .filter((i) => i !== -1);

  sending.total = pendingIndexes.length;
  broadcast({ type: "sending_start", total: sending.total });

  for (const i of pendingIndexes) {
    await yield_();
    if (sending.stop) break;

    while (sending.paused && !sending.stop) {
      await sleep(300);
      await yield_();
    }
    if (sending.stop) break;

    const contact = contacts[i];
    if (!contact || contact.status !== "pending") continue;

    try {
      const jid = await resolveJid(contact.number);
      const waName = getWaName(jid, contact.name);
      if (waName && waName !== contacts[i].name) contacts[i].name = waName;

      const text = message.replace(/\{nome\}/gi, contacts[i].name || "");
      await sock.sendMessage(jid, { text });

      contacts[i].status = "sent";
      sending.sent++;
      broadcast({ type: "contact_update", index: i, contact: contacts[i] });
      broadcast({ type: "log", entry: { name: contacts[i].name || contact.number, number: contact.number, status: "sent", sent: sending.sent, errors: sending.errors, total: sending.total, time: new Date().toLocaleTimeString("pt-BR") } });
    } catch (err) {
      contacts[i].status = "error";
      sending.errors++;
      broadcast({ type: "contact_update", index: i, contact: contacts[i] });
      broadcast({ type: "log", entry: { name: contact.name || contact.number, number: contact.number, status: "error", error: err.message, sent: sending.sent, errors: sending.errors, total: sending.total, time: new Date().toLocaleTimeString("pt-BR") } });
    }

    await yield_();
    if (!sending.stop) {
      const jitter = delayMs * 0.15 * (Math.random() * 2 - 1);
      await sleep(Math.max(1500, delayMs + jitter));
      await yield_();
    }
  }

  sending.active = false;
  broadcast({ type: "sending_done", sent: sending.sent, errors: sending.errors, total: sending.total, stopped: sending.stop });
}

// ─── Rotas API ─────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) =>
  res.json({ status: connectionStatus, sending: sending.active, paused: sending.paused, sent: sending.sent, errors: sending.errors, total: sending.total })
);

app.get("/api/contacts", (req, res) => res.json(contacts));

app.post("/api/upload", express.raw({ type: "*/*", limit: "20mb" }), (req, res) => {
  try {
    const wb = XLSX.read(req.body, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row?.length) continue;
      const name = String(row[0] ?? "").trim();
      const number = String(row[1] ?? "").replace(/\D/g, "").trim();
      if (number.length >= 8) parsed.push({ name, number, status: "pending" });
    }
    if (!parsed.length) return res.status(400).json({ error: "Nenhum número válido encontrado" });
    contacts = parsed;
    broadcast({ type: "contacts", contacts });
    res.json({ success: true, count: parsed.length });
  } catch (e) {
    res.status(400).json({ error: "Erro ao ler planilha: " + e.message });
  }
});

app.post("/api/contacts/add", (req, res) => {
  const { name = "", number = "" } = req.body || {};
  const clean = String(number).replace(/\D/g, "");
  if (clean.length < 8) return res.status(400).json({ error: "Número inválido" });
  const contact = { name: String(name).trim(), number: clean, status: "pending" };
  contacts.push(contact);
  broadcast({ type: "contact_added", contact, total: contacts.length });
  res.json({ success: true, total: contacts.length });
});

app.delete("/api/contacts/:index", (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= contacts.length) return res.status(400).json({ error: "Índice inválido" });
  contacts.splice(idx, 1);
  broadcast({ type: "contacts", contacts });
  res.json({ success: true, total: contacts.length });
});

app.delete("/api/contacts", (req, res) => {
  contacts = [];
  broadcast({ type: "contacts", contacts });
  res.json({ success: true });
});

app.post("/api/contacts/reset-errors", (req, res) => {
  let count = 0;
  contacts.forEach((c) => { if (c.status === "error") { c.status = "pending"; count++; } });
  broadcast({ type: "contacts", contacts });
  res.json({ success: true, reset: count });
});

app.post("/api/send", (req, res) => {
  if (!sock || connectionStatus !== "connected") return res.status(400).json({ error: "WhatsApp não conectado" });
  if (sending.active) return res.status(400).json({ error: "Envio já em andamento" });
  const { message = "", delay = 4000 } = req.body || {};
  if (!message.trim()) return res.status(400).json({ error: "Mensagem vazia" });
  const pendingCount = contacts.filter((c) => c.status === "pending").length;
  if (!pendingCount) return res.status(400).json({ error: "Nenhum contato pendente" });
  const safeDelay = Math.max(1500, parseInt(delay) || 4000);
  res.json({ success: true, total: pendingCount });
  setImmediate(() => runSendLoop(message, safeDelay));
});

app.post("/api/send/pause", (req, res) => {
  if (!sending.active) return res.status(400).json({ error: "Nenhum envio ativo" });
  sending.paused = !sending.paused;
  broadcast({ type: "sending_paused", paused: sending.paused });
  res.json({ success: true, paused: sending.paused });
});

app.post("/api/send/stop", (req, res) => {
  sending.stop = true;
  sending.paused = false;
  res.json({ success: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
server.listen(3000, () => {
  console.log("✅ WE — WhatsApp Envios rodando em http://localhost:3000");
  connectToWhatsApp();
});

process.on("uncaughtException", (err) => console.error("Erro:", err.message));
process.on("unhandledRejection", (err) => console.error("Rejeição:", err?.message || err));
