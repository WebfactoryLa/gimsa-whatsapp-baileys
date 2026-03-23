/**
 * Supabase Sync — v2.1 FIXES
 * 
 * Fixes:
 * - Guardar foto de perfil (avatar_url)
 * - Guardar media_url en mensajes
 * - Normalización de teléfonos
 */

const { createClient } = require('@supabase/supabase-js');

class SupabaseSync {
  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
      console.warn('⚠️  SUPABASE_URL o SUPABASE_SERVICE_KEY no configuradas.');
      this.supabase = null;
      return;
    }

    this.supabase = createClient(url, key);
    console.log('✅ Supabase conectado');
  }

  async getOrCreateConversation(phone, pushName, lineaId, profilePic) {
    if (!this.supabase) return { id: null };

    const { data: existing } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('telefono', phone)
      .eq('linea_id', lineaId)
      .eq('estado', 'activa')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      const updateData = {
        ventana_abierta_hasta: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ultimo_mensaje_at: new Date().toISOString(),
      };
      if (pushName) {
        updateData.nombre_push = pushName;
        updateData.nombre_contacto = pushName;
      }
      if (profilePic) {
        updateData.avatar_url = profilePic;
      }

      await this.supabase
        .from('reportia_eneache_wa_conversaciones')
        .update(updateData)
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
        avatar_url: profilePic || null,
        linea_id: lineaId,
        tipo_conexion: 'qr',
        estado: 'activa',
        ventana_abierta_hasta: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ultimo_mensaje_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`💬 Nueva conversación: +${phone} (${pushName}) en línea ${lineaId}`);
    return created;
  }

  async saveIncomingMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(
      msg.phone, msg.pushName, lineaId, msg.profilePic
    );

    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .insert({
        conversacion_id: conversation.id,
        linea_id: lineaId,
        wa_message_id: msg.messageId,
        direccion: 'entrante',
        tipo: msg.type,
        contenido: msg.content,
        media_url: msg.mediaUrl || null,
        media_mime: msg.mediaMime,
        media_filename: msg.mediaFilename,
        status: 'received',
      })
      .select()
      .single();

    if (error) throw error;
    return { message: data, conversation };
  }

  async saveSentMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, null, lineaId, null);

    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .insert({
        conversacion_id: conversation.id,
        linea_id: lineaId,
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

  async updateMessageStatus(messageId, status) {
    if (!this.supabase) return;
    await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .update({ status })
      .eq('wa_message_id', messageId);
  }

  async updateLineaStatus(lineaId, status) {
    if (!this.supabase) return;
    await this.supabase
      .from('reportia_eneache_wa_lineas')
      .update({ estado: status, ultimo_heartbeat: new Date().toISOString() })
      .eq('id', lineaId);
  }

  async getConversations(lineaId, limit = 50) {
    if (!this.supabase) return [];
    let query = this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('tipo_conexion', 'qr')
      .eq('estado', 'activa')
      .order('ultimo_mensaje_at', { ascending: false })
      .limit(limit);

    if (lineaId) query = query.eq('linea_id', lineaId);

    const { data } = await query;
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
}

module.exports = { SupabaseSync };
