/**
 * WhatsApp Manager
 * 
 * Maneja la conexión con WhatsApp vía Baileys.
 * Genera QR, mantiene sesión, envía/recibe mensajes.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, 
        fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { EventEmitter } = require('events');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const AUTH_DIR = path.join(__dirname, '..', 'auth', 'session');

class WhatsAppManager extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
    this.sock = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.logger = pino({ level: 'silent' }); // silenciar logs de Baileys
  }

  async connect() {
    try {
      // Crear directorio de auth si no existe
      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.logger),
        },
        printQRInTerminal: true, // también muestra QR en la terminal
        logger: this.logger,
        browser: ['GIMSA Comercial', 'Chrome', '22.0'],
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
      });

      // ─── Evento: Credenciales actualizadas ───
      this.sock.ev.on('creds.update', saveCreds);

      // ─── Evento: Conexión ───
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR generado
        if (qr) {
          this.state.status = 'qr_pending';
          this.state.qr = await QRCode.toDataURL(qr);
          console.log('📱 QR generado. Escaneá con WhatsApp.');
          this.emit('qr', this.state.qr);
        }

        // Conexión abierta
        if (connection === 'open') {
          this.state.status = 'connected';
          this.state.qr = null;
          this.retryCount = 0;
          
          // Obtener info del número conectado
          const user = this.sock.user;
          if (user) {
            this.state.phoneNumber = user.id.split(':')[0].split('@')[0];
            this.state.pushName = user.name || null;
          }
          this.state.connectedAt = new Date().toISOString();
          
          console.log(`✅ WhatsApp conectado: +${this.state.phoneNumber} (${this.state.pushName})`);
          this.emit('connected', { phone: this.state.phoneNumber, name: this.state.pushName });
        }

        // Conexión cerrada
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`❌ Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

          if (statusCode === DisconnectReason.loggedOut) {
            // Sesión cerrada desde el teléfono → limpiar auth y pedir QR nuevo
            this.state.status = 'disconnected';
            this.state.qr = null;
            this.state.phoneNumber = null;
            this.state.pushName = null;
            this.clearSession();
            console.log('🔴 Sesión cerrada desde el teléfono. Se requiere nuevo escaneo QR.');
            this.emit('logged_out');
          } else if (shouldReconnect && this.retryCount < this.maxRetries) {
            // Intentar reconectar
            this.state.status = 'reconnecting';
            this.retryCount++;
            const delay = Math.min(5000 * this.retryCount, 30000);
            console.log(`🔄 Reconectando en ${delay / 1000}s... (intento ${this.retryCount}/${this.maxRetries})`);
            setTimeout(() => this.connect(), delay);
          } else {
            this.state.status = 'disconnected';
            console.log('🔴 No se pudo reconectar. Se requiere nuevo escaneo QR.');
          }
        }
      });

      // ─── Evento: Mensajes entrantes ───
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          // Ignorar mensajes propios y de status/broadcast
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === 'status@broadcast') continue;

          const parsed = this.parseMessage(msg);
          if (parsed) {
            console.log(`📩 Mensaje de +${parsed.phone}: ${parsed.preview}`);
            this.emit('message:received', parsed);
          }
        }
      });

      // ─── Evento: Status de mensajes (enviado, entregado, leído) ───
      this.sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
          if (update.update?.status) {
            const statusMap = { 2: 'sent', 3: 'delivered', 4: 'read' };
            const statusName = statusMap[update.update.status];
            if (statusName) {
              this.emit('message:status', {
                messageId: update.key.id,
                remoteJid: update.key.remoteJid,
                status: statusName,
              });
            }
          }
        }
      });

    } catch (err) {
      console.error('Error conectando WhatsApp:', err);
      this.state.status = 'disconnected';
    }
  }

  /**
   * Parsear mensaje de Baileys a formato limpio
   */
  parseMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    const phone = jid.split('@')[0];
    const pushName = msg.pushName || null;
    let type = 'text';
    let content = '';
    let mediaUrl = null;
    let mediaMime = null;
    let mediaFilename = null;

    const m = msg.message;
    if (!m) return null;

    if (m.conversation) {
      type = 'text';
      content = m.conversation;
    } else if (m.extendedTextMessage) {
      type = 'text';
      content = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
      type = 'image';
      content = m.imageMessage.caption || '';
      mediaMime = m.imageMessage.mimetype;
    } else if (m.documentMessage) {
      type = 'document';
      content = m.documentMessage.caption || '';
      mediaMime = m.documentMessage.mimetype;
      mediaFilename = m.documentMessage.fileName;
    } else if (m.audioMessage) {
      type = 'audio';
      mediaMime = m.audioMessage.mimetype;
    } else if (m.videoMessage) {
      type = 'video';
      content = m.videoMessage.caption || '';
      mediaMime = m.videoMessage.mimetype;
    } else {
      // Tipo no soportado por ahora
      return null;
    }

    return {
      messageId: msg.key.id,
      phone,
      jid,
      pushName,
      type,
      content,
      mediaUrl,
      mediaMime,
      mediaFilename,
      timestamp: msg.messageTimestamp 
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString(),
      rawMessage: msg, // para descargar media después
    };
  }

  /**
   * Enviar mensaje de texto
   */
  async sendText(phone, text) {
    if (!this.sock || this.state.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const jid = this.formatJid(phone);
    const result = await this.sock.sendMessage(jid, { text });
    
    const sent = {
      messageId: result.key.id,
      phone: phone.replace(/\D/g, ''),
      jid,
      type: 'text',
      content: text,
      timestamp: new Date().toISOString(),
    };

    this.emit('message:sent', sent);
    return sent;
  }

  /**
   * Enviar imagen
   */
  async sendImage(phone, imageBuffer, caption = '', mimetype = 'image/jpeg') {
    if (!this.sock || this.state.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const jid = this.formatJid(phone);
    const result = await this.sock.sendMessage(jid, {
      image: imageBuffer,
      caption,
      mimetype,
    });

    const sent = {
      messageId: result.key.id,
      phone: phone.replace(/\D/g, ''),
      jid,
      type: 'image',
      content: caption,
      mediaMime: mimetype,
      timestamp: new Date().toISOString(),
    };

    this.emit('message:sent', sent);
    return sent;
  }

  /**
   * Enviar documento
   */
  async sendDocument(phone, docBuffer, filename, mimetype, caption = '') {
    if (!this.sock || this.state.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }

    const jid = this.formatJid(phone);
    const result = await this.sock.sendMessage(jid, {
      document: docBuffer,
      fileName: filename,
      mimetype,
      caption,
    });

    const sent = {
      messageId: result.key.id,
      phone: phone.replace(/\D/g, ''),
      jid,
      type: 'document',
      content: caption,
      mediaMime: mimetype,
      mediaFilename: filename,
      timestamp: new Date().toISOString(),
    };

    this.emit('message:sent', sent);
    return sent;
  }

  /**
   * Descargar media de un mensaje entrante
   */
  async downloadMedia(rawMessage) {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
    return buffer;
  }

  /**
   * Formatear número a JID de WhatsApp
   */
  formatJid(phone) {
    const clean = phone.replace(/\D/g, '');
    // Paraguay: si empieza con 0, reemplazar por 595
    const formatted = clean.startsWith('0') ? '595' + clean.slice(1) : clean;
    return `${formatted}@s.whatsapp.net`;
  }

  /**
   * Desconectar
   */
  async disconnect() {
    if (this.sock) {
      await this.sock.logout();
      this.clearSession();
      this.state.status = 'disconnected';
      this.state.qr = null;
      this.state.phoneNumber = null;
      this.state.pushName = null;
    }
  }

  /**
   * Limpiar sesión guardada
   */
  clearSession() {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️ Sesión eliminada');
    }
  }

  /**
   * Verificar si un número tiene WhatsApp
   */
  async checkNumber(phone) {
    if (!this.sock || this.state.status !== 'connected') {
      throw new Error('WhatsApp no está conectado');
    }
    const jid = this.formatJid(phone);
    const [result] = await this.sock.onWhatsApp(jid);
    return result ? { exists: true, jid: result.jid } : { exists: false };
  }
}

module.exports = { WhatsAppManager };
