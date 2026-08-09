import { getMongoDB, sql } from "../config/db.js";

const VALID_STATUS = new Set(["scheduled", "in_progress", "completed"]);

const roundLabel = (roundNumber, totalRounds) => {
  if (roundNumber === totalRounds) return "Final";
  if (roundNumber === totalRounds - 1) return "Semi Final";
  if (roundNumber === totalRounds - 2) return "Quarter Final";
  return `Round of ${2 ** (totalRounds - roundNumber + 1)}`;
};

const toRows = (result) => {
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result)) return result;
  return [];
};

const normalizeContact = (value) =>
  String(value || "")
    .replace(/\D/g, "")
    .slice(-10);

async function isAdminUser(contact) {
  const normalized = normalizeContact(contact);
  if (!normalized) return false;

  const result = await sql.query(
    `SELECT 1
     FROM users
     WHERE LOWER(COALESCE(role, 'player')) = 'admin'
       AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
     LIMIT 1`,
    [normalized],
  );

  return toRows(result).length > 0;
}

const autoAdvanceByeWinner = async (matchRow) => {
  const homeTeamId = matchRow.home_team_id;
  const awayTeamId = matchRow.away_team_id;
  const winnerTeamId = homeTeamId || awayTeamId || null;

  if (!winnerTeamId) return;
  if (homeTeamId && awayTeamId) return;

  await sql.query(
    `UPDATE matches
     SET
       status = 'completed',
       winner_team_id = $2
     WHERE id = $1`,
    [matchRow.id, winnerTeamId],
  );

  if (!matchRow.next_match_id || !matchRow.next_slot) return;

  const slotColumn =
    matchRow.next_slot === "home" ? "home_team_id" : "away_team_id";
  await sql.query(
    `UPDATE matches
     SET ${slotColumn} = $2
     WHERE id = $1`,
    [matchRow.next_match_id, winnerTeamId],
  );
};

const reconcileTournamentBracketProgression = async (tournamentId) => {
  await sql.query(
    `UPDATE matches AS next_match
     SET home_team_id = feeder.winner_team_id
     FROM matches AS feeder
     WHERE feeder.tournament_id = $1
       AND feeder.next_match_id = next_match.id
       AND feeder.next_slot = 'home'
       AND feeder.winner_team_id IS NOT NULL
       AND next_match.tournament_id = $1
       AND next_match.home_team_id IS NULL`,
    [tournamentId],
  );

  await sql.query(
    `UPDATE matches AS next_match
     SET away_team_id = feeder.winner_team_id
     FROM matches AS feeder
     WHERE feeder.tournament_id = $1
       AND feeder.next_match_id = next_match.id
       AND feeder.next_slot = 'away'
       AND feeder.winner_team_id IS NOT NULL
       AND next_match.tournament_id = $1
       AND next_match.away_team_id IS NULL`,
    [tournamentId],
  );
};

