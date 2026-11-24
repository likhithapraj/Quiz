const screens = [...document.querySelectorAll(".screen")];
const form = document.getElementById("registration-form");
const questionGrid = document.getElementById("question-grid");
const optionList = document.getElementById("options-list");
const timerValue = document.getElementById("timer-value");
const questionTimeValue = document.getElementById("question-time-value");
const formError = document.getElementById("form-error");
const quizError = document.getElementById("quiz-error");
const serverSetupMessage =
  "Quiz Arena needs its Node API. In the project folder run `npm start`, then open http://127.0.0.1:3000/ instead of using Live Server.";

let questions = [];
let attempt = null;
let currentQuestion = 0;
let globalTimerInterval = null;
let questionTimerInterval = null;
let globalTimerAnchor = 0;
let globalRemainingAtAnchor = 0;
let questionTimerAnchor = 0;
let questionElapsedAtAnchor = 0;
let answerPending = false;
let displayPending = false;
let displayRequestId = 0;
let submitPending = false;

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      cache: "no-store",
      credentials: "same-origin"
    });
  } catch {
    throw new ApiError(serverSetupMessage, 0, "API_UNAVAILABLE");
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(serverSetupMessage, response.status, "API_UNAVAILABLE");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("The server returned an invalid response.", response.status, "INVALID_RESPONSE");
  }
  if (!response.ok) {
    throw new ApiError(payload.error || "The request could not be completed.", response.status, payload.code);
  }
  return payload;
}

