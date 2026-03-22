/**
 * GIMSA WhatsApp Baileys Service
 * 
 * Servicio standalone que conecta WhatsApp vía QR (como WhatsApp Web)
 * y expone una API REST + WebSocket para el frontend de Lovable.
 * 
 * Deploy: Railway, Render, VPS, o cualquier hosting Node.js persistente.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WhatsAppManager } = require('./whatsapp');
const { SupabaseSync } = require('./supabase-sync');
const { setupRoutes } = require('./routes');

const app = express();
app.use(cors());
app.use(express.json({ limit: '16mb' }));

// ─── Estado global ───
const state = {
  qr: null,
  status: 'disconnected', // disconnected | qr_pending | connected | reconnecting
  phoneNumber: null,
  pushName: null,
  connectedAt: null,
};

// ─── Iniciar WhatsApp Manager ───
const wa = new WhatsAppManager(state);
const sync = new SupabaseSync();

// ─── Registrar eventos de WhatsApp → Supabase ───
wa.on('message:received', async (msg) => {
  try {
    await sync.saveIncomingMessage(msg);
  } catch (err) {
    console.error('Error guardando mensaje entrante:', err.message);
  }
});

wa.on('message:sent', async (msg) => {
  try {
    await sync.saveSentMessage(msg);
  } catch (err) {
    console.error('Error guardando mensaje saliente:', err.message);
  }
});

wa.on('message:status', async (update) => {
  try {
    await sync.updateMessageStatus(update);
  } catch (err) {
    console.error('Error actualizando status:', err.message);
  }
});

// ─── Rutas HTTP ───
setupRoutes(app, wa, state, sync);

// ─── Iniciar servidor ───
const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`\n🟢 GIMSA WhatsApp Service corriendo en puerto ${PORT}`);
  console.log(`📱 Estado: ${state.status}`);
  console.log(`🔗 QR endpoint: http://localhost:${PORT}/api/qr`);
  console.log(`📊 Status: http://localhost:${PORT}/api/status\n`);
  
  // Auto-conectar si hay sesión guardada
  wa.connect();
});
