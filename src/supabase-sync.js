/**
 * Supabase Sync — v2.2 NOMBRES CORREGIDOS
 * 
 * Columnas exactas de Supabase:
 * 
 * reportia_eneache_wa_conversations:
 *   id, wa_contact_id, phone, name, profile_pic_url, status,
 *   window_open, window_expires_at, unread_count, last_message_at,
 *   last_message_preview, assigned_to, opportunity_id, tags, metadata,
 *   created_at, updated_at, linea_id, tipo_conexion, avatar_url
 *
 * reportia_eneache_wa_messages:
 *   id, conversation_id, wa_message_id, direction, message_type,
 *   content, media_url, media_mime_type, template_name, template_params,
 *   sent_by, sent_by_user_id, status, error_message, ai_confidence,
 *   metadata, created_at, linea_id
 *
 * reportia_eneache_wa_lineas:
 *   id, nombre, descripcion, telefono, push_name, estado, color,
 *   avatar_emoji, instancia_id, conectado_desde, ultimo_heartbeat,
 *   orden, activa, created_at, updated_at
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

  /**
   * Buscar o crear conversación
   */
  async getOrCreateConversation(phone, pushName, lineaId, profilePic) {
    if (!this.supabase) return { id: null };

    // Buscar existente
    const { data: existing } = await this.supabase
      .from('reportia_eneache_wa_conversations')
      .select('*')
      .eq('phone', phone)
      .eq('linea_id', lineaId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      const updateData = {
        last_message_at: new Date().toISOString(),
        window_open: true,
        window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (pushName) updateData.name = pushName;
      if (profilePic) {
        updateData.profile_pic_url = profilePic;
        updateData.avatar_url = profilePic;
      }

      await this.supabase
        .from('reportia_eneache_wa_conversations')
        .update(updateData)
        .eq('id', existing.id);
      return existing;
    }

    // Crear nueva
    const { data: created, error } = await this.supabase
      .from('reportia_eneache_wa_conversations')
      .insert({
        wa_contact_id: phone,
        phone: phone,
        name: pushName || null,
        profile_pic_url: profilePic || null,
        avatar_url: profilePic || null,
        status: 'active',
        window_open: true,
        window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        unread_count: 1,
        last_message_at: new Date().toISOString(),
        linea_id: lineaId,
        tipo_conexion: 'qr',
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error creando conversación:', error.message, error.details, error.hint);
      throw error;
    }
    console.log(`💬 Nueva conversación: +${phone} (${pushName}) en línea ${lineaId}`);
    return created;
  }

  /**
   * Guardar mensaje entrante
   */
  async saveIncomingMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(
      msg.phone, msg.pushName, lineaId, msg.profilePic
    );

    // Actualizar unread_count y preview
    await this.supabase
      .from('reportia_eneache_wa_conversations')
      .update({
        unread_count: (conversation.unread_count || 0) + 1,
        last_message_preview: msg.content?.substring(0, 100) || `[${msg.type}]`,
        last_message_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_messages')
      .insert({
        conversation_id: conversation.id,
        linea_id: lineaId,
        wa_message_id: msg.messageId,
        direction: 'inbound',
        message_type: msg.type,
        content: msg.content || null,
        media_url: msg.mediaUrl || null,
        media_mime_type: msg.mediaMime || null,
        sent_by: 'contact',
        status: 'received',
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Error guardando mensaje entrante:', error.message, error.details, error.hint);
      throw error;
    }
    return { message: data, conversation };
  }

  /**
   * Guardar mensaje saliente
   */
  async saveSentMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, null, lineaId, null);

    // Actualizar preview
    await this.supabase
      .from('reportia_eneache_wa_conversations')
      .update({
        last_message_preview: msg.content?.substring(0, 100) || `[${msg.type}]`,
        last_message_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_messages')
      .insert({
        conversation_id: conversation.id,
        linea_id: lineaId,
        wa_message_id: msg.messageId,
        direction: 'outbound',
        message_type: msg.type,
        content: msg.content || null,
        media_url: msg.mediaUrl || null,
        media_mime_type: msg.mediaMime || null,
        sent_by: msg.respondidoPor || 'agent',
        status: 'sent',
      })
      .select()
      .single();

    if (error) {
      // Ignorar duplicados silenciosamente
      if (error.code === '23505' || error.message?.includes('duplicate')) {
        return null;
      }
      console.error('❌ Error guardando mensaje saliente:', error.message, error.details, error.hint);
      throw error;
    }
    return data;
  }

  /**
   * Actualizar status de mensaje
   */
  async updateMessageStatus(messageId, status) {
    if (!this.supabase) return;
    await this.supabase
      .from('reportia_eneache_wa_messages')
      .update({ status })
      .eq('wa_message_id', messageId);
  }

  /**
   * Actualizar estado de línea
   */
  async updateLineaStatus(lineaId, status) {
    if (!this.supabase) return;
    await this.supabase
      .from('reportia_eneache_wa_lineas')
      .update({ estado: status, ultimo_heartbeat: new Date().toISOString() })
      .eq('id', lineaId);
  }

  /**
   * Obtener conversaciones
   */
  async getConversations(lineaId, limit = 50) {
    if (!this.supabase) return [];
    let query = this.supabase
      .from('reportia_eneache_wa_conversations')
      .select('*')
      .eq('tipo_conexion', 'qr')
      .in('status', ['active', 'open'])
      .order('last_message_at', { ascending: false })
      .limit(limit);

    if (lineaId) query = query.eq('linea_id', lineaId);

    const { data, error } = await query;
    if (error) console.error('Error obteniendo conversaciones:', error.message);
    return data || [];
  }

  /**
   * Obtener mensajes de una conversación
   */
  async getMessages(conversationId, limit = 100) {
    if (!this.supabase) return [];
    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) console.error('Error obteniendo mensajes:', error.message);
    return data || [];
  }
}

module.exports = { SupabaseSync };
