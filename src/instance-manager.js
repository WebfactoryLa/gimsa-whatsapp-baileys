/**
 * Instance Manager
 * 
 * Maneja múltiples instancias de WhatsApp (Baileys).
 * Cada línea tiene su propia instancia con sesión independiente.
 */

const { WhatsAppInstance } = require('./whatsapp-instance');
const path = require('path');
const fs = require('fs');

const AUTH_BASE = path.join(__dirname, '..', 'auth');

class InstanceManager {
  constructor(sync) {
    this.instances = new Map(); // instancia_id → WhatsAppInstance
    this.sync = sync;
  }

  /**
   * Crear una nueva instancia para una línea
   */
  async create(lineaId, instanciaId) {
    if (this.instances.has(instanciaId)) {
      return this.instances.get(instanciaId);
    }

    const authDir = path.join(AUTH_BASE, `session_${instanciaId}`);
    const instance = new WhatsAppInstance(instanciaId, lineaId, authDir, this.sync);
    this.instances.set(instanciaId, instance);

    console.log(`📱 Instancia creada: ${instanciaId} (línea: ${lineaId})`);
    return instance;
  }

  /**
   * Conectar una línea (genera QR)
   */
  async connect(instanciaId) {
    const instance = this.instances.get(instanciaId);
    if (!instance) throw new Error(`Instancia ${instanciaId} no encontrada`);
    
    await instance.connect();
    return instance;
  }

  /**
   * Desconectar una línea (mantiene sesión)
   */
  async disconnect(instanciaId) {
    const instance = this.instances.get(instanciaId);
    if (!instance) throw new Error(`Instancia ${instanciaId} no encontrada`);
    
    await instance.disconnect();
  }

  /**
   * Desconectar y limpiar sesión (requiere nuevo QR)
   */
  async reconnect(instanciaId) {
    const instance = this.instances.get(instanciaId);
    if (!instance) throw new Error(`Instancia ${instanciaId} no encontrada`);
    
    await instance.clearAndReconnect();
  }

  /**
   * Eliminar una instancia completamente
   */
  async remove(instanciaId) {
    const instance = this.instances.get(instanciaId);
    if (instance) {
      await instance.destroy();
      this.instances.delete(instanciaId);
    }
    console.log(`🗑️ Instancia eliminada: ${instanciaId}`);
  }

  /**
   * Obtener instancia por instancia_id
   */
  get(instanciaId) {
    return this.instances.get(instanciaId);
  }

  /**
   * Obtener estado de todas las instancias
   */
  getAllStatus() {
    const statuses = {};
    for (const [id, instance] of this.instances) {
      statuses[id] = instance.getStatus();
    }
    return statuses;
  }

  /**
   * Auto-reconectar líneas activas al iniciar el servicio
   */
  async autoReconnect() {
    if (!this.sync.supabase) {
      console.log('⚠️  Sin Supabase, no se puede auto-reconectar');
      return;
    }

    try {
      const { data: lineas, error } = await this.sync.supabase
        .from('reportia_eneache_wa_lineas')
        .select('id, instancia_id, nombre')
        .eq('activa', true);

      if (error) {
        console.error('Error obteniendo líneas:', error.message);
        return;
      }

      if (!lineas || lineas.length === 0) {
        console.log('📭 No hay líneas activas para reconectar');
        return;
      }

      console.log(`🔄 Reconectando ${lineas.length} línea(s)...`);

      for (const linea of lineas) {
        if (!linea.instancia_id) continue;

        try {
          const authDir = path.join(AUTH_BASE, `session_${linea.instancia_id}`);
          const hasSession = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

          const instance = await this.create(linea.id, linea.instancia_id);

          if (hasSession) {
            console.log(`  🔄 ${linea.nombre} (${linea.instancia_id}) — sesión encontrada, reconectando...`);
            await instance.connect();
          } else {
            console.log(`  ⏸️  ${linea.nombre} (${linea.instancia_id}) — sin sesión, esperando QR`);
            // Actualizar estado en Supabase
            await this.sync.updateLineaStatus(linea.id, 'disconnected');
          }
        } catch (err) {
          console.error(`  ❌ Error reconectando ${linea.nombre}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error en auto-reconexión:', err.message);
    }
  }

  /**
   * Heartbeat: actualizar estado de todas las instancias en Supabase
   */
  async heartbeat() {
    if (!this.sync.supabase) return;

    for (const [instanciaId, instance] of this.instances) {
      try {
        const status = instance.getStatus();
        await this.sync.supabase
          .from('reportia_eneache_wa_lineas')
          .update({
            estado: status.status,
            telefono: status.phoneNumber,
            push_name: status.pushName,
            ultimo_heartbeat: new Date().toISOString(),
          })
          .eq('instancia_id', instanciaId);
      } catch (err) {
        // Silencioso, no romper el heartbeat por un error
      }
    }
  }
}

module.exports = { InstanceManager };
