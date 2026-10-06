import { sql } from "../config/db.js";
import {
  buildTournamentRosterConflictResponse,
  getTournamentRosterConflicts,
} from "../services/tournamentPlayerValidation.js";

const normalizeContact = (value) =>
  String(value || "")
    .replace(/\D/g, "")
    .slice(-10);

const getMinPlayersRequired = (tournamentType = "", matchType = "") => {
  const type = String(tournamentType || "").toLowerCase();
  const match = String(matchType || "").toLowerCase();

  // Turf format requires 6 players. All other formats default to 11.
  if (type.includes("turf") || match.includes("turf")) {
    return 6;
  }

  return 11;
};

async function autoApproveOwnersOwnTeams(
  tournamentId = null,
  organiserContact = null,
) {
  const filters = [`COALESCE(tt.is_approved, FALSE) = FALSE`];
  const values = [];

  if (tournamentId) {
    values.push(tournamentId);
    filters.push(`tt.tournament_id = $${values.length}`);
  }

  if (organiserContact) {
    values.push(normalizeContact(organiserContact));
    filters.push(
      `RIGHT(REGEXP_REPLACE(COALESCE(t.organiser_contact, ''), '\\D', '', 'g'), 10) = $${values.length}`,
    );
  }

  const whereClause = filters.join(" AND ");

  await sql.query(
    `UPDATE tournament_teams tt
     SET is_approved = TRUE
     FROM tournaments t, teams tm
     WHERE tt.tournament_id = t.id
       AND tm.id = tt.team_id
       AND ${whereClause}
       AND RIGHT(REGEXP_REPLACE(COALESCE(t.organiser_contact, ''), '\\D', '', 'g'), 10) =
           RIGHT(REGEXP_REPLACE(COALESCE(tm.created_by, ''), '\D', '', 'g'), 10)
       AND NOT EXISTS (
         SELECT 1
         FROM team_players candidate
         INNER JOIN team_players existing
           ON existing.player_id = candidate.player_id
          AND existing.team_id <> candidate.team_id
         INNER JOIN tournament_teams existing_entry
           ON existing_entry.tournament_id = tt.tournament_id
          AND existing_entry.team_id = existing.team_id
         WHERE candidate.team_id = tt.team_id
       )`,
    values,
  );
}

export async function clearStaleTournamentJoinRequests(organiserContact) {
  const filters = [
    `COALESCE(tt.is_approved, FALSE) = FALSE`,
    `LOWER(COALESCE(t.status, '')) <> 'open'`,
  ];
  const values = [];

  if (organiserContact) {
    values.push(organiserContact);
    filters.push(`t.organiser_contact = $${values.length}`);
  }

  const whereClause = filters.join(" AND ");

  await sql.query(
    `DELETE FROM tournament_teams tt
     USING tournaments t
     WHERE t.id = tt.tournament_id
       AND ${whereClause}`,
    values,
  );
}

export async function removeTeamsWithInsufficientPlayers() {
  try {
    // Get all teams in tournaments that don't meet player requirements
    const insufficientTeams = await sql.query(
      `SELECT 
         tt.tournament_id,
         t.name as tournament_name,
         t.tournament_type,
         t.match_type,
         t.organiser_contact,
         tt.team_id,
         tm.name as team_name,
         CASE 
           WHEN LOWER(COALESCE(t.tournament_type, '')) LIKE '%turf%'
             OR LOWER(COALESCE(t.match_type, '')) LIKE '%turf%'
             THEN 6
           ELSE 11
         END as required_players,
         COUNT(tp.player_id) as current_players
       FROM tournament_teams tt
       JOIN tournaments t ON tt.tournament_id = t.id
       JOIN teams tm ON tt.team_id = tm.id
       LEFT JOIN team_players tp ON tm.id = tp.team_id
       GROUP BY tt.tournament_id, t.name, t.tournament_type, t.match_type, t.organiser_contact, tt.team_id, tm.name
       HAVING 
         ((LOWER(COALESCE(t.tournament_type, '')) LIKE '%turf%'
           OR LOWER(COALESCE(t.match_type, '')) LIKE '%turf%')
           AND COUNT(tp.player_id) < 6) OR
         ((LOWER(COALESCE(t.tournament_type, '')) NOT LIKE '%turf%'
           AND LOWER(COALESCE(t.match_type, '')) NOT LIKE '%turf%')
           AND COUNT(tp.player_id) < 11)`,
    );

    // For each team with insufficient players, create alert and remove
    for (const record of insufficientTeams) {
      const alertMessage = `Team "${record.team_name}" (ID: ${record.team_id}) removed from tournament "${record.tournament_name}" - has only ${record.current_players} player(s), requires ${record.required_players}.`;

      // Create alert for organizer
      await sql.query(
        `INSERT INTO admin_notifications (notification_type, reference_id, title, message)
         VALUES ($1, $2, $3, $4)`,
        [
          "team_removed_insufficient_players",
          record.tournament_id,
          `Team Removed - ${record.tournament_name}`,
          alertMessage,
        ],
      );

      // Remove team from tournament
      await sql.query(
        `DELETE FROM tournament_teams
         WHERE tournament_id = $1 AND team_id = $2`,
        [record.tournament_id, record.team_id],
      );
    }

    if (insufficientTeams.length > 0) {
      console.log(
        `Removed ${insufficientTeams.length} team(s) with insufficient players from tournaments.`,
      );
    }
  } catch (error) {
    console.error(
      "Error removing teams with insufficient players:",
      error.message,
    );
  }
}

