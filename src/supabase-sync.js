/**
 * Supabase Sync
 * 
 * Sincroniza mensajes, conversaciones y leads con las tablas
 * reportia_eneache_* en Supabase.
 */

const { createClient } = require('@supabase/supabase-js');

class SupabaseSync {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }

  /**
   * Buscar o crear conversación para un número de teléfono
   */
  async getOrCreateConversation(phone, pushName) {
    // Buscar existente
    const { data: existing } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('telefono', phone)
      .eq('estado', 'activa')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      // Actualizar ventana de 24hs y último mensaje
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

    // Crear nueva
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
    console.log(`💬 Nueva conversación creada: +${phone} (${pushName})`);
    return created;
  }

  /**
   * Guardar mensaje entrante
   */
  async saveIncomingMessage(msg) {
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

  /**
   * Guardar mensaje saliente
   */
  async saveSentMessage(msg) {
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

  /**
   * Actualizar status de mensaje (sent → delivered → read)
   */
  async updateMessageStatus(update) {
    const { error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .update({ status: update.status })
      .eq('wa_message_id', update.messageId);

    if (error) console.error('Error actualizando status:', error.message);
  }

  /**
   * Obtener conversaciones activas
   */
  async getConversations(limit = 50) {
    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .select('*')
      .eq('estado', 'activa')
      .order('ultimo_mensaje_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  /**
   * Obtener mensajes de una conversación
   */
  async getMessages(conversationId, limit = 100) {
    const { data, error } = await this.supabase
      .from('reportia_eneache_wa_mensajes')
      .select('*')
      .eq('conversacion_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  /**
   * Crear oportunidad en el pipeline desde WhatsApp
   */
  async createOpportunityFromChat(conversationId, data) {
    const { data: opp, error } = await this.supabase
      .from('reportia_eneache_oportunidades')
      .insert({
        comercial_id: null, // sin asignar, va al módulo de Asignación
        empresa: data.empresa || 'Sin nombre (WhatsApp)',
        contacto_nombre: data.contacto_nombre || null,
        contacto_cargo: data.contacto_cargo || null,
        cantidad_uniformes: data.cantidad_uniformes || 0,
        etapa: 'contacto_inicial',
        origen: 'entrante',
        fecha_primer_contacto: new Date().toISOString().split('T')[0],
        fecha_ultimo_contacto: new Date().toISOString().split('T')[0],
        notas: `[WhatsApp] ${data.notas || 'Lead generado desde conversación de WhatsApp'}`,
        activa: true,
      })
      .select()
      .single();

    if (error) throw error;

    // Vincular conversación con la oportunidad
    await this.supabase
      .from('reportia_eneache_wa_conversaciones')
      .update({ oportunidad_id: opp.id })
      .eq('id', conversationId);

    console.log(`🎯 Oportunidad creada desde WhatsApp: ${data.empresa} (${data.cantidad_uniformes} uniformes)`);
    return opp;
  }
}

module.exports = { SupabaseSync };
