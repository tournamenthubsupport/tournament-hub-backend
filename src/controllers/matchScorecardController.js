import { getMongoDB, sql } from "../config/db.js";

const SCORECARD_COLLECTION = "match_scorecards";
const VALID_TOKENS = new Set([
  "0",
  "1",
  "2",
  "3",
  "4",
  "6",
  "wk",
  "w",
  "runout",
  "wd",
  "wd+1",
  "wd+2",
  "wd+3",
  "wd+4",
  "wd+5",
  "nb",
  "nb+1",
  "nb+2",
  "nb+3",
  "nb+4",
  "nb+5",
  "nb+6",
]);

function getScorecardCollectionOrRespond(res) {
  try {
    const db = getMongoDB();
    return db.collection(SCORECARD_COLLECTION);
  } catch {
    res.status(503).json({
      error:
        "Scorecard service unavailable. Please try again after MongoDB reconnects.",
    });
    return null;
  }
}

const toRows = (result) => {
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result)) return result;
  return [];
};

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

async function getMatchContext(matchId) {
  const result = await sql.query(
    `SELECT
       m.id,
       m.tournament_id,
       m.next_match_id,
       m.next_slot,
       m.home_team_id,
       ht.name AS home_team_name,
       m.away_team_id,
       at.name AS away_team_name,
       m.batting_team_id,
       bt.name AS batting_team_name,
       m.fielding_team_id,
       ft.name AS fielding_team_name,
       m.status,
       t.organiser_contact
     FROM matches m
     INNER JOIN tournaments t ON t.id = m.tournament_id
     LEFT JOIN teams ht ON ht.id = m.home_team_id
     LEFT JOIN teams at ON at.id = m.away_team_id
     LEFT JOIN teams bt ON bt.id = m.batting_team_id
     LEFT JOIN teams ft ON ft.id = m.fielding_team_id
     WHERE m.id = $1
     LIMIT 1`,
    [matchId],
  );

  const rows = toRows(result);
  return rows.length > 0 ? rows[0] : null;
}

async function getTeamSquad(teamId) {
  if (!teamId) return [];

  const result = await sql.query(
    `SELECT
       p.id AS "playerId",
       p.name,
       COALESCE(tp.is_captain, false) AS "isCaptain",
       COALESCE(tp.is_vicecaptain, false) AS "isViceCaptain"
     FROM team_players tp
     INNER JOIN players p ON p.id = tp.player_id
     WHERE tp.team_id = $1
     ORDER BY p.name ASC`,
    [teamId],
  );

  return toRows(result);
}

function countLegalBalls(events) {
  return events.filter(
    (event) =>
      !["wide", "no_ball"].includes(
        String(event.extraType || "").toLowerCase(),
      ),
  ).length;
}

function sumRuns(events) {
  return events.reduce((sum, event) => sum + Number(event.runs || 0), 0);
}

function sumWickets(events) {
  return events.reduce((sum, event) => sum + (event.wicket ? 1 : 0), 0);
}

function toOvers(legalBalls) {
  const overs = Math.floor(legalBalls / 6);
  const balls = legalBalls % 6;
  return `${overs}.${balls}`;
}

function tokenToEvent(token) {
  if (["0", "1", "2", "3", "4", "6"].includes(token)) {
    return {
      runs: Number(token),
      batterRuns: Number(token),
      extraRuns: 0,
      wicket: false,
      dismissalType: null,
      extraType: null,
      legalBall: true,
      label: `${token}R`,
    };
  }

  if (token === "wd") {
    return {
      runs: 1,
      batterRuns: 0,
      extraRuns: 1,
      wicket: false,
      dismissalType: null,
      extraType: "wide",
      legalBall: false,
      label: "WD",
    };
  }

  if (token.startsWith("wd+")) {
    const suffixRuns = Number(token.split("+")[1] || 0);
    const totalRuns = 1 + suffixRuns;
    return {
      runs: totalRuns,
      batterRuns: 0,
      extraRuns: totalRuns,
      wicket: false,
      dismissalType: null,
      extraType: "wide",
      legalBall: false,
      label: `WD+${suffixRuns}`,
    };
  }

  if (token === "nb") {
    return {
      runs: 1,
      batterRuns: 0,
      extraRuns: 1,
      wicket: false,
      dismissalType: null,
      extraType: "no_ball",
      legalBall: false,
      label: "NB",
    };
  }

  if (token.startsWith("nb+")) {
    const suffixRuns = Number(token.split("+")[1] || 0);
    return {
      runs: 1 + suffixRuns,
      batterRuns: suffixRuns,
      extraRuns: 1,
      wicket: false,
      dismissalType: null,
      extraType: "no_ball",
      legalBall: false,
      label: `NB+${suffixRuns}`,
    };
  }

  if (token === "runout") {
    return {
      runs: 0,
      batterRuns: 0,
      extraRuns: 0,
      wicket: true,
      dismissalType: "runout",
      extraType: null,
      legalBall: true,
      label: "Runout",
    };
  }

  return {
    runs: 0,
    batterRuns: 0,
    extraRuns: 0,
    wicket: true,
    dismissalType: "wicket",
    extraType: null,
    legalBall: true,
    label: "WK",
  };
}

