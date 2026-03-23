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
        window_expires_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (pushName) updateData.name = pushName;
      if (profilePic) { updateData.profile_pic_url = profilePic; updateData.avatar_url = profilePic; }
      await this.supabase.from('reportia_eneache_wa_conversations').update(updateData).eq('id', existing.id);
      return existing;
    }
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
        window_expires_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
        unread_count: 1,
        last_message_at: new Date().toISOString(),
        linea_id: lineaId,
        tipo_conexion: 'qr',
      })
      .select()
      .single();
    if (error) { console.error('❌ Error creando conversacion:', error.message, error.details); throw error; }
    console.log('💬 Nueva conversacion: +' + phone + ' (' + pushName + ') linea ' + lineaId);
    return created;
  }

  async saveIncomingMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, msg.pushName, lineaId, msg.profilePic);
    await this.supabase.from('reportia_eneache_wa_conversations').update({
      unread_count: (conversation.unread_count || 0) + 1,
      last_message_preview: (msg.content || '').substring(0, 100) || '[' + msg.type + ']',
      last_message_at: new Date().toISOString(),
    }).eq('id', conversation.id);
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
    if (error) { console.error('❌ Error msg entrante:', error.message, error.details); throw error; }
    return { message: data, conversation };
  }

  async saveSentMessage(msg, lineaId) {
    if (!this.supabase) return null;
    const conversation = await this.getOrCreateConversation(msg.phone, null, lineaId, null);
    await this.supabase.from('reportia_eneache_wa_conversations').update({
      last_message_preview: (msg.content || '').substring(0, 100) || '[' + msg.type + ']',
      last_message_at: new Date().toISOString(),
    }).eq('id', conversation.id);
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
      if (error.code === '23505') return null;
      console.error('❌ Error msg saliente:', error.message, error.details);
      throw error;
    }
    return data;
  }

  async updateMessageStatus(messageId, status) {
    if (!this.supabase) return;
    await this.supabase.from('reportia_eneache_wa_messages').update({ status }).eq('wa_message_id', messageId);
  }

  async updateLineaStatus(lineaId, status) {
    if (!this.supabase) return;
    await this.supabase.from('reportia_eneache_wa_lineas').update({ estado: status, ultimo_heartbeat: new Date().toISOString() }).eq('id', lineaId);
  }

  async getConversations(lineaId, limit) {
    if (!this.supabase) return [];
    let q = this.supabase.from('reportia_eneache_wa_conversations').select('*').eq('tipo_conexion', 'qr').in('status', ['active','open']).order('last_message_at', { ascending: false }).limit(limit || 50);
    if (lineaId) q = q.eq('linea_id', lineaId);
    const { data } = await q;
    return data || [];
  }

  async getMessages(conversationId, limit) {
    if (!this.supabase) return [];
    const { data } = await this.supabase.from('reportia_eneache_wa_messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(limit || 100);
    return data || [];
  }
}

module.exports = { SupabaseSync };