function showScreen(screenId) {
  screens.forEach((screen) => {
    const active = screen.id === screenId;
    screen.classList.toggle("is-active", active);
    screen.setAttribute("aria-hidden", String(!active));
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function clearError(element) {
  element.textContent = "";
  element.hidden = true;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatElapsed(milliseconds) {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function formatCompletionTime(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return formatTime(seconds);
}

function questionState(index) {
  return attempt.questions[index];
}

function buildQuestionNavigator() {
  questionGrid.replaceChildren();
  questions.forEach((_, index) => {
    const button = document.createElement("button");
    button.className = "question-nav-button";
    button.type = "button";
    button.dataset.question = String(index);
    button.textContent = String(index + 1).padStart(2, "0");
    button.setAttribute("aria-label", `Go to question ${index + 1}`);
    questionGrid.append(button);
  });
}

function updateQuestionTimer() {
  const state = questionState(currentQuestion);
  if (!state) return;
  const elapsed = state.firstAnsweredAtMs !== null
    ? state.timeTakenMs
    : questionElapsedAtAnchor + performance.now() - questionTimerAnchor;
  questionTimeValue.textContent = formatElapsed(elapsed || 0);
}

function startQuestionTimer(state) {
  window.clearInterval(questionTimerInterval);
  questionElapsedAtAnchor = state.elapsedMs || 0;
  questionTimerAnchor = performance.now();
  updateQuestionTimer();
  if (state.firstAnsweredAtMs === null) {
    questionTimerInterval = window.setInterval(updateQuestionTimer, 100);
  }
}

function renderQuestion() {
  const question = questions[currentQuestion];
  const state = questionState(currentQuestion);
  if (!question || !state) return;

  document.getElementById("question-category").textContent = question.category;
  document.getElementById("question-number").textContent = String(currentQuestion + 1).padStart(2, "0");
  document.getElementById("quiz-heading").textContent = question.question;
  document.getElementById("progress-label").innerHTML =
    `${String(currentQuestion + 1).padStart(2, "0")} <i>/</i> ${questions.length}`;
  document.getElementById("progress-fill").style.width =
    `${((currentQuestion + 1) / questions.length) * 100}%`;
  document.getElementById("previous-button").disabled = currentQuestion === 0 || displayPending;
  document.getElementById("next-button").hidden = currentQuestion === questions.length - 1;
  document.getElementById("next-button").disabled = displayPending;
  document.getElementById("submit-button").hidden = currentQuestion !== questions.length - 1;
  document.getElementById("submit-button").disabled = displayPending || answerPending || submitPending;
  document.getElementById("answered-count").textContent =
    `${attempt.questions.filter((item) => item.answerIndex !== null).length}/${questions.length}`;

  optionList.replaceChildren();
  question.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.className = `option-button${state.answerIndex === index ? " is-selected" : ""}`;
    button.type = "button";
    button.dataset.option = String(index);
    button.setAttribute("aria-pressed", String(state.answerIndex === index));
    button.disabled = answerPending || displayPending || submitPending;
    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = String.fromCharCode(65 + index);
    const label = document.createElement("span");
    label.textContent = option;
    button.append(letter, label);
    optionList.append(button);
  });

  [...questionGrid.children].forEach((button, index) => {
    button.classList.toggle("is-current", index === currentQuestion);
    button.classList.toggle("is-answered", attempt.questions[index].answerIndex !== null);
    button.setAttribute("aria-current", index === currentQuestion ? "step" : "false");
    button.disabled = displayPending || submitPending;
  });
  startQuestionTimer(state);
}

function startGlobalTimer() {
  window.clearInterval(globalTimerInterval);
  globalRemainingAtAnchor = attempt.remainingMs;
  globalTimerAnchor = performance.now();
  const update = () => {
    const remaining = Math.max(0, globalRemainingAtAnchor - (performance.now() - globalTimerAnchor));
    const remainingSeconds = Math.ceil(remaining / 1000);
    timerValue.textContent = formatTime(remainingSeconds);
    document.getElementById("timer").classList.toggle("is-low", remainingSeconds <= 60);
    if (remaining <= 0) {
      window.clearInterval(globalTimerInterval);
      submitQuiz(true);
    }
  };
  update();
  globalTimerInterval = window.setInterval(update, 250);
}

async function displayQuestion(index) {
  if (!attempt || attempt.status !== "active" || index < 0 || index >= questions.length) return;
  currentQuestion = index;
  displayPending = true;
  const requestId = ++displayRequestId;
  clearError(quizError);
  renderQuestion();
  try {
    const state = await api(`/api/attempts/${attempt.id}/questions/${index}/display`, { method: "POST" });
    attempt.questions[index] = state;
    if (currentQuestion === index) renderQuestion();
  } catch (error) {
    if (error.code === "ATTEMPT_FINISHED") {
      await restoreAttempt();
      return;
    }
    showError(quizError, error.message);
  } finally {
    if (requestId === displayRequestId) {
      displayPending = false;
      if (attempt?.status === "active" && currentQuestion === index) renderQuestion();
    }
  }
}

function showParticipant(attemptState) {
  const { name, team } = attemptState.participant;
  document.getElementById("quiz-player").textContent = team ? `${name} · ${team}` : name;
}

async function startAttempt(event) {
  event.preventDefault();
  clearError(formError);
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const data = new FormData(form);
    attempt = await api("/api/attempts", {
      method: "POST",
      body: JSON.stringify({
        name: String(data.get("participantName") || "").trim(),
        college: String(data.get("collegeName") || "").trim(),
        team: String(data.get("teamName") || "").trim()
      })
    });
    currentQuestion = attempt.currentQuestion;
    showParticipant(attempt);
    buildQuestionNavigator();
    startGlobalTimer();
    showScreen("quiz");
    await displayQuestion(currentQuestion);
  } catch (error) {
    showError(formError, error.message);
  } finally {
    submitButton.disabled = false;
  }
}

async function selectAnswer(optionIndex) {
  if (!attempt || answerPending || submitPending) return;
  answerPending = true;
  clearError(quizError);
  renderQuestion();
  const index = currentQuestion;
  try {
    const state = await api(`/api/attempts/${attempt.id}/questions/${index}/answer`, {
      method: "POST",
      body: JSON.stringify({ optionIndex })
    });
    attempt.questions[index] = state;
    if (currentQuestion === index) renderQuestion();
  } catch (error) {
    if (error.code === "ATTEMPT_FINISHED") {
      await restoreAttempt();
      return;
    }
    showError(quizError, error.message);
  } finally {
    answerPending = false;
    if (attempt?.status === "active") renderQuestion();
  }
}

function performanceMessage(accuracy, answeredCount) {
  if (accuracy === 100) return "Flawless! The arena has a new legend.";
  if (accuracy >= 80) return "Outstanding work. You owned the arena!";
  if (accuracy >= 60) return "Impressive showing. You’ve got champion energy.";
  if (accuracy >= 40) return "Solid effort! Every great run starts somewhere.";
  if (answeredCount === 0) return "The arena is always here when you’re ready.";
  return "Keep learning, keep growing. Your next run awaits.";
}

function renderLeaderboard(entries) {
  const list = document.getElementById("leaderboard-list");
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "leaderboard-empty";
    empty.textContent = "No completed attempts yet. You can set the first record.";
    list.append(empty);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `#${entry.rank}`;
    const participant = document.createElement("span");
    participant.className = "leaderboard-participant";
    const name = document.createElement("strong");
    name.textContent = entry.team ? `${entry.name} · ${entry.team}` : entry.name;
    const college = document.createElement("small");
    college.textContent = entry.college;
    participant.append(name, college);
    const score = document.createElement("span");
    score.className = "leaderboard-score";
    score.textContent = `${entry.totalScore} pts`;
    const time = document.createElement("span");
    time.className = "leaderboard-time";
    time.textContent = formatCompletionTime(entry.completionTimeMs);
    row.append(rank, participant, score, time);
    list.append(row);
  });
}

