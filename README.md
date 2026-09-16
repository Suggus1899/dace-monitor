# Monitor DACE UNERG para Telegram

## Local

1. Copia `.env.example` a `.env` y completa los secretos.
2. Ejecuta `npm install`.
3. Ejecuta `npm run dev`.

Comandos: `/start`, `/ayuda`, `/estado`, `/inscripcion`, `/pensum`, `/constancia_notas` y `/notas`.

Solo `TELEGRAM_CHAT_ID` puede usar el bot. El monitor comprueba DACE al iniciar y cada 15 minutos. Si detecta inscripciones abiertas, un error o que cambió la disponibilidad de documentos académicos, envía un mensaje a ese chat.

## Configuración

El archivo `.env.example` muestra las siete variables requeridas. `APP_BASE_URL` debe ser una URL HTTPS pública; `TELEGRAM_CHAT_ID` es el único chat autorizado para usar el bot.

## Render Free

En Render crea un **Web Service** desde tu repositorio; `render.yaml` configura `npm ci && npm run build`, `npm start` y `/health`. Carga las siete variables requeridas en el panel de Render. No subas `.env` ni credenciales al repositorio.

Render Free suspende el servicio tras 15 minutos sin tráfico entrante y puede reiniciarlo. Para que el cron se ejecute continuamente, configura un monitor externo que haga `GET https://TU-SERVICIO.onrender.com/health` cada 10 minutos. El primer ping tras una suspensión puede tardar cerca de un minuto.

Los errores de red, DACE o Telegram se registran sin detener el proceso; el cron volverá a intentarlo en la siguiente ejecución. La puntualidad exacta de 15 minutos no está garantizada mientras el servicio use el plan Free.