function rotateStrike(strikerPlayerId, nonStrikerPlayerId) {
  return {
    strikerPlayerId: nonStrikerPlayerId,
    nonStrikerPlayerId: strikerPlayerId,
  };
}

function getNextPlayerState({
  strikerPlayerId,
  nonStrikerPlayerId,
  eventMeta,
  completedOver,
}) {
  if (eventMeta.dismissalType) {
    return {
      strikerPlayerId: null,
      nonStrikerPlayerId,
    };
  }

  let nextStrikerPlayerId = strikerPlayerId;
  let nextNonStrikerPlayerId = nonStrikerPlayerId;

  if (eventMeta.runs % 2 === 1) {
    const rotated = rotateStrike(nextStrikerPlayerId, nextNonStrikerPlayerId);
    nextStrikerPlayerId = rotated.strikerPlayerId;
    nextNonStrikerPlayerId = rotated.nonStrikerPlayerId;
  }

  if (completedOver) {
    const rotated = rotateStrike(nextStrikerPlayerId, nextNonStrikerPlayerId);
    nextStrikerPlayerId = rotated.strikerPlayerId;
    nextNonStrikerPlayerId = rotated.nonStrikerPlayerId;
  }

  return {
    strikerPlayerId: nextStrikerPlayerId,
    nonStrikerPlayerId: nextNonStrikerPlayerId,
  };
}

function normalizeContact(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .slice(-10);
}

async function isMatchCaptainOrViceCaptain(matchContext, normalizedContact) {
  if (!normalizedContact) {
    return false;
  }

  const teamIds = [
    Number(matchContext.home_team_id || 0),
    Number(matchContext.away_team_id || 0),
  ].filter((teamId) => Number.isInteger(teamId) && teamId > 0);

  if (teamIds.length === 0) {
    return false;
  }

  const result = await sql.query(
    `SELECT 1
     FROM team_players tp
     INNER JOIN players p ON p.id = tp.player_id
     WHERE tp.team_id = ANY($1::int[])
       AND (COALESCE(tp.is_captain, false) = true OR COALESCE(tp.is_vicecaptain, false) = true)
       AND RIGHT(REGEXP_REPLACE(COALESCE(p.mobile, ''), '\\D', '', 'g'), 10) = $2
     LIMIT 1`,
    [teamIds, normalizedContact],
  );

  return toRows(result).length > 0;
}

async function hasScorecardEditorAccess(matchContext, actorContact) {
  const normalizedActorContact = normalizeContact(actorContact);
  const normalizedOrganiserContact = normalizeContact(
    matchContext.organiser_contact,
  );

  if (!normalizedActorContact) {
    return false;
  }

  if (normalizedActorContact === normalizedOrganiserContact) {
    return true;
  }

  return isMatchCaptainOrViceCaptain(matchContext, normalizedActorContact);
}

async function assertScorecardEditor(matchContext, actorContact, res) {
  const canEdit = await hasScorecardEditorAccess(matchContext, actorContact);
  if (canEdit) {
    return true;
  }

  res.status(403).json({
    error:
      "Only tournament organiser, captain, or vice-captain of this match can update scorecard.",
  });
  return false;
}

function getCurrentInningsNumber(scorecard) {
  return Number(scorecard?.currentInnings || 1) === 2 ? 2 : 1;
}

function getInningsField(currentInnings) {
  return currentInnings === 2 ? "inningsTwo" : "inningsOne";
}

