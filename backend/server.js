const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const dotenv = require("dotenv");
const admin = require("firebase-admin");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
let firebaseAdminEnabled = false;
const useMockGemini = process.env.MOCK_GEMINI === "true";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "https://ollama.com";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss:120b";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const OLLAMA_API_MODE = process.env.OLLAMA_API_MODE || "chat";

function getModelCandidates() {
  const primary = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const candidates = [
    primary,
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
  ];
  return [...new Set(candidates)];
}

function initializeFirebaseAdmin() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    return;
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseAdminEnabled = true;
    console.log("Firebase Admin inicializado desde FIREBASE_SERVICE_ACCOUNT_JSON.");
  } catch (error) {
    console.warn("No se pudo inicializar Firebase Admin:", error.message);
  }
}

initializeFirebaseAdmin();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin no permitido por CORS"));
    },
  })
);
app.use(express.json({ limit: "1mb" }));

function requireGeminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY no está configurada en entorno.");
  }
  return key;
}

function isOllamaEnabled() {
  return process.env.ENABLE_OLLAMA_FALLBACK === "true";
}

function extractJsonString(text) {
  const cleaned = String(text || "").trim();
  const fenced = cleaned.match(/```json\s*([\s\S]*?)```/i) || cleaned.match(/```([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function getTopicKeywords(topic) {
  return String(topic || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 6);
}

function isQuizTopical(quiz, topic) {
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    return false;
  }

  const topicLower = String(topic || "").toLowerCase();
  const keywords = getTopicKeywords(topic);

  let relevantCount = 0;
  for (const item of quiz.questions) {
    const text = `${item.question || ""} ${(item.options || []).join(" ")} ${item.explanation || ""}`.toLowerCase();
    const hasTopic = topicLower && text.includes(topicLower);
    const hasKeyword = keywords.some((key) => text.includes(key));
    if (hasTopic || hasKeyword) {
      relevantCount += 1;
    }
  }

  return relevantCount >= 4;
}

function buildFallbackQuiz(topic, level) {
  return {
    questions: [
      {
        id: "q1",
        question: `¿Qué describe mejor el objetivo al estudiar ${topic}?`,
        options: [
          "Memorizar sin comprender",
          "Comprender y aplicar conceptos",
          "Evitar ejercicios",
          "Solo leer teoría",
        ],
        correctIndex: 1,
        explanation: "El aprendizaje efectivo combina comprensión y aplicación.",
      },
      {
        id: "q2",
        question: `Para nivel ${level}, ¿qué método mejora más el progreso?`,
        options: [
          "Practicar con retroalimentación",
          "No revisar errores",
          "Estudiar una vez por semana",
          "Saltar fundamentos",
        ],
        correctIndex: 0,
        explanation: "La práctica con feedback acelera el dominio del tema.",
      },
      {
        id: "q3",
        question: "¿Qué hacer cuando fallas una respuesta?",
        options: [
          "Ignorar el error",
          "Analizar la explicación y reintentar",
          "Cambiar de tema inmediatamente",
          "Memorizar sin contexto",
        ],
        correctIndex: 1,
        explanation: "Entender el error fortalece la retención y la precisión.",
      },
      {
        id: "q4",
        question: "¿Cuál es una señal de aprendizaje real?",
        options: [
          "Más tiempo sin resultados",
          "Mayor exactitud en respuestas",
          "Leer sin practicar",
          "Evitar evaluación",
        ],
        correctIndex: 1,
        explanation: "Mejorar precisión y consistencia muestra progreso real.",
      },
      {
        id: "q5",
        question: `¿Qué hábito sostiene el avance en ${topic}?`,
        options: [
          "Repaso activo y constante",
          "Estudiar solo cuando hay examen",
          "Evitar preguntas difíciles",
          "No tomar notas",
        ],
        correctIndex: 0,
        explanation: "La constancia con repaso activo consolida el conocimiento.",
      },
    ],
  };
}

function normalizeQuizShape(rawQuiz, topic, level) {
  if (!rawQuiz || !Array.isArray(rawQuiz.questions)) {
    return buildFallbackQuiz(topic, level);
  }

  const normalized = rawQuiz.questions
    .map((item, index) => {
      const options = Array.isArray(item.options) ? item.options.filter(Boolean).slice(0, 4) : [];
      if (options.length < 4) {
        return null;
      }

      let correctIndex = Number(item.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
        correctIndex = 0;
      }

      return {
        id: String(item.id || `q${index + 1}`),
        question: String(item.question || "Pregunta"),
        options,
        correctIndex,
        explanation: String(item.explanation || "Revisa este concepto para reforzar la respuesta."),
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  if (normalized.length < 5) {
    return buildFallbackQuiz(topic, level);
  }

  return { questions: normalized };
}

async function parseQuizWithRepair(quizText, topic, level) {
  const firstCandidate = extractJsonString(quizText);
  try {
    const parsed = JSON.parse(firstCandidate);
    const normalized = normalizeQuizShape(parsed, topic, level);
    if (isQuizTopical(normalized, topic)) {
      return normalized;
    }

    const topicalPrompt = `Regenera el siguiente quiz para que sea ESPECÍFICAMENTE sobre "${topic}" (nivel "${level}").
Condiciones obligatorias:
- 5 preguntas, 4 opciones cada una
- Cada pregunta debe mencionar explícitamente conceptos de ${topic}
- Incluye correctIndex (0..3) y explanation
- Devuelve SOLO JSON válido con esquema {"questions":[...]}

Quiz actual:
${JSON.stringify(normalized)}`;

    const { text: topicalText } = await generateWithFallback(topicalPrompt, {
      requireJson: true,
    });
    const topicalParsed = JSON.parse(extractJsonString(topicalText));
    return normalizeQuizShape(topicalParsed, topic, level);
  } catch (firstError) {
    const repairPrompt = `Corrige el siguiente contenido para que sea JSON válido y cumpla exactamente este esquema: {"questions":[{"id":"string","question":"string","options":["a","b","c","d"],"correctIndex":0,"explanation":"string"}]}. Deben ser 5 preguntas. Devuelve SOLO JSON válido.\n\nContenido:\n${firstCandidate}`;
    try {
      const { text: repairedText } = await generateWithFallback(repairPrompt, {
        requireJson: true,
      });
      const repaired = JSON.parse(extractJsonString(repairedText));
      return normalizeQuizShape(repaired, topic, level);
    } catch (repairError) {
      console.warn("Quiz JSON inválido, usando fallback local:", firstError.message, repairError.message);
      return buildFallbackQuiz(topic, level);
    }
  }
}

async function callOllama(prompt, requireJson = false) {
  const headers = { "Content-Type": "application/json" };
  if (OLLAMA_API_KEY) {
    headers.Authorization = `Bearer ${OLLAMA_API_KEY}`;
  }

  const endpoint = OLLAMA_API_MODE === "generate" ? "/api/generate" : "/api/chat";

  const payload =
    OLLAMA_API_MODE === "generate"
      ? {
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
          options: {
            temperature: 0.3,
          },
          ...(requireJson ? { format: "json" } : {}),
        }
      : {
          model: OLLAMA_MODEL,
          messages: [
            {
              role: "system",
              content: requireJson
                ? "Responde SOLO JSON válido, sin markdown, sin texto adicional."
                : "Responde en español de forma clara y breve.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 600,
          },
        };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const response = await fetch(`${OLLAMA_BASE_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const text =
    OLLAMA_API_MODE === "generate"
      ? data?.response
      : data?.message?.content || data?.message?.thinking;
  if (!text) {
    throw new Error("Ollama no devolvió contenido.");
  }
  return text;
}

async function callGemini(prompt, responseSchema = null) {
  const apiKey = requireGeminiKey();
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

  const models = getModelCandidates();
  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      lastError = `Gemini API error ${response.status} (${model}): ${text}`;
      if (response.status === 404) {
        continue;
      }
      throw new Error(lastError);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return text;
    }
    lastError = `Gemini (${model}) no devolvió contenido.`;
  }

  throw new Error(lastError || "No fue posible obtener respuesta de Gemini.");
}

