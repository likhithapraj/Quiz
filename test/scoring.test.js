const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { bonusForElapsedMs, scoreAnswer } = require("../scoring");
const questions = require("../quiz-questions");
const { createServer } = require("../server");

test("speed bonuses use exact millisecond thresholds", () => {
  const cases = [
    [0, 5],
    [10_000, 5],
    [10_001, 4],
    [20_000, 4],
    [20_001, 3],
    [30_000, 3],
    [30_001, 2],
    [40_000, 2],
    [40_001, 0],
    [Number.NaN, 0],
    [-1, 0]
  ];

  for (const [elapsedMs, expected] of cases) {
    assert.equal(bonusForElapsedMs(elapsedMs), expected, `elapsed=${elapsedMs}`);
  }
});

test("only correct answers earn a base point and speed bonus", () => {
  assert.deepEqual(scoreAnswer(2, 2, 8_000), { basePoints: 1, bonusPoints: 5 });
  for (const elapsedMs of [0, 10_000, 10_001, 20_000, 20_001, 30_000, 30_001, 40_000, 40_001]) {
    assert.deepEqual(scoreAnswer(1, 2, elapsedMs), { basePoints: 0, bonusPoints: 0 });
  }
  assert.deepEqual(scoreAnswer(null, 2, 0), { basePoints: 0, bonusPoints: 0 });

  const maximum = questions.reduce((sum, question) =>
    sum + scoreAnswer(question.answer, question.answer, 0).basePoints +
      scoreAnswer(question.answer, question.answer, 0).bonusPoints, 0);
  assert.equal(questions.length, 50);
  assert.equal(maximum, 300);
});

