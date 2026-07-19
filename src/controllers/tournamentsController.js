import { getMongoDB, sql } from "../config/db.js";

const toRows = (result) => {
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result)) return result;
  return [];
};

const normalizeContact = (value) =>
  String(value || "")
    .replace(/\D/g, "")
    .slice(-10);

const TOURNAMENT_COLUMNS = `
  t.id,
  t.name,
  t.sport_id,
  s.name AS sport_name,
  t.location,
  t.ground,
  t.organiser_name,
  t.organiser_contact,
  t.start_date,
  t.end_date,
  t.ball_type,
  t.tournament_type,
  t.match_type,
  t.teams,
  t.prize,
  t.status,
  t.entry_fees,
  t.state,
  t.city,
  t.created_date,
  COUNT(tt.team_id) FILTER (WHERE COALESCE(tt.is_approved, FALSE) = TRUE) AS approved_teams_count
`;

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

export async function getGroundSuggestions(req, res) {
  try {
    const query = String(req.query.q || "").trim();

    const grounds = await sql`
      SELECT DISTINCT ON (ground)
        ground,
        location,
        state,
        city
      FROM tournaments
      WHERE ground IS NOT NULL
        AND ground <> ''
        AND (
          ${query} = ''
          OR ground ILIKE ${`%${query}%`}
        )
      ORDER BY ground ASC, created_date DESC, id DESC
      LIMIT 10
    `;

    return res.status(200).json({
      grounds,
    });
  } catch (error) {
    console.error("Error fetching ground suggestions:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function getTournamentList(req, res) {
  try {
    const cityFilter = String(req.query.city || "").trim();
    const statusFilter = String(req.query.status || "")
      .trim()
      .toLowerCase();

    const values = [];
    const filters = [];

    if (cityFilter) {
      values.push(`%${cityFilter.toLowerCase()}%`);
      filters.push(
        `(LOWER(COALESCE(t.city, '')) LIKE $${values.length} OR LOWER(COALESCE(t.location, '')) LIKE $${values.length})`,
      );
    }

    if (statusFilter === "upcoming") {
      filters.push(`t.start_date > CURRENT_DATE`);
    } else if (statusFilter === "active") {
      filters.push(
        `t.start_date <= CURRENT_DATE AND t.end_date >= CURRENT_DATE`,
      );
    } else if (statusFilter === "completed") {
      filters.push(`t.end_date < CURRENT_DATE`);
    }

    const whereClause =
      filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await sql.query(
      `SELECT
         ${TOURNAMENT_COLUMNS}
       FROM tournaments t
       LEFT JOIN sports s ON s.id = t.sport_id
       LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
       ${whereClause}
       GROUP BY t.id, s.name
       ORDER BY t.created_date DESC`,
      values,
    );
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(200).json({ tournaments: [] });
    }

    res.status(200).json({ tournaments: rows });
  } catch (error) {
    console.error("Error fetching tournaments:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function getTournamentByContact(req, res) {
  try {
    const { organiser_contact } = req.params;

    if (!organiser_contact) {
      return res
        .status(400)
        .json({ error: "Organiser contact number is required" });
    }

    const result = await sql.query(
      `SELECT
         ${TOURNAMENT_COLUMNS}
       FROM tournaments t
       LEFT JOIN sports s ON s.id = t.sport_id
       LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
       WHERE t.organiser_contact = $1
       GROUP BY t.id, s.name
       ORDER BY t.created_date DESC`,
      [organiser_contact],
    );

    return res.status(200).json({ tournaments: toRows(result) });
  } catch (error) {
    console.error("Error fetching tournaments:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function getTournamentById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID" });
    }

    const result = await sql.query(
      `SELECT
         ${TOURNAMENT_COLUMNS}
       FROM tournaments t
       LEFT JOIN sports s ON s.id = t.sport_id
       LEFT JOIN tournament_teams tt ON tt.tournament_id = t.id
       WHERE t.id = $1
       GROUP BY t.id, s.name`,
      [id],
    );
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Invalid Tournament" });
    }

    return res.status(200).json({ tournament: rows[0] });
  } catch (error) {
    console.error("Error fetching tournaments:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function addTournament(req, res) {
  try {
    const {
      name,
      sport_id,
      location,
      ground,
      organiser_name,
      organiser_contact,
      start_date,
      end_date,
      ball_type,
      tournament_type,
      match_type,
      teams,
      prize = null,
      entry_fees,
      state,
      city,
      status,
    } = req.body;

    // Collect missing fields for detailed feedback
    const missingFields = [];

    if (!name?.trim()) missingFields.push("name");
    if (!location?.trim()) missingFields.push("location");
    if (!ground?.trim()) missingFields.push("ground");
    if (!organiser_name?.trim()) missingFields.push("organiser_name");
    if (!organiser_contact?.trim()) missingFields.push("organiser_contact");
    if (!start_date?.trim()) missingFields.push("start_date");
    if (!end_date?.trim()) missingFields.push("end_date");
    if (!ball_type?.trim()) missingFields.push("ball_type");
    if (!tournament_type?.trim()) missingFields.push("tournament_type");
    if (!match_type?.trim()) missingFields.push("match_type");
    if (!entry_fees) missingFields.push("entry_fees");
    if (!state) missingFields.push("state");
    if (!city) missingFields.push("city");
    if (!teams) missingFields.push("teams");

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "Missing required tournament fields",
        missingFields,
      });
    }

    const result = await sql`
        INSERT INTO tournaments (
          name, sport_id, location, ground,
          organiser_name, organiser_contact,
          start_date, end_date,
          ball_type, tournament_type, match_type,
          teams, prize, status, entry_fees, state, city
        )
        VALUES (
          ${name}, ${sport_id}, ${location}, ${ground},
          ${organiser_name}, ${organiser_contact},
          ${start_date}, ${end_date},
          ${ball_type}, ${tournament_type}, ${match_type},
          ${teams}, ${prize}, ${status}, ${entry_fees}, ${state}, ${city}
        )
        RETURNING *;
      `;

    return res.status(201).json({
      message: "Tournament added successfully!",
      tournament: result[0],
    });
  } catch (error) {
    console.error("Error inserting tournament:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function updateTournament(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid Tournament ID" });
    }

    const {
      name,
      sport_id,
      location,
      ground,
      organiser_name,
      organiser_contact,
      start_date,
      end_date,
      ball_type,
      tournament_type,
      match_type,
      teams,
      prize = null,
      entry_fees,
      state,
      city,
      status,
    } = req.body;
    // Collect missing fields for detailed feedback
    const missingFields = [];
    if (!name?.trim()) missingFields.push("name");
    if (!location?.trim()) missingFields.push("location");
    if (!ground?.trim()) missingFields.push("ground");
    if (!organiser_name?.trim()) missingFields.push("organiser_name");
    if (!organiser_contact?.trim()) missingFields.push("organiser_contact");
    if (!start_date?.trim()) missingFields.push("start_date");
    if (!end_date?.trim()) missingFields.push("end_date");
    if (!ball_type?.trim()) missingFields.push("ball_type");
    if (!tournament_type?.trim()) missingFields.push("tournament_type");
    if (!match_type?.trim()) missingFields.push("match_type");
    if (!entry_fees) missingFields.push("entry_fees");
    if (!state) missingFields.push("state");
    if (!city) missingFields.push("city");
    if (!teams) missingFields.push("teams");

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "Missing required tournament fields",
        missingFields,
      });
    }

    const result = await sql`
      UPDATE tournaments SET
        name = ${name},
        sport_id = ${sport_id},
        location = ${location},
        ground = ${ground},
        organiser_name = ${organiser_name},
        organiser_contact = ${organiser_contact},
        start_date = ${start_date},
        end_date = ${end_date},
        ball_type = ${ball_type},
        tournament_type = ${tournament_type},
        match_type = ${match_type},
        teams = ${teams},
        prize = ${prize},
        status = ${status},
        entry_fees = ${entry_fees},
        state = ${state},
        city = ${city}
      WHERE id = ${id}
      RETURNING *;
    `;

    if (result.length === 0) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    return res.status(200).json({
      message: "Tournament updated successfully!",
      tournament: result[0],
    });
  } catch (error) {
    console.error("Error updating tournament:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function deleteTournament(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const requesterContact = String(
      req.body?.requester_contact || req.body?.organiser_contact || "",
    );

    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Tournament ID is required" });
    }

    const tournamentRows = await sql.query(
      `SELECT id, organiser_contact
       FROM tournaments
       WHERE id = $1
       LIMIT 1`,
      [id],
    );
    const tournamentResult = toRows(tournamentRows);

    if (tournamentResult.length === 0) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const isOrganizer =
      normalizeContact(requesterContact) ===
      normalizeContact(tournamentResult[0].organiser_contact);
    const isAdmin = await isAdminUser(requesterContact);

    if (!isOrganizer && !isAdmin) {
      return res.status(403).json({
        error: "Only tournament organiser or admin can delete tournament.",
      });
    }

    const matchRowsResult = await sql.query(
      `SELECT id
       FROM matches
       WHERE tournament_id = $1`,
      [id],
    );
    const matchIds = toRows(matchRowsResult)
      .map((row) => Number(row.id))
      .filter((matchId) => Number.isInteger(matchId) && matchId > 0);

    let deletedScorecardsCount = 0;
    try {
      const db = getMongoDB();
      const mongoFilter =
        matchIds.length > 0
          ? { $or: [{ tournamentId: id }, { matchId: { $in: matchIds } }] }
          : { tournamentId: id };
      const mongoResult = await db
        .collection("match_scorecards")
        .deleteMany(mongoFilter);
      deletedScorecardsCount = Number(mongoResult?.deletedCount || 0);
    } catch {
      deletedScorecardsCount = 0;
    }

    await sql.query("BEGIN");

    const deleteTournamentTeamsResult = await sql.query(
      `DELETE FROM tournament_teams
       WHERE tournament_id = $1`,
      [id],
    );

    const deleteMatchesResult = await sql.query(
      `DELETE FROM matches
       WHERE tournament_id = $1`,
      [id],
    );

    const deletedTournamentResult = await sql.query(
      `DELETE FROM tournaments
       WHERE id = $1
       RETURNING *`,
      [id],
    );

    await sql.query("COMMIT");

    const result = toRows(deletedTournamentResult);

    if (result.length === 0) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const deletedTournamentTeamsCount = Number(
      deleteTournamentTeamsResult?.rowCount || 0,
    );
    const deletedMatchesCount = Number(deleteMatchesResult?.rowCount || 0);

    return res.status(200).json({
      message: "Tournament deleted successfully",
      tournament: result[0],
      deletedTournamentTeamsCount,
      deletedMatchesCount,
      deletedScorecardsCount,
    });
  } catch (error) {
    try {
      await sql.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    console.error("Error deleting tournament:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function deleteTournamentByContact(req, res) {
  try {
    const { organiser_contact } = req.params;
    const requesterContact = String(
      req.body?.requester_contact || req.body?.organiser_contact || "",
    );

    if (!organiser_contact) {
      return res
        .status(400)
        .json({ error: "Organiser contact number is required" });
    }

    const isAdmin = await isAdminUser(requesterContact);
    const isOrganizerRequester =
      normalizeContact(requesterContact) ===
      normalizeContact(organiser_contact);

    if (!isAdmin && !isOrganizerRequester) {
      return res.status(403).json({
        error: "Only organiser or admin can delete tournaments by contact.",
      });
    }

    const tournamentRowsResult = await sql.query(
      `SELECT id
       FROM tournaments
       WHERE organiser_contact = $1`,
      [organiser_contact],
    );
    const tournamentRows = toRows(tournamentRowsResult);

    if (tournamentRows.length === 0) {
      return res
        .status(404)
        .json({ message: "No tournaments found for this organiser" });
    }

    const tournamentIds = tournamentRows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    const matchRowsResult = await sql.query(
      `SELECT id
       FROM matches
       WHERE tournament_id = ANY($1::int[])`,
      [tournamentIds],
    );
    const matchIds = toRows(matchRowsResult)
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    let deletedScorecardsCount = 0;
    try {
      const db = getMongoDB();
      const mongoFilter =
        matchIds.length > 0
          ? {
              $or: [
                { tournamentId: { $in: tournamentIds } },
                { matchId: { $in: matchIds } },
              ],
            }
          : { tournamentId: { $in: tournamentIds } };
      const mongoResult = await db
        .collection("match_scorecards")
        .deleteMany(mongoFilter);
      deletedScorecardsCount = Number(mongoResult?.deletedCount || 0);
    } catch {
      deletedScorecardsCount = 0;
    }

    await sql.query("BEGIN");

    const deleteTournamentTeamsResult = await sql.query(
      `DELETE FROM tournament_teams
       WHERE tournament_id = ANY($1::int[])`,
      [tournamentIds],
    );

    const deleteMatchesResult = await sql.query(
      `DELETE FROM matches
       WHERE tournament_id = ANY($1::int[])`,
      [tournamentIds],
    );

    const deleteTournamentsResult = await sql.query(
      `DELETE FROM tournaments
       WHERE id = ANY($1::int[])
       RETURNING *`,
      [tournamentIds],
    );

    await sql.query("COMMIT");

    const result = toRows(deleteTournamentsResult);

    if (result.length === 0) {
      return res
        .status(404)
        .json({ message: "No tournaments found for this organiser" });
    }

    return res.status(200).json({
      message: "Tournament(s) deleted successfully!",
      deletedRecords: result,
      deletedTournamentTeamsCount: Number(
        deleteTournamentTeamsResult?.rowCount || 0,
      ),
      deletedMatchesCount: Number(deleteMatchesResult?.rowCount || 0),
      deletedScorecardsCount,
    });
  } catch (error) {
    try {
      await sql.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    console.error("Error deleting tournament:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
