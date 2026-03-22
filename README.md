# 📱 GIMSA WhatsApp Baileys Service

Servicio standalone que conecta WhatsApp vía escaneo QR (como WhatsApp Web) y expone una API REST para el frontend del Semáforo Comercial GIMSA.

## ¿Qué es esto?

Usa la librería [Baileys](https://github.com/WhiskeySockets/Baileys) para conectarse a WhatsApp sin necesidad de la API oficial de Meta. Solo escaneás un QR con tu teléfono y listo — funciona como WhatsApp Web pero controlado por tu sistema.

## ⚠️ Importante

- **No es la API oficial de Meta.** Funciona perfecto, pero técnicamente no está aprobado para uso comercial.
- **Necesita proceso Node.js corriendo 24/7.** No sirve en serverless (Supabase Edge Functions, Vercel, etc.).
- **La sesión se mantiene mientras el servicio esté activo.** Si se reinicia, puede reconectar automáticamente.
- **Si cerrás la sesión desde el teléfono** (WhatsApp > Dispositivos vinculados), hay que escanear QR de nuevo.

## 🚀 Setup rápido

### 1. Clonar y configurar

```bash
git clone <tu-repo>
cd baileys-service
cp .env.example .env
# Editar .env con tus credenciales de Supabase
npm install
```

### 2. Correr en local

```bash
npm start
```

### 3. Escanear QR

Abrir en el navegador:
```
http://localhost:3100/api/qr
```

Copiar el valor de `qr` (es un data URL base64) y pegarlo en un tag `<img>`, o simplemente mirar la terminal donde también se muestra el QR.

En WhatsApp del teléfono: **Configuración > Dispositivos vinculados > Vincular dispositivo** y escanear.

### 4. Verificar conexión

```
http://localhost:3100/api/status
```

Debería mostrar `"status": "connected"`.

## 🌐 API Endpoints

### Conexión

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/status` | Estado actual (connected/disconnected/qr_pending) |
| GET | `/api/qr` | QR como base64 para mostrar en UI |
| POST | `/api/connect` | Iniciar conexión |
| POST | `/api/disconnect` | Desconectar y limpiar sesión |
| POST | `/api/reconnect` | Limpiar sesión y generar QR nuevo |

### Mensajes

| Método | Endpoint | Body | Descripción |
|--------|----------|------|-------------|
| POST | `/api/send/text` | `{ phone, text }` | Enviar texto |
| POST | `/api/send/image` | `{ phone, image, caption?, mimetype? }` | Enviar imagen (base64) |
| POST | `/api/send/document` | `{ phone, document, filename, mimetype?, caption? }` | Enviar documento (base64) |
| POST | `/api/check-number` | `{ phone }` | Verificar si tiene WhatsApp |

### Conversaciones

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/conversations` | Lista de conversaciones activas |
| GET | `/api/conversations/:id/messages` | Mensajes de una conversación |
| POST | `/api/conversations/:id/create-opportunity` | Crear oportunidad en el pipeline |

### Health

| Método | Endpoint |
|--------|----------|
| GET | `/health` | Health check del servicio |

## ☁️ Deploy en Railway

1. Crear cuenta en [railway.app](https://railway.app)
2. Nuevo proyecto > Deploy from GitHub repo
3. Configurar variables de entorno (las del `.env.example`)
4. Railway genera una URL pública (ej: `gimsa-wa.up.railway.app`)
5. Esa URL es la que se configura en Lovable para conectar

### Variables de entorno en Railway

```
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
PORT=3100
```

### ⚠️ Persistencia de sesión en Railway

Railway recrea el filesystem en cada deploy. Para que la sesión de WhatsApp sobreviva deploys, hay dos opciones:

**Opción A: Volume (recomendada)**
En Railway > Service > Settings > agregar un Volume montado en `/app/auth`. Así la sesión persiste entre deploys.

**Opción B: Guardar sesión en Supabase**
Se puede modificar el código para guardar/leer la sesión de `auth/session` en una tabla de Supabase en vez del filesystem. Más complejo pero más robusto.

## 🔗 Conectar con Lovable

En tu proyecto de Lovable, el frontend puede consumir la API de este servicio. Ejemplo:

```typescript
const WA_SERVICE_URL = 'https://gimsa-wa.up.railway.app';

// Obtener QR
const res = await fetch(`${WA_SERVICE_URL}/api/qr`);
const data = await res.json();
// data.qr es un base64 listo para <img src={data.qr} />

// Enviar mensaje
await fetch(`${WA_SERVICE_URL}/api/send/text`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: '595981234567', text: 'Hola desde GIMSA' }),
});
```

## 📊 Tablas en Supabase

Este servicio escribe en las tablas con prefijo `reportia_eneache_wa_*`:

- `reportia_eneache_wa_conversaciones` — Cada hilo de chat
- `reportia_eneache_wa_mensajes` — Cada mensaje
- `reportia_eneache_oportunidades` — Cuando se crea un lead desde el chat

## 📞 Formato de números (Paraguay)

- Con código de país: `595981234567`
- Con cero local: `0981234567` → se convierte automáticamente a `595981234567`
- El servicio maneja la conversión automáticamente.
