/**
 * WhatsApp Instance — v2.1 FIXES
 * 
 * Fixes:
 * - markOnlineOnConnect: true (mensajes se entregan)
 * - getMessage handler (reenvíos)
 * - Foto de perfil del contacto
 * - Logs detallados para debug
 * - Captura de mensajes propios (enviados desde el teléfono)
 * - Descarga y almacenamiento de media (imágenes, audios, docs)
 * - Envío de audio como nota de voz (ptt)
 * - Normalización de teléfonos Paraguay
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
        downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const QRCode = require('qrcode');

class WhatsAppInstance {
  constructor(instanciaId, lineaId, authDir, sync) {
    this.instanciaId = instanciaId;
    this.lineaId = lineaId;
    this.authDir = authDir;
    this.sync = sync;
    this.sock = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.logger = pino({ level: 'silent' });

    this.state = {
      status: 'disconnected',
      qr: null,
      phoneNumber: null,
      pushName: null,
      connectedAt: null,
    };
  }

  async connect() {
    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.logger),
        },
        printQRInTerminal: false,
        logger: this.logger,
        browser: ['GIMSA ' + this.instanciaId, 'Chrome', '22.0'],
        markOnlineOnConnect: true,           // FIX: necesario para entrega de mensajes
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {          // FIX: necesario para reenvíos multi-device
          return { conversation: '' };
        },
      });

      this.sock.ev.on('creds.update', saveCreds);

      // ─── Conexión ───
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.state.status = 'qr_pending';
          this.state.qr = await QRCode.toDataURL(qr);
          console.log(`📱 [${this.instanciaId}] QR generado`);
          this._updateSupabaseStatus('qr_pending');
        }

        if (connection === 'open') {
          this.state.status = 'connected';
          this.state.qr = null;
          this.retryCount = 0;

          const user = this.sock.user;
          if (user) {
            this.state.phoneNumber = user.id.split(':')[0].split('@')[0];
            this.state.pushName = user.name || null;
          }
          this.state.connectedAt = new Date().toISOString();

          console.log(`✅ [${this.instanciaId}] Conectado: +${this.state.phoneNumber} (${this.state.pushName})`);
          this._updateSupabaseStatus('connected');
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`❌ [${this.instanciaId}] Desconectado (código: ${statusCode})`);

          if (statusCode === DisconnectReason.loggedOut) {
            this.state.status = 'disconnected';
            this.state.qr = null;
            this.state.phoneNumber = null;
            this.state.pushName = null;
            this._clearSession();
            this._updateSupabaseStatus('disconnected');
          } else if (shouldReconnect && this.retryCount < this.maxRetries) {
            this.state.status = 'reconnecting';
            this.retryCount++;
            const delay = Math.min(5000 * this.retryCount, 30000);
            console.log(`🔄 [${this.instanciaId}] Reconectando en ${delay / 1000}s (${this.retryCount}/${this.maxRetries})`);
            this._updateSupabaseStatus('reconnecting');
            setTimeout(() => this.connect(), delay);
          } else {
            this.state.status = 'disconnected';
            this._updateSupabaseStatus('disconnected');
          }
        }
      });

      // ─── Mensajes (entrantes + propios) ───
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 [${this.instanciaId}] messages.upsert: type=${type}, count=${messages.length}`);

        if (type !== 'notify') return;

        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid;
          if (remoteJid === 'status@broadcast') continue;
          if (!remoteJid) continue;

          const isFromMe = msg.key.fromMe;
          const parsed = this._parseMessage(msg);
          if (!parsed) {
            console.log(`   ⚠️ [${this.instanciaId}] Mensaje no parseado (tipo no soportado)`);
            continue;
          }

          // Descargar media si tiene
          if (['image', 'audio', 'video', 'document'].includes(parsed.type)) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const mediaUrl = await this._uploadMedia(buffer, parsed);
              if (mediaUrl) parsed.mediaUrl = mediaUrl;
            } catch (mediaErr) {
              console.error(`   ⚠️ [${this.instanciaId}] Error descargando media: ${mediaErr.message}`);
            }
          }

          if (isFromMe) {
            // Mensaje propio (enviado desde el teléfono u otra sesión)
            console.log(`   📤 [${this.instanciaId}] Propio → +${parsed.phone}: ${parsed.content?.substring(0, 50) || `[${parsed.type}]`}`);
            try {
              await this.sync.saveSentMessage({
                ...parsed,
                respondidoPor: 'humano',
              }, this.lineaId);
            } catch (err) {
              // Ignorar duplicados
              if (!err.message?.includes('duplicate')) {
                console.error(`   ❌ Error guardando msg propio: ${err.message}`);
              }
            }
          } else {
            // Mensaje entrante
            // Obtener foto de perfil
            let profilePic = null;
            try {
              profilePic = await this.sock.profilePictureUrl(remoteJid, 'image');
            } catch (e) {
              // Contacto sin foto o privacidad activada
            }
            parsed.profilePic = profilePic;

            console.log(`   📩 [${this.instanciaId}] Entrante ← +${parsed.phone} (${parsed.pushName}): ${parsed.content?.substring(0, 50) || `[${parsed.type}]`}`);

            try {
              const result = await this.sync.saveIncomingMessage(parsed, this.lineaId);
              console.log(`   💾 Guardado: conv=${result?.conversation?.id}`);
            } catch (err) {
              console.error(`   ❌ Error guardando msg entrante: ${err.message}`);
            }
          }
        }
      });

      // ─── Status updates ───
      this.sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
          if (update.update?.status) {
            const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' };
            const statusName = statusMap[update.update.status];
            if (statusName) {
              this.sync.updateMessageStatus(update.key.id, statusName).catch(() => {});
            }
          }
        }
      });

    } catch (err) {
      console.error(`Error conectando [${this.instanciaId}]:`, err.message);
      this.state.status = 'disconnected';
    }
  }

  // ─── Envío de mensajes ───

  async sendText(phone, text) {
    this._ensureConnected();
    const jid = this._formatJid(phone);

    // Verificar que el número tiene WhatsApp
    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El número no tiene WhatsApp');

    const result = await this.sock.sendMessage(jid, { text });
    await new Promise(r => setTimeout(r, 500)); // Esperar confirmación

    const sent = {
      messageId: result.key.id, phone: this._cleanPhone(phone),
      jid, type: 'text', content: text, timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendImage(phone, buffer, caption = '', mimetype = 'image/jpeg') {
    this._ensureConnected();
    const jid = this._formatJid(phone);

    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El número no tiene WhatsApp');

    const result = await this.sock.sendMessage(jid, { image: buffer, caption, mimetype });
    await new Promise(r => setTimeout(r, 500));

    const sent = {
      messageId: result.key.id, phone: this._cleanPhone(phone),
      jid, type: 'image', content: caption, mediaMime: mimetype, timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendDocument(phone, buffer, filename, mimetype = 'application/pdf', caption = '') {
    this._ensureConnected();
    const jid = this._formatJid(phone);

    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El número no tiene WhatsApp');

    const result = await this.sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype, caption });
    await new Promise(r => setTimeout(r, 500));

    const sent = {
      messageId: result.key.id, phone: this._cleanPhone(phone),
      jid, type: 'document', content: caption, mediaMime: mimetype,
      mediaFilename: filename, timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendAudio(phone, buffer) {
    this._ensureConnected();
    const jid = this._formatJid(phone);

    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El número no tiene WhatsApp');

    const result = await this.sock.sendMessage(jid, {
      audio: buffer,
      mimetype: 'audio/ogg; codecs=opus',   // Formato nativo de WhatsApp
      ptt: true,                              // Nota de voz (no archivo de audio)
    });
    await new Promise(r => setTimeout(r, 500));

    const sent = {
      messageId: result.key.id, phone: this._cleanPhone(phone),
      jid, type: 'audio', content: '', mediaMime: 'audio/ogg; codecs=opus',
      timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async checkNumber(phone) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [result] = await this.sock.onWhatsApp(jid);
    return result ? { exists: true, jid: result.jid } : { exists: false };
  }

  // ─── Media ───

  async _uploadMedia(buffer, parsed) {
    if (!this.sync.supabase) return null;

    try {
      const extMap = {
        'audio/ogg; codecs=opus': 'ogg', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/3gpp': '3gp',
        'application/pdf': 'pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      };
      const ext = extMap[parsed.mediaMime] || parsed.mediaFilename?.split('.').pop() || 'bin';
      const filename = `${parsed.type}_${Date.now()}.${ext}`;
      const storagePath = `entrante/${this.lineaId}/${filename}`;

      const { error: uploadError } = await this.sync.supabase.storage
        .from('reportia-eneache-wa-media')
        .upload(storagePath, buffer, {
          contentType: parsed.mediaMime || 'application/octet-stream',
          upsert: false,
        });

      if (uploadError) {
        console.error(`   ❌ Upload error: ${uploadError.message}`);
        return null;
      }

      const { data: urlData } = this.sync.supabase.storage
        .from('reportia-eneache-wa-media')
        .getPublicUrl(storagePath);

      console.log(`   📁 Media guardada: ${storagePath}`);
      return urlData.publicUrl;
    } catch (err) {
      console.error(`   ❌ Error en _uploadMedia: ${err.message}`);
      return null;
    }
  }

  // ─── Lifecycle ───

  async disconnect() {
    if (this.sock) {
      try { this.sock.end(); } catch (e) {}
      this.sock = null;
    }
    this.state.status = 'disconnected';
    this.state.qr = null;
    this._updateSupabaseStatus('disconnected');
  }

  async clearAndReconnect() {
    await this.disconnect();
    this._clearSession();
    await new Promise(r => setTimeout(r, 1000));
    await this.connect();
  }

  async destroy() {
    await this.disconnect();
    this._clearSession();
  }

  getStatus() {
    return { ...this.state, instanciaId: this.instanciaId, lineaId: this.lineaId };
  }

  // ─── Privados ───

  _ensureConnected() {
    if (!this.sock || this.state.status !== 'connected') {
      throw new Error(`Línea ${this.instanciaId} no está conectada`);
    }
  }

  _cleanPhone(phone) {
    return phone.replace(/\D/g, '');
  }

  _formatJid(phone) {
    let clean = phone.replace(/\D/g, '');
    // Paraguay: si empieza con 0, reemplazar por 595
    if (clean.startsWith('0')) clean = '595' + clean.slice(1);
    // Si es un número corto (sin código de país), agregar 595
    if (clean.length <= 10 && !clean.startsWith('595')) clean = '595' + clean;
    return `${clean}@s.whatsapp.net`;
  }

  _clearSession() {
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      console.log(`🗑️ [${this.instanciaId}] Sesión eliminada`);
    }
  }

  _parseMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    // Extraer y normalizar teléfono
    let phone = jid.split('@')[0].replace(/\D/g, '');
    // Normalizar Paraguay
    if (phone.length <= 10 && !phone.startsWith('595')) {
      phone = '595' + (phone.startsWith('0') ? phone.slice(1) : phone);
    }

    const pushName = msg.pushName || null;
    const m = msg.message;
    if (!m) return null;

    let type = 'text', content = '', mediaMime = null, mediaFilename = null;

    if (m.conversation) { type = 'text'; content = m.conversation; }
    else if (m.extendedTextMessage) { type = 'text'; content = m.extendedTextMessage.text; }
    else if (m.imageMessage) { type = 'image'; content = m.imageMessage.caption || ''; mediaMime = m.imageMessage.mimetype; }
    else if (m.documentMessage) { type = 'document'; content = m.documentMessage.caption || ''; mediaMime = m.documentMessage.mimetype; mediaFilename = m.documentMessage.fileName; }
    else if (m.audioMessage) { type = 'audio'; content = ''; mediaMime = m.audioMessage.mimetype || 'audio/ogg; codecs=opus'; }
    else if (m.videoMessage) { type = 'video'; content = m.videoMessage.caption || ''; mediaMime = m.videoMessage.mimetype; }
    else if (m.stickerMessage) { type = 'image'; content = '[Sticker]'; mediaMime = m.stickerMessage.mimetype; }
    else return null;

    return {
      messageId: msg.key.id, phone, jid, pushName, type, content,
      mediaMime, mediaFilename, mediaUrl: null,
      timestamp: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
    };
  }

  async _updateSupabaseStatus(status) {
    if (!this.sync.supabase) return;
    try {
      const update = { estado: status, ultimo_heartbeat: new Date().toISOString() };
      if (status === 'connected') {
        update.telefono = this.state.phoneNumber;
        update.push_name = this.state.pushName;
        update.conectado_desde = this.state.connectedAt;
      }
      await this.sync.supabase
        .from('reportia_eneache_wa_lineas')
        .update(update)
        .eq('id', this.lineaId);
    } catch (err) { /* silencioso */ }
  }
}

module.exports = { WhatsAppInstance };
