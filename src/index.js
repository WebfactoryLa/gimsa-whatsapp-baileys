/**
 * GIMSA WhatsApp Baileys Service — Multi-Número
 * 
 * Servicio que maneja múltiples conexiones WhatsApp vía QR.
 * Cada "línea" es una instancia independiente de Baileys.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { InstanceManager } = require('./instance-manager');
const { SupabaseSync } = require('./supabase-sync');
const { setupRoutes } = require('./routes');

const app = express();
app.use(cors());
app.use(express.json({ limit: '16mb' }));

const sync = new SupabaseSync();
const manager = new InstanceManager(sync);

// Rutas HTTP
setupRoutes(app, manager, sync);

// Iniciar servidor
const PORT = process.env.PORT || 3100;
app.listen(PORT, async () => {
  console.log(`\n🟢 GIMSA WhatsApp Multi-Número corriendo en puerto ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/api/lineas`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);
  
  // Auto-reconectar líneas activas desde Supabase
  await manager.autoReconnect();
});