// Insert a team into a tournament
export async function addTeamToTournament(req, res) {
  const { tournament_id, team_id, fee_paid } = req.body;
  try {
    const tournamentResult = await sql.query(
      `SELECT organiser_contact, tournament_type, match_type, name
       FROM tournaments
       WHERE id = $1
       LIMIT 1`,
      [tournament_id],
    );

    const teamResult = await sql.query(
      `SELECT created_by, name
       FROM teams
       WHERE id = $1
       LIMIT 1`,
      [team_id],
    );

    const tournament = tournamentResult?.[0];
    const team = teamResult?.[0];

    if (!tournament || !team) {
      return res.status(404).json({ error: "Tournament or team not found." });
    }

    // Get player count for the team
    const playerCountResult = await sql.query(
      `SELECT COUNT(*) as player_count
       FROM team_players
       WHERE team_id = $1`,
      [team_id],
    );

    const playerCount = parseInt(playerCountResult?.[0]?.player_count || 0);
    const minPlayersRequired = getMinPlayersRequired(
      tournament.tournament_type,
      tournament.match_type,
    );

    // Validate player count
    if (playerCount < minPlayersRequired) {
      // Create alert for organiser
      const alertMessage = `Team "${team.name}" (ID: ${team_id}) attempted to join but has only ${playerCount} player(s). ${minPlayersRequired === 6 ? "Turf format requires at least 6 players." : "Open Ground format requires at least 11 players."}`;

      await sql.query(
        `INSERT INTO admin_notifications (notification_type, reference_id, title, message)
         VALUES ($1, $2, $3, $4)`,
        [
          "insufficient_players",
          tournament_id,
          `Insufficient Players - ${tournament.name}`,
          alertMessage,
        ],
      );

      return res.status(400).json({
        error: `Team must have at least ${minPlayersRequired} players to join this tournament format. Your team has ${playerCount} player(s).`,
        requiredPlayers: minPlayersRequired,
        currentPlayers: playerCount,
      });
    }

    const rosterConflicts = await getTournamentRosterConflicts(
      tournament_id,
      team_id,
    );
    if (rosterConflicts.length > 0) {
      return res
        .status(409)
        .json(buildTournamentRosterConflictResponse(rosterConflicts));
    }

    const isOwnersOwnTeam =
      normalizeContact(tournament.organiser_contact) ===
      normalizeContact(team.created_by);

    await sql.query(
      `INSERT INTO tournament_teams (tournament_id, team_id, fee_paid, is_approved)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tournament_id, team_id)
       DO UPDATE SET
         fee_paid = EXCLUDED.fee_paid,
         is_approved = CASE
           WHEN EXCLUDED.is_approved = TRUE THEN TRUE
           ELSE tournament_teams.is_approved
         END`,
      [tournament_id, team_id, fee_paid ?? false, isOwnersOwnTeam],
    );

    res.status(201).json({
      message: isOwnersOwnTeam
        ? "Team added to tournament and auto-approved."
        : "Team added to tournament.",
      autoApproved: isOwnersOwnTeam,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Update fee_paid for a team in a tournament
export async function updateTeamInTournament(req, res) {
  const { tournament_id, team_id, fee_paid } = req.body;
  try {
    await sql.query(
      `UPDATE tournament_teams SET fee_paid = $3
       WHERE tournament_id = $1 AND team_id = $2`,
      [tournament_id, team_id, fee_paid],
    );
    res.status(200).json({ message: "Team updated in tournament." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Get all teams for a tournament
export async function getTeamsByTournament(req, res) {
  const { tournament_id } = req.params;
  try {
    await autoApproveOwnersOwnTeams(tournament_id);

    const result = await sql.query(
      `SELECT
         tournament_id,
         team_id,
         registered_at,
         fee_paid,
         is_approved
       FROM tournament_teams
       WHERE tournament_id = $1`,
      [tournament_id],
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Get pending join requests for tournaments owned by organiser contact
export async function getPendingRequestsByOrganizer(req, res) {
  const { organiser_contact } = req.params;

  if (!organiser_contact) {
    return res.status(400).json({ error: "organiser_contact is required" });
  }

  try {
    await autoApproveOwnersOwnTeams(null, organiser_contact);
    await clearStaleTournamentJoinRequests(organiser_contact);

    const result = await sql.query(
      `SELECT
         tt.tournament_id,
         tt.team_id,
         tt.registered_at,
         tt.fee_paid,
         tt.is_approved,
         t.name AS tournament_name,
         t.location AS tournament_location,
         t.start_date,
         t.end_date,
         tm.name AS team_name,
         tm.location AS team_location,
         tm.created_by AS team_created_by
       FROM tournament_teams tt
       INNER JOIN tournaments t ON t.id = tt.tournament_id
       INNER JOIN teams tm ON tm.id = tt.team_id
       WHERE t.organiser_contact = $1
         AND COALESCE(tt.is_approved, FALSE) = FALSE
         AND LOWER(COALESCE(t.status, '')) = 'open'
       ORDER BY tt.registered_at DESC`,
      [organiser_contact],
    );

    return res.status(200).json(result || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Get tournaments for multiple teams
export async function getTournamentsForTeams(req, res) {
  const { team_ids } = req.body; // expects array of team IDs
  try {
    if (!Array.isArray(team_ids) || team_ids.length === 0) {
      return res.status(400).json({ error: "team_ids array required" });
    }

    const result = await sql.query(
      `SELECT
        tt.team_id,
        t.id,
        t.name,
        t.sport_id,
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
        t.created_date
         FROM tournament_teams tt
         INNER JOIN tournaments t ON t.id = tt.tournament_id
         WHERE tt.team_id = ANY($1::int[])`,
      [team_ids],
    );

    const tournamentsByTeam = {};
    (result || []).forEach((row) => {
      if (!tournamentsByTeam[row.team_id]) tournamentsByTeam[row.team_id] = [];
      tournamentsByTeam[row.team_id].push(row);
    });

    res.json(tournamentsByTeam);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Get team by tournament and single team ID
export async function getTeamByTournamentAndTeamId(req, res) {
  const { tournament_id, team_id } = req.params;
  try {
    const result = await sql.query(
      `SELECT
         tournament_id,
         team_id,
         registered_at,
         fee_paid,
         is_approved
       FROM tournament_teams
       WHERE tournament_id = $1 AND team_id = $2`,
      [tournament_id, team_id],
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Get teams by tournament and team IDs
export async function getTeamsByTournamentAndTeamIds(req, res) {
  const { tournament_id } = req.params;
  const { team_ids } = req.body; // expects array
  try {
    const result = await sql.query(
      `SELECT
         tournament_id,
         team_id,
         registered_at,
         fee_paid,
         is_approved
       FROM tournament_teams
       WHERE tournament_id = $1 AND team_id = ANY($2::int[])`,
      [tournament_id, team_ids],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Delete a team from a tournament
export async function deleteTeamFromTournament(req, res) {
  const { tournament_id, team_id } = req.body;
  try {
    await sql.query(
      `DELETE FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`,
      [tournament_id, team_id],
    );
    res.json({ message: "Team removed from tournament." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Approve a team in a tournament (set is_approved = true)
export async function approveTeamInTournament(req, res) {
  const { tournament_id, team_id } = req.body;
  try {
    const rosterConflicts = await getTournamentRosterConflicts(
      tournament_id,
      team_id,
    );
    if (rosterConflicts.length > 0) {
      return res
        .status(409)
        .json(buildTournamentRosterConflictResponse(rosterConflicts));
    }

    await sql.query(
      `UPDATE tournament_teams SET is_approved = true
         WHERE tournament_id = $1 AND team_id = $2`,
      [tournament_id, team_id],
    );
    res.json({ message: "Team approved in tournament." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Reject a team in a tournament (delete team from tournament)
export async function rejectTeamInTournament(req, res) {
  const { tournament_id, team_id } = req.body;
  try {
    await sql.query(
      `DELETE FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2`,
      [tournament_id, team_id],
    );
    res.json({ message: "Team rejected and removed from tournament." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
