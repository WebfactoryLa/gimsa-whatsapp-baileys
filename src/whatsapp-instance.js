/**
 * WhatsApp Instance
 * 
 * Una instancia individual de Baileys para un número de teléfono.
 * Cada línea tiene su propia instancia.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
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
        markOnlineOnConnect: false,
      });

      this.sock.ev.on('creds.update', saveCreds);

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

          console.log(`✅ [${this.instanciaId}] Conectado: +${this.state.phoneNumber}`);
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

      // Mensajes entrantes
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === 'status@broadcast') continue;

          const parsed = this._parseMessage(msg);
          if (parsed) {
            console.log(`📩 [${this.instanciaId}] +${parsed.phone}: ${parsed.preview || parsed.content?.substring(0, 50)}`);
            try {
              await this.sync.saveIncomingMessage(parsed, this.lineaId);
            } catch (err) {
              console.error(`Error guardando mensaje [${this.instanciaId}]:`, err.message);
            }
          }
        }
      });

      // Status updates
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
    const result = await this.sock.sendMessage(jid, { text });

    const sent = {
      messageId: result.key.id, phone: phone.replace(/\D/g, ''),
      jid, type: 'text', content: text, timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendImage(phone, buffer, caption = '', mimetype = 'image/jpeg') {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const result = await this.sock.sendMessage(jid, { image: buffer, caption, mimetype });

    const sent = {
      messageId: result.key.id, phone: phone.replace(/\D/g, ''),
      jid, type: 'image', content: caption, mediaMime: mimetype, timestamp: new Date().toISOString(),
    };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendDocument(phone, buffer, filename, mimetype = 'application/pdf', caption = '') {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const result = await this.sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype, caption });

    const sent = {
      messageId: result.key.id, phone: phone.replace(/\D/g, ''),
      jid, type: 'document', content: caption, mediaMime: mimetype,
      mediaFilename: filename, timestamp: new Date().toISOString(),
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

  _formatJid(phone) {
    const clean = phone.replace(/\D/g, '');
    const formatted = clean.startsWith('0') ? '595' + clean.slice(1) : clean;
    return `${formatted}@s.whatsapp.net`;
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

    const phone = jid.split('@')[0];
    const pushName = msg.pushName || null;
    const m = msg.message;
    if (!m) return null;

    let type = 'text', content = '', mediaMime = null, mediaFilename = null;

    if (m.conversation) { type = 'text'; content = m.conversation; }
    else if (m.extendedTextMessage) { type = 'text'; content = m.extendedTextMessage.text; }
    else if (m.imageMessage) { type = 'image'; content = m.imageMessage.caption || ''; mediaMime = m.imageMessage.mimetype; }
    else if (m.documentMessage) { type = 'document'; content = m.documentMessage.caption || ''; mediaMime = m.documentMessage.mimetype; mediaFilename = m.documentMessage.fileName; }
    else if (m.audioMessage) { type = 'audio'; mediaMime = m.audioMessage.mimetype; }
    else if (m.videoMessage) { type = 'video'; content = m.videoMessage.caption || ''; mediaMime = m.videoMessage.mimetype; }
    else return null;

    return {
      messageId: msg.key.id, phone, jid, pushName, type, content,
      mediaMime, mediaFilename,
      timestamp: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
    };
  }

  async _updateSupabaseStatus(status) {
    if (!this.sync.supabase) return;
    try {
      const update = {
        estado: status,
        ultimo_heartbeat: new Date().toISOString(),
      };
      if (status === 'connected') {
        update.telefono = this.state.phoneNumber;
        update.push_name = this.state.pushName;
        update.conectado_desde = this.state.connectedAt;
      }
      await this.sync.supabase
        .from('reportia_eneache_wa_lineas')
        .update(update)
        .eq('id', this.lineaId);
    } catch (err) {
      // Silencioso
    }
  }
}

module.exports = { WhatsAppInstance };
