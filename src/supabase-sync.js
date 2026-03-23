const { createClient } = require('@supabase/supabase-js');

class SupabaseSync {
  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      console.warn('⚠️  SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas.');
      console.warn('⚠️  El servicio arranca sin Supabase. Solo WhatsApp funciona.');
      console.warn('⚠️  Variables actuales:', {
        SUPABASE_URL: url ? 'configurada' : 'FALTA',
        SUPABASE_SERVICE_KEY: key ? 'configurada' : 'FALTA',
      });
      this.supabase = null;
      return;
    }

    this.supabase = createClient(url, key);
    console.log('✅ Supabase conectado');
  }

  async getOrCreateConversation(phone, pushName) {
    if (!this.supabase) return { id: null };

    const { data: existing } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('telefono', phone)
      .eq('estado', 'activa')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      await this.supabase
        .from('reportia_eneache_wa_conversaciones')
        .update({
          ventana_abierta_hasta: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          ultimo_mensaje_at: new Date().toISOString(),
          nombre_push: pushName || existing.nombre_push,
        })
        .eq('id', existing.id);
      return existing;
    }

    const { data: created, error } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .insert({
        wa_contact_id: phone,
        telefono: phone,
        nombre_contacto: pushName,
        nombre_push: pushName,
        estado: 'activa',
        ventana_abierta_hasta: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ultimo_mensaje_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`💬 Nueva conversación: +${phone} (${pushName})`);
    return created;
  }

  async saveIncomingMessage(msg) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, msg.pushName);
    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .insert({
        conversacion_id: conversation.id,
        wa_message_id: msg.messageId,
        direccion: 'entrante',
        tipo: msg.type,
        contenido: msg.content,
        media_url: msg.mediaUrl,
        media_mime: msg.mediaMime,
        media_filename: msg.mediaFilename,
        status: 'received',
        respondido_por: null,
      })
      .select()
      .single();
    if (error) throw error;
    return { message: data, conversation };
  }

  async saveSentMessage(msg) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, null);
    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .insert({
        conversacion_id: conversation.id,
        wa_message_id: msg.messageId,
        direccion: 'saliente',
        tipo: msg.type,
        contenido: msg.content,
        media_url: msg.mediaUrl || null,
        media_mime: msg.mediaMime || null,
        media_filename: msg.mediaFilename || null,
        status: 'sent',
        respondido_por: msg.respondidoPor || 'humano',
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async updateMessageStatus(update) {
    if (!this.supabase) return;
    await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .update({ status: update.status })
      .eq('wa_message_id', update.messageId);
  }

  async getConversations(limit = 50) {
    if (!this.supabase) return [];
    const { data } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('estado', 'activa')
      .order('ultimo_mensaje_at', { ascending: false })
      .limit(limit);
    return data || [];
  }

  async getMessages(conversationId, limit = 100) {
    if (!this.supabase) return [];
    const { data } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .select('*')
      .eq('conversacion_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);
    return data || [];
  }

  async createOpportunityFromChat(conversationId, data) {
    if (!this.supabase) throw new Error('Supabase no configurado');
    const { data: opp, error } = await this.supabase
      .from('reportia_eneache_oportunidades')
      .insert({
        comercial_id: null,
        empresa: data.empresa || 'Sin nombre (WhatsApp)',
        contacto_nombre: data.contacto_nombre || null,
        cantidad_uniformes: data.cantidad_uniformes || 0,
        etapa: 'contacto_inicial',
        origen: 'entrante',
        fecha_primer_contacto: new Date().toISOString().split('T')[0],
        fecha_ultimo_contacto: new Date().toISOString().split('T')[0],
        notas: `[WhatsApp] ${data.notas || 'Lead desde WhatsApp'}`,
        activa: true,
      })
      .select()
      .single();
    if (error) throw error;
    if (conversationId) {
      await this.supabase
        .from('reportia_eneache_wa_conversaciones')
        .update({ oportunidad_id: opp.id })
        .eq('id', conversationId);
    }
    return opp;
  }
}

module.exports = { SupabaseSync };
