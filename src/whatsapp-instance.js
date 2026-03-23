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
    this.state = { status: 'disconnected', qr: null, phoneNumber: null, pushName: null, connectedAt: null };
  }

  async connect() {
    try {
      if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();
      this.sock = makeWASocket({
        version,
        auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, this.logger) },
        printQRInTerminal: false,
        logger: this.logger,
        browser: ['GIMSA ' + this.instanciaId, 'Chrome', '22.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
      });
      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          this.state.status = 'qr_pending';
          this.state.qr = await QRCode.toDataURL(qr);
          console.log('[' + this.instanciaId + '] QR generado');
          this._updateSupabaseStatus('qr_pending');
        }
        if (connection === 'open') {
          this.state.status = 'connected';
          this.state.qr = null;
          this.retryCount = 0;
          const user = this.sock.user;
          if (user) { this.state.phoneNumber = user.id.split(':')[0].split('@')[0]; this.state.pushName = user.name || null; }
          this.state.connectedAt = new Date().toISOString();
          console.log('[' + this.instanciaId + '] Conectado: +' + this.state.phoneNumber);
          this._updateSupabaseStatus('connected');
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          console.log('[' + this.instanciaId + '] Desconectado (codigo: ' + code + ')');
          if (code === DisconnectReason.loggedOut) {
            this.state = { status: 'disconnected', qr: null, phoneNumber: null, pushName: null, connectedAt: null };
            this._clearSession();
            this._updateSupabaseStatus('disconnected');
          } else if (shouldReconnect && this.retryCount < this.maxRetries) {
            this.state.status = 'reconnecting';
            this.retryCount++;
            const delay = Math.min(5000 * this.retryCount, 30000);
            console.log('[' + this.instanciaId + '] Reconectando en ' + (delay/1000) + 's (' + this.retryCount + '/' + this.maxRetries + ')');
            this._updateSupabaseStatus('reconnecting');
            setTimeout(() => this.connect(), delay);
          } else {
            this.state.status = 'disconnected';
            this._updateSupabaseStatus('disconnected');
          }
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          const jid = msg.key.remoteJid;
          if (!jid) continue;
          if (jid === 'status@broadcast') continue;
          if (jid.endsWith('@g.us')) continue;
          if (jid.endsWith('@newsletter')) continue;
          if (jid.includes('-')) continue;

          const parsed = this._parseMessage(msg);
          if (!parsed) continue;

          if (['image','audio','video','document'].includes(parsed.type)) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const url = await this._uploadMedia(buffer, parsed);
              if (url) parsed.mediaUrl = url;
            } catch (e) { console.error('[' + this.instanciaId + '] Error media: ' + e.message); }
          }

          if (msg.key.fromMe) {
            try { await this.sync.saveSentMessage({ ...parsed, respondidoPor: 'humano' }, this.lineaId); }
            catch (e) { if (!e.message?.includes('duplicate') && e.code !== '23505') console.error('[' + this.instanciaId + '] Error msg propio: ' + e.message); }
          } else {
            let profilePic = null;
            try { profilePic = await this.sock.profilePictureUrl(jid, 'image'); } catch(e) {}
            parsed.profilePic = profilePic;
            console.log('[' + this.instanciaId + '] Entrante +' + parsed.phone + ' (' + parsed.pushName + '): ' + (parsed.content || '[' + parsed.type + ']').substring(0,60));
            try {
              await this.sync.saveIncomingMessage(parsed, this.lineaId);
              console.log('[' + this.instanciaId + '] Guardado OK');
            } catch (e) { console.error('[' + this.instanciaId + '] Error guardando: ' + e.message); }
          }
        }
      });

      this.sock.ev.on('messages.update', (updates) => {
        for (const u of updates) {
          if (u.update?.status) {
            const map = { 2: 'sent', 3: 'delivered', 4: 'read' };
            if (map[u.update.status]) this.sync.updateMessageStatus(u.key.id, map[u.update.status]).catch(() => {});
          }
        }
      });
    } catch (err) { console.error('Error conectando [' + this.instanciaId + ']: ' + err.message); this.state.status = 'disconnected'; }
  }

  async sendText(phone, text) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El numero no tiene WhatsApp');
    const result = await this.sock.sendMessage(jid, { text });
    await new Promise(r => setTimeout(r, 500));
    const sent = { messageId: result.key.id, phone: this._clean(phone), jid, type: 'text', content: text, timestamp: new Date().toISOString() };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendImage(phone, buffer, caption, mimetype) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El numero no tiene WhatsApp');
    const result = await this.sock.sendMessage(jid, { image: buffer, caption: caption || '', mimetype: mimetype || 'image/jpeg' });
    await new Promise(r => setTimeout(r, 500));
    const sent = { messageId: result.key.id, phone: this._clean(phone), jid, type: 'image', content: caption || '', mediaMime: mimetype || 'image/jpeg', timestamp: new Date().toISOString() };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendDocument(phone, buffer, filename, mimetype, caption) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El numero no tiene WhatsApp');
    const result = await this.sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype: mimetype || 'application/pdf', caption: caption || '' });
    await new Promise(r => setTimeout(r, 500));
    const sent = { messageId: result.key.id, phone: this._clean(phone), jid, type: 'document', content: caption || '', mediaMime: mimetype, mediaFilename: filename, timestamp: new Date().toISOString() };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async sendAudio(phone, buffer) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [exists] = await this.sock.onWhatsApp(jid);
    if (!exists) throw new Error('El numero no tiene WhatsApp');
    const result = await this.sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    await new Promise(r => setTimeout(r, 500));
    const sent = { messageId: result.key.id, phone: this._clean(phone), jid, type: 'audio', content: '', mediaMime: 'audio/ogg; codecs=opus', timestamp: new Date().toISOString() };
    await this.sync.saveSentMessage(sent, this.lineaId).catch(e => console.error(e.message));
    return sent;
  }

  async checkNumber(phone) {
    this._ensureConnected();
    const jid = this._formatJid(phone);
    const [result] = await this.sock.onWhatsApp(jid);
    return result ? { exists: true, jid: result.jid } : { exists: false };
  }

  async _uploadMedia(buffer, parsed) {
    if (!this.sync.supabase) return null;
    try {
      const extMap = { 'audio/ogg; codecs=opus':'ogg','audio/ogg':'ogg','audio/webm':'webm','image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','application/pdf':'pdf' };
      const ext = extMap[parsed.mediaMime] || parsed.mediaFilename?.split('.').pop() || 'bin';
      const path = 'entrante/' + this.lineaId + '/' + parsed.type + '_' + Date.now() + '.' + ext;
      const { error } = await this.sync.supabase.storage.from('reportia-eneache-wa-media').upload(path, buffer, { contentType: parsed.mediaMime || 'application/octet-stream', upsert: false });
      if (error) { console.error('Upload error: ' + error.message); return null; }
      const { data } = this.sync.supabase.storage.from('reportia-eneache-wa-media').getPublicUrl(path);
      return data.publicUrl;
    } catch (e) { console.error('Media error: ' + e.message); return null; }
  }

  async disconnect() { if (this.sock) { try { this.sock.end(); } catch(e) {} this.sock = null; } this.state.status = 'disconnected'; this.state.qr = null; this._updateSupabaseStatus('disconnected'); }
  async clearAndReconnect() { await this.disconnect(); this._clearSession(); await new Promise(r => setTimeout(r, 1000)); await this.connect(); }
  async destroy() { await this.disconnect(); this._clearSession(); }
  getStatus() { return { ...this.state, instanciaId: this.instanciaId, lineaId: this.lineaId }; }

  _ensureConnected() { if (!this.sock || this.state.status !== 'connected') throw new Error('Linea no conectada'); }
  _clean(p) { return p.replace(/\D/g, ''); }
  _formatJid(phone) {
    let c = phone.replace(/\D/g, '');
    if (c.startsWith('0')) c = '595' + c.slice(1);
    if (c.length <= 10 && !c.startsWith('595')) c = '595' + c;
    return c + '@s.whatsapp.net';
  }
  _clearSession() { if (fs.existsSync(this.authDir)) { fs.rmSync(this.authDir, { recursive: true, force: true }); } }

  _parseMessage(msg) {
    const jid = msg.key.remoteJid;
    if (!jid) return null;
    let phone = jid.split('@')[0].replace(/\D/g, '');
    if (phone.length <= 10 && !phone.startsWith('595')) phone = '595' + (phone.startsWith('0') ? phone.slice(1) : phone);
    const pushName = msg.pushName || null;
    const m = msg.message;
    if (!m) return null;
    let type='text', content='', mediaMime=null, mediaFilename=null;
    if (m.conversation) { content = m.conversation; }
    else if (m.extendedTextMessage) { content = m.extendedTextMessage.text; }
    else if (m.imageMessage) { type='image'; content = m.imageMessage.caption||''; mediaMime = m.imageMessage.mimetype; }
    else if (m.documentMessage) { type='document'; content = m.documentMessage.caption||''; mediaMime = m.documentMessage.mimetype; mediaFilename = m.documentMessage.fileName; }
    else if (m.audioMessage) { type='audio'; mediaMime = m.audioMessage.mimetype||'audio/ogg; codecs=opus'; }
    else if (m.videoMessage) { type='video'; content = m.videoMessage.caption||''; mediaMime = m.videoMessage.mimetype; }
    else if (m.stickerMessage) { type='image'; content='[Sticker]'; mediaMime = m.stickerMessage.mimetype; }
    else return null;
    return { messageId: msg.key.id, phone, jid, pushName, type, content, mediaMime, mediaFilename, mediaUrl: null,
      timestamp: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp)*1000).toISOString() : new Date().toISOString() };
  }

  async _updateSupabaseStatus(status) {
    if (!this.sync.supabase) return;
    try {
      const u = { estado: status, ultimo_heartbeat: new Date().toISOString() };
      if (status === 'connected') { u.telefono = this.state.phoneNumber; u.push_name = this.state.pushName; u.conectado_desde = this.state.connectedAt; }
      await this.sync.supabase.from('reportia_eneache_wa_lineas').update(u).eq('id', this.lineaId);
    } catch(e) {}
  }
}

module.exports = { WhatsAppInstance };