function buildInningsState({
  battingTeamId,
  battingTeamName,
  fieldingTeamId,
  fieldingTeamName,
  previousInnings,
}) {
  return {
    battingTeamId,
    battingTeamName,
    fieldingTeamId,
    fieldingTeamName,
    events: Array.isArray(previousInnings?.events)
      ? previousInnings.events
      : [],
    completedAt: previousInnings?.completedAt || null,
  };
}

function normalizeLegacyScorecard(scorecard) {
  if (!scorecard || scorecard.inningsOne || scorecard.inningsTwo) {
    return scorecard;
  }

  const legacyEvents = Array.isArray(scorecard?.innings?.events)
    ? scorecard.innings.events
    : [];
  const completedLegacyInnings =
    String(scorecard?.status || "").toLowerCase() === "completed";

  return {
    ...scorecard,
    currentInnings: completedLegacyInnings ? 2 : 1,
    currentBattingTeamId: completedLegacyInnings
      ? Number(scorecard.fieldingTeamId || 0)
      : Number(scorecard.battingTeamId || 0),
    currentBattingTeamName: completedLegacyInnings
      ? scorecard.fieldingTeamName || null
      : scorecard.battingTeamName || null,
    currentFieldingTeamId: completedLegacyInnings
      ? Number(scorecard.battingTeamId || 0)
      : Number(scorecard.fieldingTeamId || 0),
    currentFieldingTeamName: completedLegacyInnings
      ? scorecard.battingTeamName || null
      : scorecard.fieldingTeamName || null,
    status: completedLegacyInnings ? "innings_break" : scorecard.status,
    strikerPlayerId: completedLegacyInnings
      ? null
      : (scorecard.strikerPlayerId ?? null),
    nonStrikerPlayerId: completedLegacyInnings
      ? null
      : (scorecard.nonStrikerPlayerId ?? null),
    bowlerPlayerId: completedLegacyInnings
      ? null
      : (scorecard.bowlerPlayerId ?? null),
    inningsOne: {
      battingTeamId: Number(scorecard.battingTeamId || 0),
      battingTeamName: scorecard.battingTeamName || null,
      fieldingTeamId: Number(scorecard.fieldingTeamId || 0),
      fieldingTeamName: scorecard.fieldingTeamName || null,
      strikerPlayerId: scorecard.strikerPlayerId ?? null,
      nonStrikerPlayerId: scorecard.nonStrikerPlayerId ?? null,
      bowlerPlayerId: scorecard.bowlerPlayerId ?? null,
      events: legacyEvents,
      completedAt: completedLegacyInnings
        ? scorecard.updatedAt || scorecard.createdAt || new Date()
        : null,
    },
    inningsTwo: null,
  };
}
function replayInningsState({ events }) {
  return {
    legalBalls: countLegalBalls(Array.isArray(events) ? events : []),
  };
}

function buildResultSummary(scorecard) {
  const inningsOneEvents = Array.isArray(scorecard?.inningsOne?.events)
    ? scorecard.inningsOne.events
    : [];
  const inningsTwoEvents = Array.isArray(scorecard?.inningsTwo?.events)
    ? scorecard.inningsTwo.events
    : [];

  const inningsOneRuns = sumRuns(inningsOneEvents);
  const inningsTwoRuns = sumRuns(inningsTwoEvents);
  const inningsTwoWickets = sumWickets(inningsTwoEvents);

  if (inningsTwoRuns > inningsOneRuns) {
    const wicketsRemaining = Math.max(0, 10 - inningsTwoWickets);
    return {
      winnerTeamId: Number(scorecard?.inningsTwo?.battingTeamId || 0) || null,
      winnerTeamName: scorecard?.inningsTwo?.battingTeamName || null,
      loserTeamId: Number(scorecard?.inningsOne?.battingTeamId || 0) || null,
      loserTeamName: scorecard?.inningsOne?.battingTeamName || null,
      margin: `${wicketsRemaining} wicket${wicketsRemaining === 1 ? "" : "s"}`,
      resultType: "wickets",
      inningsOneRuns,
      inningsTwoRuns,
    };
  }

  if (inningsOneRuns > inningsTwoRuns) {
    const runMargin = inningsOneRuns - inningsTwoRuns;
    return {
      winnerTeamId: Number(scorecard?.inningsOne?.battingTeamId || 0) || null,
      winnerTeamName: scorecard?.inningsOne?.battingTeamName || null,
      loserTeamId: Number(scorecard?.inningsTwo?.battingTeamId || 0) || null,
      loserTeamName: scorecard?.inningsTwo?.battingTeamName || null,
      margin: `${runMargin} run${runMargin === 1 ? "" : "s"}`,
      resultType: "runs",
      inningsOneRuns,
      inningsTwoRuns,
    };
  }

  return {
    winnerTeamId: null,
    winnerTeamName: null,
    loserTeamId: null,
    loserTeamName: null,
    margin: "Match tied",
    resultType: "tie",
    inningsOneRuns,
    inningsTwoRuns,
  };
}