export async function getTournamentMatches(req, res) {
  try {
    const tournamentId = Number(req.params.id);

    if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
      return res.status(400).json({ error: "Invalid tournament id" });
    }

    // Self-heal bracket slots for already completed feeder matches.
    // This ensures final slots are backfilled even if earlier flows missed propagation.
    await reconcileTournamentBracketProgression(tournamentId);

    const result = await sql.query(
      `SELECT
         m.id,
         m.tournament_id AS "tournamentId",
         m.home_team_id AS "homeTeamId",
         ht.name AS "homeTeamName",
         m.away_team_id AS "awayTeamId",
         at.name AS "awayTeamName",
         m.winner_team_id AS "winnerTeamId",
         wt.name AS "winnerTeamName",
         m.match_date AS "matchDate",
         m.venue,
         m.status,
         m.round,
         m.toss_result AS "tossResult",
         m.toss_winner_team_id AS "tossWinnerTeamId",
         twt.name AS "tossWinnerTeamName",
         m.toss_decision AS "tossDecision",
         m.batting_team_id AS "battingTeamId",
         bt.name AS "battingTeamName",
         m.fielding_team_id AS "fieldingTeamId",
         ft.name AS "fieldingTeamName",
         m.next_match_id AS "nextMatchId",
         m.next_slot AS "nextSlot",
         m.home_from_match_id AS "homeFromMatchId",
         m.away_from_match_id AS "awayFromMatchId"
       FROM matches m
       LEFT JOIN teams ht ON ht.id = m.home_team_id
       LEFT JOIN teams at ON at.id = m.away_team_id
       LEFT JOIN teams wt ON wt.id = m.winner_team_id
       LEFT JOIN teams twt ON twt.id = m.toss_winner_team_id
       LEFT JOIN teams bt ON bt.id = m.batting_team_id
       LEFT JOIN teams ft ON ft.id = m.fielding_team_id
       WHERE m.tournament_id = $1
       ORDER BY m.match_date ASC, m.id ASC`,
      [tournamentId],
    );

    return res.status(200).json({ matches: toRows(result) });
  } catch (error) {
    console.error("Error fetching tournament matches:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function scheduleTournamentMatches(req, res) {
  try {
    const tournamentId = Number(req.params.id);
    const organiserContact = String(req.body?.organiser_contact || "").trim();

    if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
      return res.status(400).json({ error: "Invalid tournament id" });
    }

    const tournamentResult = await sql.query(
      `SELECT id, teams, organiser_contact, ground
       FROM tournaments
       WHERE id = $1
       LIMIT 1`,
      [tournamentId],
    );
    const tournamentRows = toRows(tournamentResult);

    if (tournamentRows.length === 0) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const tournament = tournamentRows[0];
    if (
      !organiserContact ||
      organiserContact !== String(tournament.organiser_contact || "")
    ) {
      return res
        .status(403)
        .json({ error: "Only the tournament organiser can schedule matches." });
    }

    const existingMatchesResult = await sql.query(
      `SELECT id FROM matches WHERE tournament_id = $1 LIMIT 1`,
      [tournamentId],
    );
    if (toRows(existingMatchesResult).length > 0) {
      return res
        .status(409)
        .json({ error: "Schedule already exists for this tournament." });
    }

    const approvedTeamsResult = await sql.query(
      `SELECT tt.team_id, tm.name
       FROM tournament_teams tt
       INNER JOIN teams tm ON tm.id = tt.team_id
       WHERE tt.tournament_id = $1
         AND COALESCE(tt.is_approved, FALSE) = TRUE
       ORDER BY tt.registered_at ASC, tt.team_id ASC`,
      [tournamentId],
    );
    const approvedTeams = toRows(approvedTeamsResult);

    const requiredTeams = Number(tournament.teams) || 0;
    if (requiredTeams <= 1) {
      return res
        .status(400)
        .json({ error: "Tournament must have at least 2 teams." });
    }

    if (approvedTeams.length < requiredTeams) {
      return res.status(400).json({
        error:
          "Tournament is not full yet. Approve all required teams before scheduling.",
        requiredTeams,
        approvedTeams: approvedTeams.length,
      });
    }

    const seededTeams = approvedTeams
      .slice(0, requiredTeams)
      .map((row) => Number(row.team_id));

    for (let i = seededTeams.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [seededTeams[i], seededTeams[j]] = [seededTeams[j], seededTeams[i]];
    }

    const bracketSize = 2 ** Math.ceil(Math.log2(requiredTeams));
    const totalRounds = Math.log2(bracketSize);

    const firstRoundPairs = [];
    const queue = [...seededTeams];
    for (let i = 0; i < bracketSize / 2; i += 1) {
      const home = queue.length > 0 ? queue.shift() : null;
      const away = queue.length > 0 ? queue.shift() : null;
      firstRoundPairs.push([home, away]);
    }

    const rounds = [];
    for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber += 1) {
      const matchCount = bracketSize / 2 ** roundNumber;
      const roundMatches = [];
      for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
        const isFirstRound = roundNumber === 1;
        const homeTeamId = isFirstRound ? firstRoundPairs[matchIndex][0] : null;
        const awayTeamId = isFirstRound ? firstRoundPairs[matchIndex][1] : null;

        const inserted = await sql.query(
          `INSERT INTO matches (
             tournament_id,
             home_team_id,
             away_team_id,
             match_date,
             venue,
             status,
             round
           )
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, 'scheduled', $5)
           RETURNING id, tournament_id, home_team_id, away_team_id, status, round`,
          [
            tournamentId,
            homeTeamId,
            awayTeamId,
            tournament.ground || null,
            roundLabel(roundNumber, totalRounds),
          ],
        );

        roundMatches.push(toRows(inserted)[0]);
      }
      rounds.push(roundMatches);
    }

    for (let roundIndex = 0; roundIndex < rounds.length - 1; roundIndex += 1) {
      const currentRound = rounds[roundIndex];
      const nextRound = rounds[roundIndex + 1];

      for (
        let matchIndex = 0;
        matchIndex < currentRound.length;
        matchIndex += 1
      ) {
        const currentMatch = currentRound[matchIndex];
        const nextMatch = nextRound[Math.floor(matchIndex / 2)];
        const nextSlot = matchIndex % 2 === 0 ? "home" : "away";

        await sql.query(
          `UPDATE matches
           SET
             next_match_id = $2,
             next_slot = $3
           WHERE id = $1`,
          [currentMatch.id, nextMatch.id, nextSlot],
        );

        if (nextSlot === "home") {
          await sql.query(
            `UPDATE matches SET home_from_match_id = $2 WHERE id = $1`,
            [nextMatch.id, currentMatch.id],
          );
        } else {
          await sql.query(
            `UPDATE matches SET away_from_match_id = $2 WHERE id = $1`,
            [nextMatch.id, currentMatch.id],
          );
        }
      }
    }

    for (const matchRow of rounds[0]) {
      await autoAdvanceByeWinner(matchRow);
    }

    const finalList = await sql.query(
      `SELECT
         m.id,
         m.tournament_id AS "tournamentId",
         m.home_team_id AS "homeTeamId",
         ht.name AS "homeTeamName",
         m.away_team_id AS "awayTeamId",
         at.name AS "awayTeamName",
         m.winner_team_id AS "winnerTeamId",
         wt.name AS "winnerTeamName",
         m.match_date AS "matchDate",
         m.venue,
         m.status,
         m.round,
         m.next_match_id AS "nextMatchId",
         m.next_slot AS "nextSlot"
       FROM matches m
       LEFT JOIN teams ht ON ht.id = m.home_team_id
       LEFT JOIN teams at ON at.id = m.away_team_id
       LEFT JOIN teams wt ON wt.id = m.winner_team_id
       WHERE m.tournament_id = $1
       ORDER BY m.match_date ASC, m.id ASC`,
      [tournamentId],
    );

    return res.status(201).json({
      message: "Match schedule created successfully.",
      matches: toRows(finalList),
    });
  } catch (error) {
    console.error("Error scheduling matches:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function startScheduledMatch(req, res) {
  try {
    const matchId = Number(req.params.matchId);
    const organiserContact = String(req.body?.organiser_contact || "").trim();

    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    const result = await sql.query(
      `SELECT m.id, m.status, t.organiser_contact
       FROM matches m
       INNER JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.id = $1
       LIMIT 1`,
      [matchId],
    );
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = rows[0];
    if (
      !organiserContact ||
      organiserContact !== String(match.organiser_contact || "")
    ) {
      return res
        .status(403)
        .json({ error: "Only the tournament organiser can start matches." });
    }

    if (!VALID_STATUS.has(String(match.status || "").toLowerCase())) {
      return res.status(400).json({ error: "Invalid match status" });
    }

    if (String(match.status || "").toLowerCase() === "completed") {
      return res
        .status(400)
        .json({ error: "Completed match cannot be started." });
    }

    await sql.query(`UPDATE matches SET status = 'in_progress' WHERE id = $1`, [
      matchId,
    ]);

    return res.status(200).json({ message: "Match started." });
  } catch (error) {
    console.error("Error starting match:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function resetTournamentMatches(req, res) {
  try {
    const tournamentId = Number(req.params.id);
    const requesterContact = String(
      req.body?.requester_contact || req.body?.organiser_contact || "",
    );

    if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
      return res.status(400).json({ error: "Invalid tournament id" });
    }

    const tournamentResult = await sql.query(
      `SELECT id, organiser_contact
       FROM tournaments
       WHERE id = $1
       LIMIT 1`,
      [tournamentId],
    );
    const tournamentRows = toRows(tournamentResult);

    if (tournamentRows.length === 0) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const tournament = tournamentRows[0];
    const isOrganizer =
      normalizeContact(requesterContact) ===
      normalizeContact(tournament.organiser_contact);
    const isAdmin = await isAdminUser(requesterContact);

    if (!isOrganizer && !isAdmin) {
      return res.status(403).json({
        error:
          "Only tournament organiser or admin can reset tournament matches.",
      });
    }

    const matchRowsResult = await sql.query(
      `SELECT id
       FROM matches
       WHERE tournament_id = $1`,
      [tournamentId],
    );
    const matchRows = toRows(matchRowsResult);
    const matchIds = matchRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    let mongoDeletedCount = 0;
    try {
      const db = getMongoDB();
      const mongoDeleteQuery =
        matchIds.length > 0
          ? {
              $or: [{ tournamentId }, { matchId: { $in: matchIds } }],
            }
          : { tournamentId };
      const mongoResult = await db
        .collection("match_scorecards")
        .deleteMany(mongoDeleteQuery);
      mongoDeletedCount = Number(mongoResult?.deletedCount || 0);
    } catch {
      mongoDeletedCount = 0;
    }

    const deleteMatchesResult = await sql.query(
      `DELETE FROM matches
       WHERE tournament_id = $1`,
      [tournamentId],
    );
    const deletedMatchesCount = Number(
      deleteMatchesResult?.rowCount || matchIds.length,
    );

    return res.status(200).json({
      message: "Tournament matches and related scorecards reset successfully.",
      tournamentId,
      deletedMatchesCount,
      deletedScorecardsCount: mongoDeletedCount,
    });
  } catch (error) {
    console.error("Error resetting tournament matches:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function setMatchToss(req, res) {
  try {
    const matchId = Number(req.params.matchId || req.params.id);
    const organiserContact = String(req.body?.organiser_contact || "").trim();
    const tossResultRaw = String(req.body?.toss_result || "")
      .trim()
      .toLowerCase();
    const tossWinnerTeamIdRaw = Number(req.body?.toss_winner_team_id);
    const tossDecisionRaw = String(req.body?.toss_decision || "")
      .trim()
      .toLowerCase();
    const battingTeamId = Number(req.body?.batting_team_id);
    const fieldingTeamId = Number(req.body?.fielding_team_id);

    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    if (!Number.isInteger(battingTeamId) || battingTeamId <= 0) {
      return res.status(400).json({ error: "batting_team_id is required" });
    }

    if (!Number.isInteger(fieldingTeamId) || fieldingTeamId <= 0) {
      return res.status(400).json({ error: "fielding_team_id is required" });
    }

    if (battingTeamId === fieldingTeamId) {
      return res
        .status(400)
        .json({ error: "Batting and fielding teams must be different." });
    }

    const result = await sql.query(
      `SELECT
         m.id,
         m.home_team_id,
         m.away_team_id,
         m.winner_team_id,
         t.organiser_contact
       FROM matches m
       INNER JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.id = $1
       LIMIT 1`,
      [matchId],
    );
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = rows[0];
    if (
      !organiserContact ||
      organiserContact !== String(match.organiser_contact || "")
    ) {
      return res
        .status(403)
        .json({ error: "Only the tournament organiser can set toss." });
    }

    if (Number(match.winner_team_id || 0) > 0) {
      return res
        .status(409)
        .json({ error: "Toss cannot be changed after winner is set." });
    }

    const homeTeamId = Number(match.home_team_id || 0);
    const awayTeamId = Number(match.away_team_id || 0);
    if (
      ![homeTeamId, awayTeamId].includes(battingTeamId) ||
      ![homeTeamId, awayTeamId].includes(fieldingTeamId)
    ) {
      return res.status(400).json({
        error: "Batting and fielding teams must be one of the playing teams.",
      });
    }

    const tossResult = ["head", "tail"].includes(tossResultRaw)
      ? tossResultRaw
      : null;
    const tossWinnerTeamId =
      Number.isInteger(tossWinnerTeamIdRaw) && tossWinnerTeamIdRaw > 0
        ? tossWinnerTeamIdRaw
        : null;
    const tossDecision = ["batting", "fielding"].includes(tossDecisionRaw)
      ? tossDecisionRaw
      : tossWinnerTeamId
        ? tossWinnerTeamId === battingTeamId
          ? "batting"
          : "fielding"
        : null;

    await sql.query(
      `UPDATE matches
       SET
         toss_result = $2,
         toss_winner_team_id = $3,
         toss_decision = $4,
         batting_team_id = $5,
         fielding_team_id = $6,
         status = CASE WHEN LOWER(COALESCE(status, 'scheduled')) = 'scheduled' THEN 'in_progress' ELSE status END
       WHERE id = $1`,
      [
        matchId,
        tossResult,
        tossWinnerTeamId,
        tossDecision,
        battingTeamId,
        fieldingTeamId,
      ],
    );

    return res.status(200).json({ message: "Toss saved successfully." });
  } catch (error) {
    console.error("Error saving toss:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function completeMatchWithWinner(req, res) {
  try {
    const matchId = Number(req.params.matchId);
    const organiserContact = String(req.body?.organiser_contact || "").trim();
    const winnerTeamId = Number(req.body?.winner_team_id);

    if (!Number.isInteger(matchId) || matchId <= 0) {
      return res.status(400).json({ error: "Invalid match id" });
    }

    if (!Number.isInteger(winnerTeamId) || winnerTeamId <= 0) {
      return res.status(400).json({ error: "winner_team_id is required" });
    }

    const result = await sql.query(
      `SELECT
         m.id,
         m.tournament_id,
         m.home_team_id,
         m.away_team_id,
         m.toss_winner_team_id,
         m.toss_decision,
         m.batting_team_id,
         m.fielding_team_id,
         m.next_match_id,
         m.next_slot,
         m.status,
         t.organiser_contact
       FROM matches m
       INNER JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.id = $1
       LIMIT 1`,
      [matchId],
    );

    const rows = toRows(result);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Match not found" });
    }

    const match = rows[0];
    if (
      !organiserContact ||
      organiserContact !== String(match.organiser_contact || "")
    ) {
      return res
        .status(403)
        .json({ error: "Only the tournament organiser can complete matches." });
    }

    const homeTeamId = Number(match.home_team_id || 0);
    const awayTeamId = Number(match.away_team_id || 0);

    if (
      !Number(match.batting_team_id || 0) ||
      !Number(match.fielding_team_id || 0)
    ) {
      return res.status(400).json({
        error: "Set toss teams (batting/fielding) before setting winner.",
      });
    }

    if (winnerTeamId !== homeTeamId && winnerTeamId !== awayTeamId) {
      return res
        .status(400)
        .json({ error: "Winner must be one of the teams in this match." });
    }

    if (match.next_match_id) {
      const nextMatchResult = await sql.query(
        `SELECT id, status, winner_team_id
         FROM matches
         WHERE id = $1
         LIMIT 1`,
        [match.next_match_id],
      );

      const nextRows = toRows(nextMatchResult);
      if (nextRows.length > 0) {
        const nextMatch = nextRows[0];
        const nextStatus = String(nextMatch.status || "").toLowerCase();
        const nextWinnerTeamId = Number(nextMatch.winner_team_id || 0);

        if (
          nextStatus === "in_progress" ||
          nextStatus === "completed" ||
          nextWinnerTeamId > 0
        ) {
          return res.status(409).json({
            error:
              "Winner cannot be changed after the next round match has started.",
          });
        }
      }
    }

    await sql.query(
      `UPDATE matches
       SET
         winner_team_id = $2,
         status = 'completed'
       WHERE id = $1`,
      [matchId, winnerTeamId],
    );

    if (match.next_match_id && match.next_slot) {
      const slotColumn =
        match.next_slot === "home" ? "home_team_id" : "away_team_id";
      await sql.query(
        `UPDATE matches
         SET ${slotColumn} = $2
         WHERE id = $1`,
        [match.next_match_id, winnerTeamId],
      );
    }

    return res
      .status(200)
      .json({ message: "Match completed and winner advanced." });
  } catch (error) {
    console.error("Error completing match:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