test("server keeps answer keys private and preserves first-answer timing across restart", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "quiz-arena-test-"));
  const databasePath = path.join(directory, "attempts.sqlite");
  let currentTime = 1_000_000;
  let server = createServer({ databasePath, now: () => currentTime });

  async function listen() {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }

  async function close() {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });

  let baseUrl = await listen();
  const publicQuestions = await fetch(`${baseUrl}/api/questions`).then((response) => response.json());
  assert.equal(publicQuestions.length, 50);
  assert.equal(Object.hasOwn(publicQuestions[0], "answer"), false);
  assert.equal((await fetch(`${baseUrl}/quiz-questions.js`)).status, 404);

  const createResponse = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Jordan Lee", college: "Northstar University", team: "Quiz Crew" })
  });
  assert.equal(createResponse.status, 201);
  const cookie = createResponse.headers.get("set-cookie").split(";")[0];
  const attempt = await createResponse.json();

  const request = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { Cookie: cookie, ...(options.headers || {}) }
  });
  const displayQuestion = (index) => request(
    `/api/attempts/${attempt.id}/questions/${index}/display`,
    { method: "POST" }
  );
  const answerQuestion = (index, optionIndex) => request(
    `/api/attempts/${attempt.id}/questions/${index}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionIndex })
    }
  );

  assert.equal((await answerQuestion(0, 0)).status, 409);
  await displayQuestion(49);
  currentTime += 2_000;
  await displayQuestion(0);
  currentTime += 3_000;
  const revisitedQuestion = await displayQuestion(49).then((response) => response.json());
  assert.equal(revisitedQuestion.elapsedMs, 5_000);
  await displayQuestion(0);
  currentTime += 7_000;
  const firstSelection = await answerQuestion(0, 0).then((response) => response.json());
  assert.equal(firstSelection.timeTakenMs, 10_000);
  assert.equal(firstSelection.basePoints, 0);
  assert.equal(firstSelection.bonusPoints, 0);

  currentTime += 5_000;
  const changedSelection = await answerQuestion(0, 1).then((response) => response.json());
  assert.equal(changedSelection.answerIndex, 1);
  assert.equal(changedSelection.timeTakenMs, 10_000);
  assert.equal(changedSelection.basePoints, 1);
  assert.equal(changedSelection.bonusPoints, 5);

  await close();
  server = createServer({ databasePath, now: () => currentTime });
  baseUrl = await listen();
  const restored = await request("/api/attempts/current").then((response) => response.json());
  assert.equal(restored.status, "active");
  assert.equal(restored.questions[0].timeTakenMs, 10_000);
  assert.equal(restored.questions[0].answerIndex, 1);
  assert.equal(restored.remainingMs, 30 * 60 * 1000 - 17_000);

  await displayQuestion(1);
  currentTime += 10_001;
  const secondAnswer = await answerQuestion(1, questions[1].answer).then((response) => response.json());
  assert.equal(secondAnswer.timeTakenMs, 10_001);
  assert.equal(secondAnswer.bonusPoints, 4);

  const submitted = await request(`/api/attempts/${attempt.id}/submit`, { method: "POST" })
    .then((response) => response.json());
  assert.equal(submitted.results.baseScore, 2);
  assert.equal(submitted.results.bonusScore, 9);
  assert.equal(submitted.results.totalScore, 11);
  assert.equal(submitted.results.maximumScore, 300);
  assert.equal(submitted.results.completionTimeMs, 27_001);
  assert.equal(submitted.questions[49].answerIndex, null);
  assert.equal(submitted.questions[49].timeTakenMs, 27_001);
  assert.equal(submitted.questions[2].timeTakenMs, 0);

  const secondCreate = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Taylor Chen", college: "Westbridge College", team: "" })
  });
  const secondCookie = secondCreate.headers.get("set-cookie").split(";")[0];
  const secondAttempt = await secondCreate.json();
  const secondRequest = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { Cookie: secondCookie, ...(options.headers || {}) }
  });

  await secondRequest(`/api/attempts/${secondAttempt.id}/questions/0/display`, { method: "POST" });
  currentTime += 5_001;
  await secondRequest(`/api/attempts/${secondAttempt.id}/questions/0/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionIndex: questions[0].answer })
  });
  await secondRequest(`/api/attempts/${secondAttempt.id}/questions/1/display`, { method: "POST" });
  currentTime += 10_001;
  await secondRequest(`/api/attempts/${secondAttempt.id}/questions/1/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionIndex: questions[1].answer })
  });
  await secondRequest(`/api/attempts/${secondAttempt.id}/submit`, { method: "POST" });

  const leaderboard = await fetch(`${baseUrl}/api/leaderboard`).then((response) => response.json());
  assert.equal(leaderboard.entries.length, 2);
  assert.equal(leaderboard.entries[0].name, "Taylor Chen");
  assert.equal(leaderboard.entries[0].totalScore, leaderboard.entries[1].totalScore);
  assert.ok(leaderboard.entries[0].completionTimeMs < leaderboard.entries[1].completionTimeMs);

  const thirdCreate = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Morgan Park", college: "Eastlake Institute", team: "" })
  });
  const thirdCookie = thirdCreate.headers.get("set-cookie").split(";")[0];
  const thirdAttempt = await thirdCreate.json();
  const thirdRequest = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { Cookie: thirdCookie, ...(options.headers || {}) }
  });

  await thirdRequest(`/api/attempts/${thirdAttempt.id}/questions/0/display`, { method: "POST" });
  currentTime += 40_001;
  await thirdRequest(`/api/attempts/${thirdAttempt.id}/questions/0/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionIndex: questions[0].answer })
  });
  await thirdRequest(`/api/attempts/${thirdAttempt.id}/questions/1/display`, { method: "POST" });
  currentTime += 40_001;
  const thirdResult = await thirdRequest(`/api/attempts/${thirdAttempt.id}/questions/1/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optionIndex: questions[1].answer })
  }).then((response) => response.json());
  assert.equal(thirdResult.bonusPoints, 0);
  await thirdRequest(`/api/attempts/${thirdAttempt.id}/submit`, { method: "POST" });

  const perfectCreate = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Avery Quinn", college: "Summit University", team: "" })
  });
  const perfectCookie = perfectCreate.headers.get("set-cookie").split(";")[0];
  const perfectAttempt = await perfectCreate.json();
  const perfectRequest = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { Cookie: perfectCookie, ...(options.headers || {}) }
  });

  for (let index = 0; index < questions.length; index += 1) {
    await perfectRequest(`/api/attempts/${perfectAttempt.id}/questions/${index}/display`, { method: "POST" });
    const response = await perfectRequest(`/api/attempts/${perfectAttempt.id}/questions/${index}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionIndex: questions[index].answer })
    });
    assert.equal(response.status, 200);
  }
  const perfectResult = await perfectRequest(`/api/attempts/${perfectAttempt.id}/submit`, { method: "POST" })
    .then((response) => response.json());
  assert.equal(perfectResult.results.baseScore, 50);
  assert.equal(perfectResult.results.bonusScore, 250);
  assert.equal(perfectResult.results.totalScore, 300);

  const rankedLeaderboard = await fetch(`${baseUrl}/api/leaderboard`).then((response) => response.json());
  assert.equal(rankedLeaderboard.entries.length, 4);
  assert.deepEqual(rankedLeaderboard.entries.map((entry) => entry.totalScore), [300, 11, 11, 2]);
  assert.equal(rankedLeaderboard.entries[0].name, "Avery Quinn");
  assert.equal(rankedLeaderboard.entries[3].name, "Morgan Park");
});

test("the server-enforced global deadline survives refresh and finalizes an expired attempt", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "quiz-arena-deadline-"));
  let currentTime = 8_000_000;
  const server = createServer({
    databasePath: path.join(directory, "attempts.sqlite"),
    now: () => currentTime
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  const created = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Deadline Test", college: "Clockwork College", team: "" })
  });
  const cookie = created.headers.get("set-cookie").split(";")[0];
  const getCurrentAttempt = () => fetch(`${baseUrl}/api/attempts/current`, {
    headers: { Cookie: cookie }
  }).then((response) => response.json());

  currentTime += 29 * 60 * 1000;
  const afterRefresh = await getCurrentAttempt();
  assert.equal(afterRefresh.status, "active");
  assert.equal(afterRefresh.remainingMs, 60_000);

  currentTime += 60_001;
  const expired = await getCurrentAttempt();
  assert.equal(expired.status, "completed");
  assert.equal(expired.remainingMs, 0);
  assert.equal(expired.results.completionTimeMs, 30 * 60 * 1000);
  assert.equal(expired.results.totalScore, 0);
});