function buildInningsSummary(inningsState) {
  const events = Array.isArray(inningsState?.events) ? inningsState.events : [];
  const legalBalls = countLegalBalls(events);

  return {
    ...(inningsState || {}),
    runs: sumRuns(events),
    wickets: sumWickets(events),
    legalBalls,
    overs: toOvers(legalBalls),
    // Completed matches are stored as summary-only to save MongoDB space.
    events: [],
  };
}

function buildCompactCompletedScorecard(scorecard) {
  const inningsOneEvents = Array.isArray(scorecard?.inningsOne?.events)
    ? scorecard.inningsOne.events
    : [];
  const inningsTwoEvents = Array.isArray(scorecard?.inningsTwo?.events)
    ? scorecard.inningsTwo.events
    : [];

  const inningsOne = buildInningsSummary(scorecard?.inningsOne || {});
  const inningsTwo = buildInningsSummary(scorecard?.inningsTwo || {});

  const resultSummary =
    scorecard?.resultSummary ||
    buildResultSummary({
      ...scorecard,
      inningsOne: {
        ...(scorecard?.inningsOne || {}),
        events: inningsOneEvents,
      },
      inningsTwo: {
        ...(scorecard?.inningsTwo || {}),
        events: inningsTwoEvents,
      },
    });

  return {
    ...scorecard,
    status: "completed",
    currentInnings: 2,
    inningsOne,
    inningsTwo,
    resultSummary,
    updatedAt: new Date(),
  };
}

function buildScorecardUpdate({ scorecard, currentInnings, updatedEvents }) {
  const oversLimit = Number(scorecard?.oversLimit || 0);
  const inningsField = getInningsField(currentInnings);
  const currentInningsState = scorecard?.[inningsField] || {};
  const replayed = replayInningsState({
    events: updatedEvents,
  });

  const inningsOneEvents =
    currentInnings === 1
      ? updatedEvents
      : Array.isArray(scorecard?.inningsOne?.events)
        ? scorecard.inningsOne.events
        : [];
  const inningsTwoEvents =
    currentInnings === 2
      ? updatedEvents
      : Array.isArray(scorecard?.inningsTwo?.events)
        ? scorecard.inningsTwo.events
        : [];

  const firstInningsRuns = sumRuns(inningsOneEvents);
  const chaseAchieved =
    currentInnings === 2 && sumRuns(inningsTwoEvents) > firstInningsRuns;
  const inningsCompleted =
    replayed.legalBalls >= oversLimit * 6 || chaseAchieved;

  const inningsStatePayload = {
    ...currentInningsState,
    battingTeamId: Number(
      currentInningsState?.battingTeamId ||
        scorecard?.currentBattingTeamId ||
        0,
    ),
    battingTeamName: String(
      currentInningsState?.battingTeamName ||
        scorecard?.currentBattingTeamName ||
        "",
    ),
    fieldingTeamId: Number(
      currentInningsState?.fieldingTeamId ||
        scorecard?.currentFieldingTeamId ||
        0,
    ),
    fieldingTeamName: String(
      currentInningsState?.fieldingTeamName ||
        scorecard?.currentFieldingTeamName ||
        "",
    ),
    events: updatedEvents,
    completedAt: inningsCompleted ? new Date() : null,
  };

  if (currentInnings === 1 && inningsCompleted) {
    return {
      updatePayload: {
        currentInnings: 2,
        status: "innings_break",
        currentBattingTeamId: Number(
          scorecard?.currentFieldingTeamId ||
            currentInningsState?.fieldingTeamId ||
            0,
        ),
        currentBattingTeamName: String(
          scorecard?.currentFieldingTeamName ||
            currentInningsState?.fieldingTeamName ||
            "",
        ),
        currentFieldingTeamId: Number(
          scorecard?.currentBattingTeamId ||
            currentInningsState?.battingTeamId ||
            0,
        ),
        currentFieldingTeamName: String(
          scorecard?.currentBattingTeamName ||
            currentInningsState?.battingTeamName ||
            "",
        ),
        [inningsField]: inningsStatePayload,
        updatedAt: new Date(),
      },
      inningsCompleted: true,
      scorecardStatus: "innings_break",
      currentInnings: 2,
      resultSummary: null,
    };
  }

  if (currentInnings === 2 && inningsCompleted) {
    const resultSummary = buildResultSummary({
      ...scorecard,
      inningsOne: {
        ...(scorecard?.inningsOne || {}),
        events: inningsOneEvents,
      },
      inningsTwo: {
        ...(scorecard?.inningsTwo || {}),
        events: inningsTwoEvents,
        battingTeamId: inningsStatePayload.battingTeamId,
        battingTeamName: inningsStatePayload.battingTeamName,
      },
    });

    const compactCompletedScorecard = buildCompactCompletedScorecard({
      ...scorecard,
      status: "completed",
      currentInnings: 2,
      resultSummary,
      [inningsField]: inningsStatePayload,
    });

    return {
      updatePayload: compactCompletedScorecard,
      inningsCompleted: true,
      scorecardStatus: "completed",
      currentInnings: 2,
      resultSummary: compactCompletedScorecard.resultSummary,
    };
  }

  return {
    updatePayload: {
      currentInnings,
      status: "in_progress",
      [inningsField]: inningsStatePayload,
      updatedAt: new Date(),
    },
    inningsCompleted: false,
    scorecardStatus: "in_progress",
    currentInnings,
    resultSummary: null,
  };
}

