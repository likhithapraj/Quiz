function bonusForElapsedMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  if (elapsedMs <= 10_000) return 5;
  if (elapsedMs <= 20_000) return 4;
  if (elapsedMs <= 30_000) return 3;
  if (elapsedMs <= 40_000) return 2;
  return 0;
}

function scoreAnswer(selectedIndex, correctIndex, elapsedMs) {
  if (!Number.isInteger(selectedIndex) || selectedIndex !== correctIndex) {
    return { basePoints: 0, bonusPoints: 0 };
  }

  return { basePoints: 1, bonusPoints: bonusForElapsedMs(elapsedMs) };
}

module.exports = { bonusForElapsedMs, scoreAnswer };
