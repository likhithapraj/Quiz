const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const questions = require("./quiz-questions");
const { scoreAnswer } = require("./scoring");

const QUESTION_COUNT = questions.length;
const QUIZ_DURATION_MS = 30 * 60 * 1000;
const COOKIE_NAME = "quiz_attempt";
const DEFAULT_DATABASE_PATH = path.join(__dirname, "quiz-arena.sqlite");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"]
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([name]) => name));
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 16_384) {
        tooLarge = true;
        body = "";
        reject(new HttpError(413, "BODY_TOO_LARGE", "Request body is too large."));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (!body) {
        reject(new HttpError(400, "INVALID_BODY", "A JSON request body is required."));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "The request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createServer({ databasePath = DEFAULT_DATABASE_PATH, now = Date.now } = {}) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL,
      participant_name TEXT NOT NULL,
      college_name TEXT NOT NULL,
      team_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      completion_time_ms INTEGER,
      current_question INTEGER NOT NULL DEFAULT 0,
      base_score INTEGER NOT NULL DEFAULT 0,
      bonus_score INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS question_responses (
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_index INTEGER NOT NULL CHECK (question_index >= 0 AND question_index < ${QUESTION_COUNT}),
      started_at_ms INTEGER,
      first_answered_at_ms INTEGER,
      answer_index INTEGER,
      elapsed_ms INTEGER,
      base_points INTEGER NOT NULL DEFAULT 0,
      bonus_points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (attempt_id, question_index)
    );
    CREATE INDEX IF NOT EXISTS leaderboard_order
      ON attempts(status, total_score DESC, completion_time_ms ASC, completed_at_ms ASC);
  `);

  function getAttemptByToken(token) {
    if (!token) throw new HttpError(404, "NO_ACTIVE_ATTEMPT", "No active quiz attempt was found.");
    const attempt = db.prepare("SELECT * FROM attempts WHERE session_hash = ?").get(hashToken(token));
    if (!attempt) throw new HttpError(404, "NO_ACTIVE_ATTEMPT", "No active quiz attempt was found.");
    return attempt;
  }

  function getAttemptById(id, token) {
    const attempt = getAttemptByToken(token);
    if (attempt.id !== id) throw new HttpError(404, "ATTEMPT_NOT_FOUND", "Quiz attempt not found.");
    return attempt;
  }

  function finalizeAttempt(attempt, finishedAtMs) {
    if (attempt.status === "completed") return attempt;
    const completedAtMs = Math.min(finishedAtMs, attempt.started_at_ms + QUIZ_DURATION_MS);
    db.prepare(`
      UPDATE question_responses
      SET elapsed_ms = CASE
        WHEN started_at_ms IS NULL THEN 0
        ELSE MAX(0, ? - started_at_ms)
      END
      WHERE attempt_id = ? AND first_answered_at_ms IS NULL AND elapsed_ms IS NULL
    `).run(completedAtMs, attempt.id);
    const responses = db.prepare(
      "SELECT question_index, answer_index, base_points, bonus_points FROM question_responses WHERE attempt_id = ?"
    ).all(attempt.id);
    const baseScore = responses.reduce((sum, response) => sum + response.base_points, 0);
    const bonusScore = responses.reduce((sum, response) => sum + response.bonus_points, 0);
    const totalScore = baseScore + bonusScore;
    const completionTimeMs = Math.max(0, completedAtMs - attempt.started_at_ms);

    db.prepare(`
      UPDATE attempts
      SET status = 'completed', completed_at_ms = ?, completion_time_ms = ?,
          base_score = ?, bonus_score = ?, total_score = ?
      WHERE id = ? AND status = 'active'
    `).run(completedAtMs, completionTimeMs, baseScore, bonusScore, totalScore, attempt.id);

    return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id);
  }

  function finishIfExpired(attempt, currentTime = now()) {
    if (attempt.status === "active" && currentTime >= attempt.started_at_ms + QUIZ_DURATION_MS) {
      return finalizeAttempt(attempt, attempt.started_at_ms + QUIZ_DURATION_MS);
    }
    return attempt;
  }

  function buildAttemptPayload(attempt, currentTime = now()) {
    const rows = db.prepare(
      "SELECT * FROM question_responses WHERE attempt_id = ? ORDER BY question_index"
    ).all(attempt.id);
    const questionStates = rows.map((row) => ({
      index: row.question_index,
      startedAtMs: row.started_at_ms,
      firstAnsweredAtMs: row.first_answered_at_ms,
      answerIndex: row.answer_index,
      timeTakenMs: row.elapsed_ms,
      elapsedMs: row.elapsed_ms ?? (row.started_at_ms === null ? 0 : Math.max(0, currentTime - row.started_at_ms)),
      basePoints: row.base_points,
      bonusPoints: row.bonus_points
    }));
    const completed = attempt.status === "completed";
    const correctCount = questionStates.filter((state, index) =>
      state.answerIndex === questions[index].answer
    ).length;

    return {
      id: attempt.id,
      participant: {
        name: attempt.participant_name,
        college: attempt.college_name,
        team: attempt.team_name
      },
      status: attempt.status,
      currentQuestion: attempt.current_question,
      serverNowMs: currentTime,
      remainingMs: completed
        ? 0
        : Math.max(0, attempt.started_at_ms + QUIZ_DURATION_MS - currentTime),
      questions: questionStates,
      results: completed ? {
        baseScore: attempt.base_score,
        bonusScore: attempt.bonus_score,
        totalScore: attempt.total_score,
        maximumScore: QUESTION_COUNT * 6,
        correctCount,
        incorrectCount: QUESTION_COUNT - correctCount,
        completionTimeMs: attempt.completion_time_ms,
        accuracy: Math.round((correctCount / QUESTION_COUNT) * 100)
      } : null
    };
  }

  function requireActiveAttempt(id, token) {
    let attempt = getAttemptById(id, token);
    attempt = finishIfExpired(attempt);
    if (attempt.status !== "active") {
      throw new HttpError(410, "ATTEMPT_FINISHED", "The quiz attempt has ended.");
    }
    return attempt;
  }

  function validateQuestionIndex(value) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= QUESTION_COUNT) {
      throw new HttpError(400, "INVALID_QUESTION", "Question number is invalid.");
    }
    return index;
  }

  function leaderboard() {
    return db.prepare(`
      SELECT participant_name AS name, college_name AS college, team_name AS team,
             total_score AS totalScore, base_score AS baseScore, bonus_score AS bonusScore,
             completion_time_ms AS completionTimeMs
      FROM attempts
      WHERE status = 'completed'
      ORDER BY total_score DESC, completion_time_ms ASC, completed_at_ms ASC, id ASC
      LIMIT 10
    `).all().map((entry, index) => ({ rank: index + 1, ...entry }));
  }

  async function handleApi(request, response, url) {
    const origin = request.headers.origin;
    if (origin) {
      const requestOrigin = process.env.QUIZ_ORIGIN ||
        `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
      if (origin !== requestOrigin) throw new HttpError(403, "ORIGIN_REJECTED", "Request origin is not allowed.");
    }

    if (request.method === "GET" && url.pathname === "/api/questions") {
      return sendJson(response, 200, questions.map(({ category, question, options }, index) => ({
        index, category, question, options
      })));
    }

    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      return sendJson(response, 200, { entries: leaderboard() });
    }

    if (request.method === "POST" && url.pathname === "/api/attempts") {
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "JSON_REQUIRED", "Send registration details as JSON.");
      }
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "INVALID_BODY", "Registration details must be a JSON object.");
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const college = typeof body.college === "string" ? body.college.trim() : "";
      const team = typeof body.team === "string" ? body.team.trim() : "";
      if (!name || name.length > 60 || !college || college.length > 100 || team.length > 60) {
        throw new HttpError(400, "INVALID_PARTICIPANT", "Enter a participant name and college, with a team name up to 60 characters.");
      }

      const token = crypto.randomBytes(32).toString("base64url");
      const attemptId = crypto.randomUUID();
      const startedAtMs = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO attempts (id, session_hash, participant_name, college_name, team_name, status, started_at_ms)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
        `).run(attemptId, hashToken(token), name, college, team, startedAtMs);
        const insertQuestion = db.prepare(
          "INSERT INTO question_responses (attempt_id, question_index) VALUES (?, ?)"
        );
        for (let index = 0; index < QUESTION_COUNT; index += 1) insertQuestion.run(attemptId, index);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const secure = process.env.NODE_ENV === "production" || request.socket.encrypted;
      const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? "; Secure" : ""}`;
      const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      return sendJson(response, 201, buildAttemptPayload(attempt, startedAtMs), { "Set-Cookie": cookie });
    }

    if (request.method === "GET" && url.pathname === "/api/attempts/current") {
      const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
      let attempt = getAttemptByToken(token);
      attempt = finishIfExpired(attempt);
      return sendJson(response, 200, buildAttemptPayload(attempt));
    }

    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const displayMatch = url.pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/questions\/(\d+)\/display$/);
    if (request.method === "POST" && displayMatch) {
      const attempt = requireActiveAttempt(displayMatch[1], token);
      const index = validateQuestionIndex(displayMatch[2]);
      const currentTime = now();
      db.prepare("UPDATE attempts SET current_question = ? WHERE id = ?").run(index, attempt.id);
      db.prepare(`
        UPDATE question_responses
        SET started_at_ms = COALESCE(started_at_ms, ?)
        WHERE attempt_id = ? AND question_index = ?
      `).run(currentTime, attempt.id, index);
      const refreshedAttempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id);
      const payload = buildAttemptPayload(refreshedAttempt, currentTime);
      return sendJson(response, 200, payload.questions[index]);
    }

    const answerMatch = url.pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/questions\/(\d+)\/answer$/);
    if (request.method === "POST" && answerMatch) {
      const attempt = requireActiveAttempt(answerMatch[1], token);
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "JSON_REQUIRED", "Send the selected answer as JSON.");
      }
      const index = validateQuestionIndex(answerMatch[2]);
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "INVALID_BODY", "The selected answer must be a JSON object.");
      }
      const optionIndex = body.optionIndex;
      if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) ||
          optionIndex < 0 || optionIndex >= questions[index].options.length) {
        throw new HttpError(400, "INVALID_ANSWER", "Selected option is invalid.");
      }
      const currentTime = now();
      const state = db.prepare(`
        SELECT started_at_ms, first_answered_at_ms, elapsed_ms
        FROM question_responses
        WHERE attempt_id = ? AND question_index = ?
      `).get(attempt.id, index);
      if (state.started_at_ms === null) {
        throw new HttpError(409, "QUESTION_NOT_STARTED", "Display the question before answering it.");
      }
      const isFirstSelection = state.first_answered_at_ms === null;
      const elapsedMs = isFirstSelection
        ? Math.max(0, currentTime - state.started_at_ms)
        : state.elapsed_ms;
      const points = scoreAnswer(optionIndex, questions[index].answer, elapsedMs);

      if (isFirstSelection) {
        db.prepare(`
          UPDATE question_responses
          SET first_answered_at_ms = ?, elapsed_ms = ?, answer_index = ?,
              base_points = ?, bonus_points = ?
          WHERE attempt_id = ? AND question_index = ?
        `).run(currentTime, elapsedMs, optionIndex, points.basePoints, points.bonusPoints, attempt.id, index);
      } else {
        db.prepare(`
          UPDATE question_responses
          SET answer_index = ?, base_points = ?, bonus_points = ?
          WHERE attempt_id = ? AND question_index = ?
        `).run(optionIndex, points.basePoints, points.bonusPoints, attempt.id, index);
      }

      const updated = db.prepare("SELECT * FROM question_responses WHERE attempt_id = ? AND question_index = ?")
        .get(attempt.id, index);
      return sendJson(response, 200, {
        index,
        startedAtMs: updated.started_at_ms,
        firstAnsweredAtMs: updated.first_answered_at_ms,
        answerIndex: updated.answer_index,
        timeTakenMs: updated.elapsed_ms,
        elapsedMs: updated.elapsed_ms,
        basePoints: updated.base_points,
        bonusPoints: updated.bonus_points
      });
    }

    const submitMatch = url.pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/submit$/);
    if (request.method === "POST" && submitMatch) {
      let attempt = getAttemptById(submitMatch[1], token);
      attempt = finishIfExpired(attempt);
      if (attempt.status === "active") attempt = finalizeAttempt(attempt, now());
      return sendJson(response, 200, buildAttemptPayload(attempt));
    }

    throw new HttpError(404, "NOT_FOUND", "API route not found.");
  }

  const server = http.createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );

    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch((error) => {
        if (response.headersSent || response.destroyed) return;
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.message, code: error.code });
          return;
        }
        console.error("Quiz API request failed:", error);
        sendJson(response, 500, { error: "An unexpected server error occurred.", code: "INTERNAL_ERROR" });
      });
      return;
    }

    const file = STATIC_FILES[url.pathname];
    if (request.method !== "GET" || !file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    fs.readFile(path.join(__dirname, file[0]), (error, contents) => {
      if (error) {
        console.error("Could not read frontend file:", error);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Could not load the application.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-cache"
      });
      response.end(contents);
    });
  });

  server.on("close", () => db.close());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer({
    databasePath: process.env.QUIZ_DB_PATH || DEFAULT_DATABASE_PATH
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Quiz Arena is running at http://${host}:${address.port}`);
  });
}

module.exports = { createServer };