async function loadLeaderboard() {
  const list = document.getElementById("leaderboard-list");
  list.textContent = "Loading leaderboard…";
  try {
    const payload = await api("/api/leaderboard");
    renderLeaderboard(payload.entries);
  } catch (error) {
    list.textContent = `Leaderboard unavailable: ${error.message}`;
  }
}

async function showResults(completedAttempt) {
  attempt = completedAttempt;
  window.clearInterval(globalTimerInterval);
  window.clearInterval(questionTimerInterval);
  const results = attempt.results;
  if (!results) {
    showError(quizError, "The server did not return final quiz results.");
    return;
  }

  document.getElementById("result-name").textContent = attempt.participant.name;
  document.getElementById("result-college").textContent = attempt.participant.college;
  document.getElementById("result-team").textContent = attempt.participant.team;
  document.getElementById("result-team").hidden = !attempt.participant.team;
  document.getElementById("score-value").textContent = String(results.totalScore);
  document.getElementById("base-score").textContent = String(results.baseScore);
  document.getElementById("bonus-score").textContent = String(results.bonusScore);
  document.getElementById("score-percent").textContent = `${results.accuracy}% accuracy`;
  document.getElementById("correct-count").textContent = String(results.correctCount);
  document.getElementById("incorrect-count").textContent = String(results.incorrectCount);
  document.getElementById("time-taken").textContent = formatCompletionTime(results.completionTimeMs);
  document.getElementById("score-fill").style.width = `${(results.totalScore / results.maximumScore) * 100}%`;
  const answeredCount = attempt.questions.filter((item) => item.answerIndex !== null).length;
  document.getElementById("performance-message").textContent =
    performanceMessage(results.accuracy, answeredCount);
  showScreen("results");
  await loadLeaderboard();
}

async function submitQuiz(automatic = false) {
  if (!attempt || attempt.status !== "active" || submitPending) return;
  if (!automatic) {
    const unanswered = attempt.questions.filter((item) => item.answerIndex === null).length;
    const message = unanswered
      ? `You have ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}. Submit your quiz anyway?`
      : "Ready to submit your quiz and see your results?";
    if (!window.confirm(message)) return;
  }

  submitPending = true;
  clearError(quizError);
  renderQuestion();
  try {
    const completed = await api(`/api/attempts/${attempt.id}/submit`, { method: "POST" });
    await showResults(completed);
  } catch (error) {
    showError(quizError, error.message);
    submitPending = false;
    if (attempt?.status === "active") renderQuestion();
  }
}

async function restoreAttempt() {
  try {
    attempt = await api("/api/attempts/current");
    showParticipant(attempt);
    if (attempt.status === "completed") {
      await showResults(attempt);
      return;
    }
    currentQuestion = attempt.currentQuestion;
    buildQuestionNavigator();
    startGlobalTimer();
    showScreen("quiz");
    await displayQuestion(currentQuestion);
  } catch (error) {
    if (error.code !== "NO_ACTIVE_ATTEMPT") {
      showError(document.getElementById("app-error"), error.message);
    }
  }
}

async function initialize() {
  try {
    questions = await api("/api/questions");
    buildQuestionNavigator();
    await restoreAttempt();
  } catch (error) {
    showError(document.getElementById("app-error"), error.message);
  }
}

document.getElementById("start-button").addEventListener("click", () => {
  clearError(formError);
  showScreen("registration");
});
form.addEventListener("submit", startAttempt);
document.querySelector('[data-back="welcome"]').addEventListener("click", () => showScreen("welcome"));
document.querySelector("[data-home]").addEventListener("click", (event) => {
  event.preventDefault();
  if (attempt?.status === "active") {
    showScreen("quiz");
    return;
  }
  showScreen("welcome");
});
document.getElementById("previous-button").addEventListener("click", () => displayQuestion(currentQuestion - 1));
document.getElementById("next-button").addEventListener("click", () => displayQuestion(currentQuestion + 1));
document.getElementById("submit-button").addEventListener("click", () => submitQuiz(false));
optionList.addEventListener("click", (event) => {
  const option = event.target.closest("[data-option]");
  if (option) selectAnswer(Number(option.dataset.option));
});
questionGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-question]");
  if (button) displayQuestion(Number(button.dataset.question));
});
document.getElementById("restart-button").addEventListener("click", () => {
  attempt = null;
  window.clearInterval(globalTimerInterval);
  window.clearInterval(questionTimerInterval);
  form.reset();
  clearError(formError);
  showScreen("welcome");
});

initialize();
