/**
 * Rutas API — Multi-Línea
 */

const { v4: uuidv4 } = require('uuid');

function setupRoutes(app, manager, sync) {

  // ═══════════════════════════════════════════════════
  // LÍNEAS — CRUD
  // ═══════════════════════════════════════════════════

  /**
   * GET /api/lineas
   * Lista todas las líneas con su estado actual
   */
  app.get('/api/lineas', async (req, res) => {
    try {
      if (!sync.supabase) {
        return res.json({ success: true, lineas: [], source: 'memory', statuses: manager.getAllStatus() });
      }

      const { data, error } = await sync.supabase
        .from('reportia_eneache_wa_lineas')
        .select('*')
        .eq('activa', true)
        .order('orden', { ascending: true });

      if (error) throw error;

      // Enriquecer con estado en tiempo real del manager
      const lineas = (data || []).map(l => {
        const instance = l.instancia_id ? manager.get(l.instancia_id) : null;
        const liveStatus = instance ? instance.getStatus() : null;
        return {
          ...l,
          live_status: liveStatus?.status || l.estado,
          live_qr: liveStatus?.qr || null,
          live_phone: liveStatus?.phoneNumber || l.telefono,
          live_push_name: liveStatus?.pushName || l.push_name,
        };
      });

      res.json({ success: true, lineas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas
   * Crear nueva línea
   * Body: { nombre, descripcion?, color?, avatar_emoji? }
   */
  app.post('/api/lineas', async (req, res) => {
    try {
      const { nombre, descripcion, color, avatar_emoji } = req.body;
      if (!nombre) return res.status(400).json({ success: false, error: 'Se requiere nombre' });

      const instanciaId = 'wa_' + uuidv4().split('-')[0];

      if (!sync.supabase) {
        // Sin Supabase, solo crear en memoria
        await manager.create(null, instanciaId);
        return res.json({ success: true, linea: { instancia_id: instanciaId, nombre }, source: 'memory' });
      }

      const { data, error } = await sync.supabase
        .from('reportia_eneache_wa_lineas')
        .insert({
          nombre,
          descripcion: descripcion || null,
          color: color || '#3b82f6',
          avatar_emoji: avatar_emoji || '📱',
          instancia_id: instanciaId,
          estado: 'disconnected',
        })
        .select()
        .single();

      if (error) throw error;

      // Crear instancia en el manager
      await manager.create(data.id, instanciaId);

      res.json({ success: true, linea: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /api/lineas/:id
   * Editar línea
   */
  app.put('/api/lineas/:id', async (req, res) => {
    try {
      const { nombre, descripcion, color, avatar_emoji } = req.body;
      if (!sync.supabase) return res.status(503).json({ success: false, error: 'Supabase no configurado' });

      const { data, error } = await sync.supabase
        .from('reportia_eneache_wa_lineas')
        .update({ nombre, descripcion, color, avatar_emoji, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, linea: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/lineas/:id
   * Eliminar línea
   */
  app.delete('/api/lineas/:id', async (req, res) => {
    try {
      if (!sync.supabase) return res.status(503).json({ success: false, error: 'Supabase no configurado' });

      // Obtener instancia_id antes de borrar
      const { data: linea } = await sync.supabase
        .from('reportia_eneache_wa_lineas')
        .select('instancia_id')
        .eq('id', req.params.id)
        .single();

      if (linea?.instancia_id) {
        await manager.remove(linea.instancia_id);
      }

      await sync.supabase
        .from('reportia_eneache_wa_lineas')
        .update({ activa: false })
        .eq('id', req.params.id);

      res.json({ success: true, message: 'Línea eliminada' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // CONEXIÓN POR LÍNEA
  // ═══════════════════════════════════════════════════

  /**
   * GET /api/lineas/:id/status
   */
  app.get('/api/lineas/:id/status', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      if (!instanciaId) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      const instance = manager.get(instanciaId);
      if (!instance) {
        return res.json({ success: true, status: 'disconnected', phoneNumber: null, hasQr: false });
      }

      const status = instance.getStatus();
      res.json({ success: true, ...status, hasQr: !!status.qr });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/lineas/:id/qr
   */
  app.get('/api/lineas/:id/qr', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      if (!instanciaId) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      const instance = manager.get(instanciaId);
      if (!instance) return res.json({ status: 'disconnected', qr: null });

      const status = instance.getStatus();
      if (status.status === 'connected') {
        return res.json({ status: 'connected', qr: null, message: 'Ya conectado' });
      }

      res.json({ status: status.status, qr: status.qr, message: status.qr ? 'Escaneá el QR' : 'Esperá, generando QR...' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/connect
   */
  app.post('/api/lineas/:id/connect', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      if (!instanciaId) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      let instance = manager.get(instanciaId);
      if (!instance) {
        instance = await manager.create(req.params.id, instanciaId);
      }

      const status = instance.getStatus();
      if (status.status === 'connected') {
        return res.json({ success: true, message: 'Ya conectado' });
      }

      await manager.connect(instanciaId);
      res.json({ success: true, message: 'Conectando... consultá /api/lineas/' + req.params.id + '/qr' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/disconnect
   */
  app.post('/api/lineas/:id/disconnect', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      if (!instanciaId) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      await manager.disconnect(instanciaId);
      res.json({ success: true, message: 'Desconectado' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/reconnect
   */
  app.post('/api/lineas/:id/reconnect', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      if (!instanciaId) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      await manager.reconnect(instanciaId);
      res.json({ success: true, message: 'Reconectando con QR nuevo...' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // MENSAJES POR LÍNEA
  // ═══════════════════════════════════════════════════

  /**
   * POST /api/lineas/:id/send/text
   */
  app.post('/api/lineas/:id/send/text', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      const instance = manager.get(instanciaId);
      if (!instance) return res.status(404).json({ success: false, error: 'Línea no encontrada o no conectada' });

      const { phone, text } = req.body;
      if (!phone || !text) return res.status(400).json({ success: false, error: 'Se requiere phone y text' });

      const result = await instance.sendText(phone, text);
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/send/image
   */
  app.post('/api/lineas/:id/send/image', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      const instance = manager.get(instanciaId);
      if (!instance) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      const { phone, image, caption, mimetype } = req.body;
      if (!phone || !image) return res.status(400).json({ success: false, error: 'Se requiere phone e image' });

      const buffer = Buffer.from(image, 'base64');
      const result = await instance.sendImage(phone, buffer, caption || '', mimetype || 'image/jpeg');
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/send/document
   */
  app.post('/api/lineas/:id/send/document', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      const instance = manager.get(instanciaId);
      if (!instance) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      const { phone, document, filename, mimetype, caption } = req.body;
      if (!phone || !document || !filename) return res.status(400).json({ success: false, error: 'Se requiere phone, document y filename' });

      const buffer = Buffer.from(document, 'base64');
      const result = await instance.sendDocument(phone, buffer, filename, mimetype || 'application/pdf', caption || '');
      res.json({ success: true, message: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/lineas/:id/check-number
   */
  app.post('/api/lineas/:id/check-number', async (req, res) => {
    try {
      const instanciaId = await _getInstanciaId(req.params.id);
      const instance = manager.get(instanciaId);
      if (!instance) return res.status(404).json({ success: false, error: 'Línea no encontrada' });

      const { phone } = req.body;
      if (!phone) return res.status(400).json({ success: false, error: 'Se requiere phone' });

      const result = await instance.checkNumber(phone);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════
  // CONVERSACIONES
  // ═══════════════════════════════════════════════════

  /**
   * GET /api/lineas/:id/conversations
   */
  app.get('/api/lineas/:id/conversations', async (req, res) => {
    try {
      const data = await sync.getConversations(req.params.id, parseInt(req.query.limit) || 50);
      res.json({ success: true, conversations: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/conversations — todas las conversaciones QR (sin filtro de línea)
   */
  app.get('/api/conversations', async (req, res) => {
    try {
      const data = await sync.getConversations(null, parseInt(req.query.limit) || 50);
      res.json({ success: true, conversations: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/conversations/:id/messages
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
  // HEALTH
  // ═══════════════════════════════════════════════════

  app.get('/health', (req, res) => {
    const statuses = manager.getAllStatus();
    const connected = Object.values(statuses).filter(s => s.status === 'connected').length;
    const total = Object.keys(statuses).length;

    res.json({
      service: 'gimsa-whatsapp-baileys-multi',
      status: 'running',
      instances: { total, connected },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ═══════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════

  async function _getInstanciaId(lineaId) {
    if (!sync.supabase) return null;
    const { data } = await sync.supabase
      .from('reportia_eneache_wa_lineas')
      .select('instancia_id')
      .eq('id', lineaId)
      .single();
    return data?.instancia_id || null;
  }

  // Heartbeat cada 30 segundos
  setInterval(() => manager.heartbeat(), 30000);
}

module.exports = { setupRoutes };
