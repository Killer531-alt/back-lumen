const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const geminiApiKey = defineSecret("GEMINI_API_KEY");

const MODEL = "gemini-1.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJson(res, status, body) {
  res.set(corsHeaders);
  res.status(status).json(body);
}

async function callGemini(prompt, responseSchema = null) {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY no está configurada en variables de entorno.");
  }

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1200,
    },
  };

  if (responseSchema) {
    payload.generationConfig.responseMimeType = "application/json";
    payload.generationConfig.responseSchema = responseSchema;
  }

  const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini no devolvió contenido.");
  }
  return text;
}

const quizSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 4,
            maxItems: 4,
          },
          correctIndex: { type: "number" },
          explanation: { type: "string" },
        },
        required: ["id", "question", "options", "correctIndex", "explanation"],
      },
      minItems: 5,
      maxItems: 5,
    },
  },
  required: ["questions"],
};

exports.api = onRequest({ region: "us-central1", secrets: [geminiApiKey] }, async (req, res) => {
  if (req.method === "OPTIONS") {
    res.set(corsHeaders);
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Método no permitido" });
    return;
  }

  const route = req.path.replace(/^\/api\/?/, "");
  const { topic, level, question, selectedOption, correctOption } = req.body || {};

  try {
    if (route === "summary") {
      if (!topic || !level) {
        sendJson(res, 400, { error: "Faltan topic o level" });
        return;
      }

      const prompt = `Resume el tema "${topic}" para un estudiante de nivel "${level}" en máximo 160 palabras y en español claro.`;
      const summary = await callGemini(prompt);
      sendJson(res, 200, { summary });
      return;
    }

    if (route === "study-plan") {
      if (!topic || !level) {
        sendJson(res, 400, { error: "Faltan topic o level" });
        return;
      }

      const prompt = `Genera un mini plan de estudio para "${topic}" (nivel "${level}") con 5 pasos concretos y breves en español.`;
      const plan = await callGemini(prompt);
      sendJson(res, 200, { plan });
      return;
    }

    if (route === "quiz") {
      if (!topic || !level) {
        sendJson(res, 400, { error: "Faltan topic o level" });
        return;
      }

      const prompt = `Crea un quiz en español sobre "${topic}" para nivel "${level}".
Devuelve exactamente 5 preguntas de opción múltiple con 4 opciones cada una.
La opción correcta debe estar indicada en correctIndex (0 a 3).
Incluye una explicación breve por pregunta en explanation.`;

      const quizText = await callGemini(prompt, quizSchema);
      const quiz = JSON.parse(quizText);
      sendJson(res, 200, quiz);
      return;
    }

    if (route === "feedback") {
      if (!question || selectedOption == null || !correctOption) {
        sendJson(res, 400, { error: "Faltan datos para feedback" });
        return;
      }

      const prompt = `Un estudiante respondió mal una pregunta.
Pregunta: "${question}"
Respuesta del estudiante: "${selectedOption}"
Respuesta correcta: "${correctOption}"
Da feedback inmediato en español en máximo 50 palabras, tono motivador y claro.`;

      const feedback = await callGemini(prompt);
      sendJson(res, 200, { feedback });
      return;
    }

    sendJson(res, 404, { error: "Ruta no encontrada" });
  } catch (error) {
    logger.error(error);
    sendJson(res, 500, { error: error.message || "Error interno" });
  }
});