async function generateWithFallback(prompt, { responseSchema = null, requireJson = false } = {}) {
  try {
    const geminiText = await callGemini(prompt, responseSchema);
    return { text: geminiText, provider: "gemini" };
  } catch (geminiError) {
    if (!isOllamaEnabled()) {
      throw geminiError;
    }

    const ollamaPrompt = requireJson
      ? `${prompt}\n\nDevuelve SOLO JSON válido, sin markdown ni texto adicional.`
      : prompt;

    try {
      const ollamaText = await callOllama(ollamaPrompt, requireJson);
      return { text: ollamaText, provider: "ollama" };
    } catch (ollamaError) {
      throw new Error(
        `Gemini falló: ${geminiError.message}. Ollama también falló: ${ollamaError.message}`
      );
    }
  }
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

app.get("/", (req, res) => {
  res.json({
    app: "Lumen API",
    status: "ok",
    firebaseAdminEnabled,
    ollamaFallbackEnabled: isOllamaEnabled(),
    ollamaBaseUrl: OLLAMA_BASE_URL,
    ollamaModel: OLLAMA_MODEL,
    ollamaApiMode: OLLAMA_API_MODE,
    endpoints: [
      "POST /api/summary",
      "POST /api/study-plan",
      "POST /api/quiz",
      "POST /api/feedback",
    ],
  });
});

app.post("/api/summary", async (req, res) => {
  try {
    const { topic, level } = req.body || {};
    if (!topic || !level) {
      res.status(400).json({ error: "Faltan topic o level" });
      return;
    }

    if (useMockGemini) {
      res.json({
        summary: `Resumen demo de ${topic} (${level}): este tema se centra en conceptos clave, ejemplos prácticos y aplicación paso a paso para estudiar con claridad.`,
      });
      return;
    }

    const prompt = `Resume el tema "${topic}" para un estudiante de nivel "${level}" en máximo 160 palabras y en español claro.`;
    const { text: summary } = await generateWithFallback(prompt);
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/api/study-plan", async (req, res) => {
  try {
    const { topic, level } = req.body || {};
    if (!topic || !level) {
      res.status(400).json({ error: "Faltan topic o level" });
      return;
    }

    if (useMockGemini) {
      res.json({
        plan: `1) Define conceptos base de ${topic}.\n2) Revisa un ejemplo guiado.\n3) Resuelve 3 ejercicios de nivel ${level}.\n4) Explica el tema con tus palabras.\n5) Haz autoevaluación con el quiz.`,
      });
      return;
    }

    const prompt = `Genera un mini plan de estudio para "${topic}" (nivel "${level}") con 5 pasos concretos y breves en español.`;
    const { text: plan } = await generateWithFallback(prompt);
    res.json({ plan });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/api/quiz", async (req, res) => {
  try {
    const { topic, level } = req.body || {};
    if (!topic || !level) {
      res.status(400).json({ error: "Faltan topic o level" });
      return;
    }

    if (useMockGemini) {
      res.json({
        questions: [
          {
            id: "q1",
            question: `¿Cuál describe mejor el objetivo de estudiar ${topic}?`,
            options: [
              "Memorizar sin entender",
              "Comprender conceptos y aplicarlos",
              "Evitar ejercicios",
              "Solo leer definiciones",
            ],
            correctIndex: 1,
            explanation: "Aprender implica comprender y aplicar, no solo memorizar.",
          },
          {
            id: "q2",
            question: `Para nivel ${level}, ¿qué estrategia es más útil?`,
            options: [
              "No practicar",
              "Practicar con retroalimentación",
              "Saltarse teoría",
              "Estudiar una vez al mes",
            ],
            correctIndex: 1,
            explanation: "La práctica constante con feedback mejora el aprendizaje.",
          },
          {
            id: "q3",
            question: "¿Qué mejora más la retención?",
            options: [
              "Repaso activo",
              "Pasividad",
              "Distracciones",
              "Sin descanso",
            ],
            correctIndex: 0,
            explanation: "El repaso activo fortalece memoria y comprensión.",
          },
          {
            id: "q4",
            question: "¿Qué hacer al fallar una pregunta?",
            options: [
              "Ignorar el error",
              "Revisar explicación y volver a intentar",
              "Dejar de estudiar",
              "Cambiar de tema siempre",
            ],
            correctIndex: 1,
            explanation: "Analizar errores acelera el progreso.",
          },
          {
            id: "q5",
            question: "¿Qué indica progreso real?",
            options: [
              "Solo tiempo invertido",
              "Mejor precisión en respuestas",
              "Más pestañas abiertas",
              "Evitar evaluación",
            ],
            correctIndex: 1,
            explanation: "La mejora en precisión refleja aprendizaje efectivo.",
          },
        ],
      });
      return;
    }

    const prompt = `Crea un quiz en español sobre "${topic}" para nivel "${level}".
Devuelve exactamente 5 preguntas de opción múltiple con 4 opciones cada una.
  Cada pregunta debe tratar un concepto real del tema "${topic}" y evitar preguntas genéricas de estudio.
  Incluye vocabulario técnico del tema dentro de la pregunta o explicación.
La opción correcta debe estar indicada en correctIndex (0 a 3).
Incluye una explicación breve por pregunta en explanation.`;

    const { text: quizText } = await generateWithFallback(prompt, {
      responseSchema: quizSchema,
      requireJson: true,
    });
    const quiz = await parseQuizWithRepair(quizText, topic, level);
    res.json(quiz);
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { question, selectedOption, correctOption } = req.body || {};
    if (!question || selectedOption == null || !correctOption) {
      res.status(400).json({ error: "Faltan datos para feedback" });
      return;
    }

    if (useMockGemini) {
      res.json({
        feedback: `Casi. En esta pregunta la opción correcta es "${correctOption}". Revisa el concepto principal y vuelve a intentarlo.`,
      });
      return;
    }

    const prompt = `Un estudiante respondió mal una pregunta.
Pregunta: "${question}"
Respuesta del estudiante: "${selectedOption}"
Respuesta correcta: "${correctOption}"
Da feedback inmediato en español en máximo 50 palabras, tono motivador y claro.`;

    const { text: feedback } = await generateWithFallback(prompt);
    res.json({ feedback });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.use((error, req, res, next) => {
  res.status(500).json({ error: error.message || "Error inesperado" });
});

app.listen(PORT, () => {
  console.log(`Lumen API lista en puerto ${PORT}`);
});
