import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const API_BASE =
  window.__LUMEN_CONFIG__?.apiBaseUrl ||
  "https://TU-BACKEND-ONRENDER.onrender.com/api";

const firebaseConfig = window.__LUMEN_CONFIG__?.firebase || {};

function hasPlaceholder(value) {
  return typeof value === "string" && value.includes("YOUR_");
}

function validateFirebaseConfig(config) {
  const required = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
  ];

  const missing = required.filter((field) => !config[field] || hasPlaceholder(config[field]));
  if (missing.length > 0) {
    throw new Error(
      `Config de Firebase incompleta (${missing.join(", ")}). Edita public/runtime-config.js con credenciales reales.`
    );
  }
}

validateFirebaseConfig(firebaseConfig);

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const startBtn = document.getElementById("startBtn");
const topicInput = document.getElementById("topic");
const levelSelect = document.getElementById("level");
const statusEl = document.getElementById("status");
const summarySection = document.getElementById("summarySection");
const planSection = document.getElementById("planSection");
const quizSection = document.getElementById("quizSection");
const summaryEl = document.getElementById("summary");
const planEl = document.getElementById("plan");
const quizEl = document.getElementById("quiz");
const demoButtons = document.querySelectorAll(".demo-btn");

let currentUid = null;
let sessionId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function mapErrorMessage(error) {
  const raw = error?.message || "";
  if (raw.includes("auth/configuration-not-found")) {
    return "Firebase Auth no está configurado. En Firebase Console habilita Authentication y activa el proveedor Anonymous.";
  }
  if (raw.includes("auth/api-key-not-valid")) {
    return "La apiKey de Firebase no es válida. Revisa public/runtime-config.js.";
  }
  return raw || "Ocurrió un error inesperado.";
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || "Error en API");
  }
  return data;
}

function buildSessionId(topic, level) {
  const clean = `${topic}-${level}`.toLowerCase().replace(/\s+/g, "-").slice(0, 40);
  return `${clean}-${Date.now()}`;
}

async function ensureAuth() {
  if (currentUid) {
    return;
  }
  const userCred = await signInAnonymously(auth);
  currentUid = userCred.user.uid;
}

async function startSessionDoc(topic, level) {
  sessionId = buildSessionId(topic, level);
  const ref = doc(db, "users", currentUid, "sessions", sessionId);
  await setDoc(ref, {
    topic,
    level,
    createdAt: serverTimestamp(),
    totalQuestions: 0,
    answered: 0,
    correctCount: 0,
    geminiCalls: 0,
  });
}

async function registerGeminiCalls(amount) {
  const ref = doc(db, "users", currentUid, "sessions", sessionId);
  await updateDoc(ref, { geminiCalls: increment(amount) });
}

async function saveAnswer(question, selectedOption, isCorrect, feedback = "") {
  const ref = doc(db, "users", currentUid, "sessions", sessionId);
  await updateDoc(ref, {
    answered: increment(1),
    correctCount: increment(isCorrect ? 1 : 0),
    [`answers.${question.id}`]: {
      question: question.question,
      selectedOption,
      correctOption: question.options[question.correctIndex],
      isCorrect,
      feedback,
      answeredAt: new Date().toISOString(),
    },
  });
}

function renderQuiz(questions) {
  quizEl.innerHTML = "";

  questions.forEach((q, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "question";
    wrapper.innerHTML = `<p><strong>${index + 1}. ${q.question}</strong></p>`;

    const optionsGroup = document.createElement("div");
    q.options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      label.className = "option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `q-${q.id}`;
      radio.value = option;

      label.appendChild(radio);
      label.append(option);
      optionsGroup.appendChild(label);
    });

    const checkBtn = document.createElement("button");
    checkBtn.textContent = "Comprobar";

    const result = document.createElement("p");
    result.className = "result";

    const feedback = document.createElement("p");
    feedback.className = "feedback";

    checkBtn.addEventListener("click", async () => {
      const selected = optionsGroup.querySelector("input:checked");
      if (!selected) {
        result.textContent = "Selecciona una opción.";
        return;
      }

      checkBtn.disabled = true;
      const selectedOption = selected.value;
      const correctOption = q.options[q.correctIndex];
      const isCorrect = selectedOption === correctOption;

      if (isCorrect) {
        result.textContent = "✅ Correcto";
        feedback.textContent = q.explanation;
        await saveAnswer(q, selectedOption, true, q.explanation);
      } else {
        result.textContent = "❌ Incorrecto";
        const data = await postJson("/feedback", {
          question: q.question,
          selectedOption,
          correctOption,
        });
        await registerGeminiCalls(1);
        feedback.textContent = data.feedback;
        await saveAnswer(q, selectedOption, false, data.feedback);
      }
    });

    wrapper.appendChild(optionsGroup);
    wrapper.appendChild(checkBtn);
    wrapper.appendChild(result);
    wrapper.appendChild(feedback);
    quizEl.appendChild(wrapper);
  });
}

async function runSession(topic, level) {
  try {
    if (!topic) {
      setStatus("Escribe un tema antes de continuar.");
      return;
    }

    startBtn.disabled = true;
    setStatus("Preparando sesión...");

    await ensureAuth();
    await startSessionDoc(topic, level);

    setStatus("Generando resumen, plan y quiz con Gemini...");

    const [summaryData, planData, quizData] = await Promise.all([
      postJson("/summary", { topic, level }),
      postJson("/study-plan", { topic, level }),
      postJson("/quiz", { topic, level }),
    ]);

    await registerGeminiCalls(3);

    summaryEl.textContent = summaryData.summary;
    planEl.textContent = planData.plan;
    renderQuiz(quizData.questions);

    const ref = doc(db, "users", currentUid, "sessions", sessionId);
    await updateDoc(ref, { totalQuestions: quizData.questions.length });

    summarySection.classList.remove("hidden");
    planSection.classList.remove("hidden");
    quizSection.classList.remove("hidden");
    setStatus("Contenido generado. ¡Responde el quiz!");
  } catch (error) {
    setStatus(`Error: ${mapErrorMessage(error)}`);
  } finally {
    startBtn.disabled = false;
    demoButtons.forEach((button) => {
      button.disabled = false;
    });
  }
}

startBtn.addEventListener("click", async () => {
  const topic = topicInput.value.trim();
  const level = levelSelect.value;
  await runSession(topic, level);
});

demoButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const topic = button.dataset.topic || "";
    const level = button.dataset.level || "principiante";
    topicInput.value = topic;
    levelSelect.value = level;
    demoButtons.forEach((item) => {
      item.disabled = true;
    });
    await runSession(topic, level);
  });
});

