/**
 * Rutas API
 * 
 * Endpoints REST que el frontend (Lovable) consume
 * para interactuar con WhatsApp.
 */

function setupRoutes(app, wa, state, sync) {

  // ═══════════════════════════════════════════════════
  // CONEXIÓN
  // ═══════════════════════════════════════════════════

  /**
   * GET /api/status
   * Estado actual de la conexión
   */
  app.get('/api/status', (req, res) => {
    res.json({
      status: state.status,
      phoneNumber: state.phoneNumber,
      pushName: state.pushName,
      connectedAt: state.connectedAt,
      hasQr: !!state.qr,
    });
  });

  /**
   * GET /api/qr
   * Obtener QR como imagen base64 para mostrar en el frontend
   */
  app.get('/api/qr', (req, res) => {
    if (state.status === 'connected') {
      return res.json({ status: 'connected', qr: null, message: 'Ya estás conectado' });
    }

    if (!state.qr) {
      return res.json({ status: state.status, qr: null, message: 'QR no disponible todavía. Esperá unos segundos.' });
    }

    res.json({
      status: 'qr_pending',
      qr: state.qr, // base64 data URL, listo para <img src="...">
      message: 'Escaneá este QR con WhatsApp',
    });
  });

  /**
   * POST /api/connect
   * Iniciar conexión (genera QR nuevo)
   */
  app.post('/api/connect', async (req, res) => {
    if (state.status === 'connected') {
      return res.json({ success: true, message: 'Ya estás conectado' });
    }

    try {
      wa.connect();
      res.json({ success: true, message: 'Conectando... consultá /api/qr para obtener el QR' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/disconnect
   * Desconectar y limpiar sesión
   */
  app.post('/api/disconnect', async (req, res) => {
    try {
      await wa.disconnect();
      res.json({ success: true, message: 'Desconectado. Se requiere nuevo escaneo QR para reconectar.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/reconnect
   * Limpiar sesión y reconectar (genera QR nuevo)
   */
  app.post('/api/reconnect', async (req, res) => {
    try {
      wa.clearSession();
      state.status = 'disconnected';
      state.qr = null;
      state.phoneNumber = null;
      
      // Esperar un momento y reconectar
      setTimeout(() => wa.connect(), 1000);
      
      res.json({ success: true, message: 'Sesión limpiada. Conectando con QR nuevo...' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // MENSAJES
  // ═══════════════════════════════════════════════════

  /**
   * POST /api/send/text
   * Enviar mensaje de texto
   * Body: { phone: "595981234567", text: "Hola" }
   */
  app.post('/api/send/text', async (req, res) => {
    try {
      const { phone, text } = req.body;
      if (!phone || !text) {
        return res.status(400).json({ success: false, error: 'Se requiere phone y text' });
      }

      const result = await wa.sendText(phone, text);
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/send/image
   * Enviar imagen (base64)
   * Body: { phone, image: "base64...", caption: "opcional", mimetype: "image/jpeg" }
   */
  app.post('/api/send/image', async (req, res) => {
    try {
      const { phone, image, caption, mimetype } = req.body;
      if (!phone || !image) {
        return res.status(400).json({ success: false, error: 'Se requiere phone e image (base64)' });
      }

      const buffer = Buffer.from(image, 'base64');
      const result = await wa.sendImage(phone, buffer, caption || '', mimetype || 'image/jpeg');
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/send/document
   * Enviar documento (base64)
   * Body: { phone, document: "base64...", filename, mimetype, caption }
   */
  app.post('/api/send/document', async (req, res) => {
    try {
      const { phone, document, filename, mimetype, caption } = req.body;
      if (!phone || !document || !filename) {
        return res.status(400).json({ success: false, error: 'Se requiere phone, document (base64) y filename' });
      }

      const buffer = Buffer.from(document, 'base64');
      const result = await wa.sendDocument(phone, buffer, filename, mimetype || 'application/pdf', caption || '');
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/check-number
   * Verificar si un número tiene WhatsApp
   * Body: { phone: "595981234567" }
   */
  app.post('/api/check-number', async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        return res.status(400).json({ success: false, error: 'Se requiere phone' });
      }

      const result = await wa.checkNumber(phone);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // CONVERSACIONES (lee de Supabase)
  // ═══════════════════════════════════════════════════

  /**
   * GET /api/conversations
   * Lista de conversaciones activas
   */
  app.get('/api/conversations', async (req, res) => {
    try {
      const data = await sync.getConversations(parseInt(req.query.limit) || 50);
      res.json({ success: true, conversations: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/conversations/:id/messages
   * Mensajes de una conversación
   */
  app.get('/api/conversations/:id/messages', async (req, res) => {
    try {
      const data = await sync.getMessages(req.params.id, parseInt(req.query.limit) || 100);
      res.json({ success: true, messages: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // PIPELINE
  // ═══════════════════════════════════════════════════

  /**
   * POST /api/conversations/:id/create-opportunity
   * Crear oportunidad en el pipeline desde una conversación
   * Body: { empresa, contacto_nombre, cantidad_uniformes, notas }
   */
  app.post('/api/conversations/:id/create-opportunity', async (req, res) => {
    try {
      const opp = await sync.createOpportunityFromChat(req.params.id, req.body);
      res.json({ success: true, opportunity: opp });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════════════════

  app.get('/health', (req, res) => {
    res.json({
      service: 'gimsa-whatsapp-baileys',
      status: 'running',
      whatsapp: state.status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });
}

module.exports = { setupRoutes };