export async function getMatchScorecard(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const viewerContact = String(req.query?.viewer_contact || "");
    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    let scorecard = null;

    try {
      const db = getMongoDB();
      const collection = db.collection(SCORECARD_COLLECTION);
      scorecard = normalizeLegacyScorecard(
        await collection.findOne({ matchId }),
      );
    } catch (error) {
      console.warn(
        `Scorecard read unavailable for match ${matchId}: MongoDB is not connected.`,
        error?.message || error,
      );
    }

    const currentBattingTeamId =
      Number(
        scorecard?.currentBattingTeamId || matchContext.batting_team_id || 0,
      ) || null;
    const currentFieldingTeamId =
      Number(
        scorecard?.currentFieldingTeamId || matchContext.fielding_team_id || 0,
      ) || null;
    const currentBattingTeamName =
      scorecard?.currentBattingTeamName ||
      (currentBattingTeamId === Number(matchContext.home_team_id || 0)
        ? matchContext.home_team_name
        : currentBattingTeamId === Number(matchContext.away_team_id || 0)
          ? matchContext.away_team_name
          : matchContext.batting_team_name);
    const currentFieldingTeamName =
      scorecard?.currentFieldingTeamName ||
      (currentFieldingTeamId === Number(matchContext.home_team_id || 0)
        ? matchContext.home_team_name
        : currentFieldingTeamId === Number(matchContext.away_team_id || 0)
          ? matchContext.away_team_name
          : matchContext.fielding_team_name);

    const canEdit = await hasScorecardEditorAccess(matchContext, viewerContact);

    return res.status(200).json({
      match: {
        id: matchContext.id,
        tournamentId: matchContext.tournament_id,
        status: matchContext.status,
        homeTeamId: matchContext.home_team_id,
        homeTeamName: matchContext.home_team_name,
        awayTeamId: matchContext.away_team_id,
        awayTeamName: matchContext.away_team_name,
        battingTeamId: currentBattingTeamId,
        battingTeamName: currentBattingTeamName,
        fieldingTeamId: currentFieldingTeamId,
        fieldingTeamName: currentFieldingTeamName,
      },
      squads: {},
      scorecard: scorecard || null,
      permissions: {
        canEdit,
      },
    });
  } catch (error) {
    console.error("Error fetching match scorecard:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function setupMatchScorecard(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const oversLimit = Number(req.body?.overs_limit);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    if (!Number.isInteger(oversLimit) || oversLimit <= 0 || oversLimit > 50) {
      return res
        .status(400)
        .json({ error: "overs_limit must be between 1 and 50" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    if (!matchContext.batting_team_id || !matchContext.fielding_team_id) {
      return res
        .status(400)
        .json({ error: "Set toss teams before setting up scorecard." });
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    const existingScorecard = normalizeLegacyScorecard(
      await collection.findOne({ matchId }),
    );

    if (String(existingScorecard?.status || "").toLowerCase() === "completed") {
      return res.status(409).json({ error: "Scorecard is already completed." });
    }

    const startingSecondInnings =
      String(existingScorecard?.status || "").toLowerCase() === "innings_break";
    const currentInnings = startingSecondInnings
      ? 2
      : getCurrentInningsNumber(existingScorecard);
    const inningsField = getInningsField(currentInnings);

    const battingTeamId = startingSecondInnings
      ? Number(
          existingScorecard?.currentBattingTeamId ||
            matchContext.fielding_team_id,
        )
      : Number(
          existingScorecard?.currentBattingTeamId ||
            matchContext.batting_team_id,
        );
    const battingTeamName = startingSecondInnings
      ? String(
          existingScorecard?.currentBattingTeamName ||
            matchContext.fielding_team_name ||
            "",
        )
      : String(
          existingScorecard?.currentBattingTeamName ||
            matchContext.batting_team_name ||
            "",
        );
    const fieldingTeamId = startingSecondInnings
      ? Number(
          existingScorecard?.currentFieldingTeamId ||
            matchContext.batting_team_id,
        )
      : Number(
          existingScorecard?.currentFieldingTeamId ||
            matchContext.fielding_team_id,
        );
    const fieldingTeamName = startingSecondInnings
      ? String(
          existingScorecard?.currentFieldingTeamName ||
            matchContext.batting_team_name ||
            "",
        )
      : String(
          existingScorecard?.currentFieldingTeamName ||
            matchContext.fielding_team_name ||
            "",
        );

    const now = new Date();
    const payload = {
      matchId,
      tournamentId: Number(matchContext.tournament_id),
      homeTeamId: Number(matchContext.home_team_id),
      homeTeamName: matchContext.home_team_name,
      awayTeamId: Number(matchContext.away_team_id),
      awayTeamName: matchContext.away_team_name,
      currentInnings,
      currentBattingTeamId: battingTeamId,
      currentBattingTeamName: battingTeamName,
      currentFieldingTeamId: fieldingTeamId,
      currentFieldingTeamName: fieldingTeamName,
      oversLimit,
      status: "in_progress",
      [inningsField]: buildInningsState({
        battingTeamId,
        battingTeamName,
        fieldingTeamId,
        fieldingTeamName,
        previousInnings: existingScorecard?.[inningsField],
      }),
      updatedAt: now,
    };

    await collection.updateOne(
      { matchId },
      {
        $set: payload,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    await sql.query(`UPDATE matches SET status = 'in_progress' WHERE id = $1`, [
      matchId,
    ]);

    const scorecard = await collection.findOne({ matchId });
    return res
      .status(200)
      .json({ message: "Scorecard initialized", scorecard });
  } catch (error) {
    console.error("Error setting up match scorecard:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function addBallEvent(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );
    const token = String(req.body?.token || "")
      .trim()
      .toLowerCase();

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    if (!VALID_TOKENS.has(token)) {
      return res.status(400).json({ error: "Invalid ball token" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    const scorecard = normalizeLegacyScorecard(
      await collection.findOne({ matchId }),
    );

    if (!scorecard) {
      return res.status(400).json({ error: "Initialize scorecard first." });
    }

    if (String(scorecard.status || "").toLowerCase() === "completed") {
      return res.status(409).json({ error: "Scorecard is already completed." });
    }

    if (String(scorecard.status || "").toLowerCase() === "innings_break") {
      return res
        .status(409)
        .json({ error: "Start the second innings setup before scoring." });
    }

    const currentInnings = getCurrentInningsNumber(scorecard);
    const inningsField = getInningsField(currentInnings);
    const currentInningsState = scorecard?.[inningsField];

    const events = Array.isArray(currentInningsState?.events)
      ? currentInningsState.events
      : [];
    const legalBalls = countLegalBalls(events);
    const maxLegalBalls = Number(scorecard.oversLimit || 0) * 6;

    if (legalBalls >= maxLegalBalls) {
      return res
        .status(409)
        .json({ error: "All overs are already completed." });
    }

    const eventMeta = tokenToEvent(token);
    const nextLegalBallNumber = legalBalls + (eventMeta.legalBall ? 1 : 0);
    const over =
      Math.floor((nextLegalBallNumber - (eventMeta.legalBall ? 1 : 0)) / 6) + 1;
    const ballInOver = eventMeta.legalBall
      ? ((nextLegalBallNumber - 1) % 6) + 1
      : (legalBalls % 6) + 1;

    const event = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      token,
      label: eventMeta.label,
      runs: eventMeta.runs,
      batterRuns: eventMeta.batterRuns,
      extraRuns: eventMeta.extraRuns,
      wicket: eventMeta.wicket,
      dismissalType: eventMeta.dismissalType,
      extraType: eventMeta.extraType,
      over,
      ballInOver,
      note: String(req.body?.note || ""),
      createdAt: new Date(),
    };

    const updatedEvents = [...events, event];
    const {
      updatePayload,
      inningsCompleted,
      scorecardStatus,
      currentInnings: nextInnings,
      resultSummary,
    } = buildScorecardUpdate({
      scorecard,
      currentInnings,
      updatedEvents,
    });

    await collection.updateOne({ matchId }, { $set: updatePayload });

    if (inningsCompleted && currentInnings === 2) {
      await sql.query(
        `UPDATE matches
         SET status = 'completed', winner_team_id = $2
         WHERE id = $1`,
        [matchId, Number(resultSummary?.winnerTeamId || 0) || null],
      );
    } else if (inningsCompleted && currentInnings === 1) {
      await sql.query(
        `UPDATE matches SET status = 'in_progress' WHERE id = $1`,
        [matchId],
      );
    }

    const totalRuns = sumRuns(updatedEvents);
    const wickets = sumWickets(updatedEvents);
    const updatedLegalBalls = countLegalBalls(updatedEvents);

    return res.status(200).json({
      message: "Ball event added",
      summary: {
        totalRuns,
        wickets,
        overs: toOvers(updatedLegalBalls),
        oversLimit: scorecard.oversLimit,
        completed: inningsCompleted,
        status: scorecardStatus,
        currentInnings: nextInnings,
        resultSummary,
      },
    });
  } catch (error) {
    console.error("Error adding ball event:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function undoLastBallEvent(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    const scorecard = normalizeLegacyScorecard(
      await collection.findOne({ matchId }),
    );

    if (!scorecard) {
      return res.status(404).json({ error: "Scorecard not found" });
    }

    const currentInnings = getCurrentInningsNumber(scorecard);
    const inningsField = getInningsField(currentInnings);
    const currentInningsState = scorecard?.[inningsField];
    const events = Array.isArray(currentInningsState?.events)
      ? currentInningsState.events
      : [];

    if (events.length === 0) {
      return res
        .status(409)
        .json({ error: "No ball event available to undo." });
    }

    const updatedEvents = events.slice(0, -1);
    const {
      updatePayload,
      resultSummary,
      scorecardStatus,
      currentInnings: nextInnings,
    } = buildScorecardUpdate({
      scorecard,
      currentInnings,
      updatedEvents,
    });

    await collection.updateOne({ matchId }, { $set: updatePayload });
    await sql.query(
      `UPDATE matches SET status = $2, winner_team_id = $3 WHERE id = $1`,
      [
        matchId,
        scorecardStatus === "completed" ? "completed" : "in_progress",
        Number(resultSummary?.winnerTeamId || 0) || null,
      ],
    );

    return res.status(200).json({
      message: "Last ball undone successfully.",
      summary: {
        currentInnings: nextInnings,
        status: scorecardStatus,
        resultSummary,
      },
    });
  } catch (error) {
    console.error("Error undoing last ball:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function replaceLastBallEvent(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );
    const token = String(req.body?.token || "")
      .trim()
      .toLowerCase();

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    if (!VALID_TOKENS.has(token)) {
      return res.status(400).json({ error: "Invalid ball token" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    const scorecard = normalizeLegacyScorecard(
      await collection.findOne({ matchId }),
    );

    if (!scorecard) {
      return res.status(404).json({ error: "Scorecard not found" });
    }

    const currentInnings = getCurrentInningsNumber(scorecard);
    const inningsField = getInningsField(currentInnings);
    const currentInningsState = scorecard?.[inningsField];
    const events = Array.isArray(currentInningsState?.events)
      ? currentInningsState.events
      : [];

    if (events.length === 0) {
      return res
        .status(409)
        .json({ error: "No ball event available to edit." });
    }

    const lastEvent = events[events.length - 1];
    const eventMeta = tokenToEvent(token);
    const replacementEvent = {
      ...lastEvent,
      token,
      label: eventMeta.label,
      runs: eventMeta.runs,
      batterRuns: eventMeta.batterRuns,
      extraRuns: eventMeta.extraRuns,
      wicket: eventMeta.wicket,
      dismissalType: eventMeta.dismissalType,
      extraType: eventMeta.extraType,
    };

    const updatedEvents = [...events.slice(0, -1), replacementEvent];
    const {
      updatePayload,
      resultSummary,
      scorecardStatus,
      currentInnings: nextInnings,
    } = buildScorecardUpdate({
      scorecard,
      currentInnings,
      updatedEvents,
    });

    await collection.updateOne({ matchId }, { $set: updatePayload });
    await sql.query(
      `UPDATE matches SET status = $2, winner_team_id = $3 WHERE id = $1`,
      [
        matchId,
        scorecardStatus === "completed" ? "completed" : "in_progress",
        Number(resultSummary?.winnerTeamId || 0) || null,
      ],
    );

    return res.status(200).json({
      message: "Last ball updated successfully.",
      summary: {
        currentInnings: nextInnings,
        status: scorecardStatus,
        resultSummary,
      },
    });
  } catch (error) {
    console.error("Error editing last ball:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function completeMatchScorecard(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    const scorecard = normalizeLegacyScorecard(
      await collection.findOne({ matchId }),
    );

    if (!scorecard) {
      return res.status(404).json({ error: "Scorecard not found" });
    }

    const compactCompletedScorecard = buildCompactCompletedScorecard({
      ...scorecard,
      status: "completed",
    });

    await collection.updateOne(
      { matchId },
      { $set: compactCompletedScorecard },
    );

    const winnerTeamId =
      Number(compactCompletedScorecard?.resultSummary?.winnerTeamId || 0) ||
      null;

    await sql.query(
      `UPDATE matches
       SET status = 'completed', winner_team_id = $2
       WHERE id = $1`,
      [matchId, winnerTeamId],
    );

    // When scorecard completion decides a winner, also advance that team to the next bracket match.
    if (
      winnerTeamId &&
      Number(matchContext.next_match_id || 0) > 0 &&
      (matchContext.next_slot === "home" || matchContext.next_slot === "away")
    ) {
      const slotColumn =
        matchContext.next_slot === "home" ? "home_team_id" : "away_team_id";

      await sql.query(
        `UPDATE matches
         SET ${slotColumn} = $2
         WHERE id = $1`,
        [Number(matchContext.next_match_id), winnerTeamId],
      );
    }

    return res.status(200).json({ message: "Scorecard marked as completed" });
  } catch (error) {
    console.error("Error completing scorecard:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function resetMatchScorecard(req, res) {
  try {
    const matchId = parseId(req.params.matchId);
    const actorContact = String(
      req.body?.editor_contact || req.body?.organiser_contact || "",
    );

    if (!matchId) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    const matchContext = await getMatchContext(matchId);
    if (!matchContext) {
      return res.status(404).json({ error: "Match not found" });
    }

    if (!(await assertScorecardEditor(matchContext, actorContact, res))) {
      return;
    }

    const collection = getScorecardCollectionOrRespond(res);
    if (!collection) {
      return;
    }
    await collection.deleteOne({ matchId });

    await sql.query(
      `UPDATE matches
       SET
         winner_team_id = NULL,
         status = CASE
           WHEN batting_team_id IS NOT NULL AND fielding_team_id IS NOT NULL THEN 'in_progress'
           ELSE 'scheduled'
         END
       WHERE id = $1`,
      [matchId],
    );

    return res.status(200).json({ message: "Scorecard reset successfully." });
  } catch (error) {
    console.error("Error resetting scorecard:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
