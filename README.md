# Lumen (Frontend Firebase + Backend API en Render)

Lumen es un asistente de estudio IA: el usuario ingresa tema y nivel, y la app genera automáticamente:

- Resumen del tema
- Mini plan de estudio
- Quiz interactivo con opciones
- Feedback inmediato si responde mal
- Guardado de progreso en Firestore

## Stack

- Firebase Hosting (frontend)
- Backend API Express (Render)
- Firestore (progreso)
- Firebase Auth anónimo (uid por sesión)
- Gemini API (`gemini-1.5-flash`)

## Estructura

- `public/` frontend web
- `backend/` API Node/Express con endpoints `/api/*`
- `firestore.rules` reglas mínimas de seguridad

## Requisitos

- Node.js 20+
- Firebase CLI
- Proyecto Firebase creado

## Configuración

1. Instalar dependencias de functions:

```bash
cd backend
npm install
cd ..
```

2. Configurar el proyecto Firebase:

- Edita `.firebaserc` y reemplaza `YOUR_FIREBASE_PROJECT_ID`.
- Edita `public/runtime-config.js` y completa:
	- `apiBaseUrl` con la URL real de Render o local.
	- `firebase` con tus credenciales reales de Firebase Web App.

3. Configurar variables en Render (NO en frontend):

- `GEMINI_API_KEY` = tu key de Gemini
- `ALLOWED_ORIGINS` = dominios Firebase separados por coma
	- ejemplo: `https://tuapp.web.app,https://tuapp.firebaseapp.com`

4. (Opcional local backend) copia `backend/.env.example` a `backend/.env`.

## Ejecutar backend en local

```bash
cd backend
npm run dev
```

API local: `http://localhost:8080`

Si tu cuota de Gemini está agotada, activa modo demo en `backend/.env`:

```env
MOCK_GEMINI=true
```

Con eso, los endpoints `/api/summary`, `/api/study-plan`, `/api/quiz` y `/api/feedback` responden con datos mock para probar todo el flujo de Lumen.

## Ejecutar en local

```bash
firebase emulators:start --only hosting,firestore
```

Abre Hosting local en la URL del emulador y asegúrate de que `apiBaseUrl` apunte a tu backend local o Render.

## Deploy

### Backend (Render)

- Crea un Web Service apuntando a carpeta `backend`
- Build command: `npm install`
- Start command: `npm start`
- Añade variables de entorno (`GEMINI_API_KEY`, `ALLOWED_ORIGINS`)

### Frontend (Firebase)

```bash
firebase deploy --only hosting,firestore:rules
```

## Flujo de llamadas Gemini por sesión

Al iniciar una sesión se hacen 3 llamadas mínimas:

1. `POST /api/summary`
2. `POST /api/study-plan`
3. `POST /api/quiz`

Y cada error en el quiz dispara una llamada extra a `POST /api/feedback`.

## Nota de seguridad

- No subas API keys al repositorio.
- Mantén Gemini únicamente desde backend (Render).
