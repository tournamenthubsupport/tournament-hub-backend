import { sql } from "../config/db.js";
import {
  buildTournamentRosterConflictResponse,
  getPlayerAssignmentTournamentConflicts,
} from "../services/tournamentPlayerValidation.js";

export const clearExpiredPlayerNotifications = async (mobile) => {
  const filters = [
    `pn.created_at < NOW() - INTERVAL '1 day'
      OR NOT EXISTS (
        SELECT 1
        FROM team_players tp
        WHERE tp.team_id = pn.team_id
          AND tp.player_id = pn.player_id
      )`,
  ];
  const values = [];

  if (mobile) {
    values.push(mobile);
    filters.push(`EXISTS (
      SELECT 1
      FROM players p
      WHERE p.id = pn.player_id
        AND (p.mobile = $${values.length} OR p.id::text = $${values.length})
    )`);
  }

  await sql.query(
    `DELETE FROM player_notifications pn
     WHERE ${filters.join(" AND ")}`,
    values,
  );
};

export const assignPlayersToTeam = async (req, res) => {
  try {
    const { teamId, players } = req.body; // players: [{ playerId, is_captain, is_vicecaptain }]

    // Validate input
    if (!teamId || !Array.isArray(players) || players.length === 0) {
      return res
        .status(400)
        .json({ message: "Team ID and players array are required" });
    }

    const teamRows = await sql`
      SELECT id, name
      FROM teams
      WHERE id = ${teamId}
      LIMIT 1
    `;

    if (teamRows.length === 0) {
      return res.status(404).json({ message: "Team not found" });
    }

    const teamName = teamRows[0].name;

    const dedupedPlayers = [];
    const seenPlayerIds = new Set();

    for (const player of players) {
      const playerId = Number(player?.playerId);
      if (!Number.isFinite(playerId) || seenPlayerIds.has(playerId)) {
        continue;
      }

      seenPlayerIds.add(playerId);
      dedupedPlayers.push({
        playerId,
        is_captain: !!player?.is_captain,
        is_vicecaptain: !!player?.is_vicecaptain,
      });
    }

    if (dedupedPlayers.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid players found in request payload" });
    }

    const existingAssignments = await sql.query(
      `SELECT player_id
       FROM team_players
       WHERE team_id = $1`,
      [Number(teamId)],
    );
    const existingPlayerIds = new Set(
      (existingAssignments || []).map((row) => Number(row.player_id)),
    );
    const alreadyAssigned = dedupedPlayers.filter((player) =>
      existingPlayerIds.has(player.playerId),
    );

    if (alreadyAssigned.length > 0) {
      return res.status(409).json({
        message: "One or more selected players are already members of this team.",
        code: "PLAYER_ALREADY_ON_TEAM",
        playerIds: alreadyAssigned.map((player) => player.playerId),
      });
    }

    if (existingPlayerIds.size + dedupedPlayers.length > 15) {
      return res.status(409).json({
        message: `A team can have at most 15 players. This team has ${existingPlayerIds.size} player(s) and can add only ${Math.max(15 - existingPlayerIds.size, 0)} more.`,
        code: "TEAM_PLAYER_LIMIT_REACHED",
        currentPlayers: existingPlayerIds.size,
        availableSlots: Math.max(15 - existingPlayerIds.size, 0),
      });
    }

    const tournamentConflicts = await getPlayerAssignmentTournamentConflicts(
      teamId,
      dedupedPlayers.map((player) => player.playerId),
    );
    if (tournamentConflicts.length > 0) {
      return res
        .status(409)
        .json(buildTournamentRosterConflictResponse(tournamentConflicts));
    }

    const insertedAssignments = await sql.query(
      `
      INSERT INTO team_players (team_id, player_id, is_captain, is_vicecaptain)
      SELECT
        $1::int,
        x.player_id,
        x.is_captain,
        x.is_vicecaptain
      FROM jsonb_to_recordset($2::jsonb) AS x(
        player_id bigint,
        is_captain boolean,
        is_vicecaptain boolean
      )
      ON CONFLICT (team_id, player_id) DO NOTHING
      RETURNING team_id, player_id
      `,
      [
        Number(teamId),
        JSON.stringify(
          dedupedPlayers.map((p) => ({
            player_id: p.playerId,
            is_captain: p.is_captain,
            is_vicecaptain: p.is_vicecaptain,
          })),
        ),
      ],
    );

    const insertedPlayerIds = (insertedAssignments || []).map((row) =>
      Number(row.player_id),
    );

    if (insertedPlayerIds.length > 0) {
      await sql.query(
        `
        INSERT INTO player_notifications (player_id, team_id, title, message)
        SELECT
          pid,
          $1::int,
          $2::text,
          $3::text
        FROM unnest($4::bigint[]) AS u(pid)
        `,
        [
          Number(teamId),
          `Added to ${teamName}`,
          `You were added to the ${teamName} team. If you do not want to be part of this team, you can leave it from the app.`,
          insertedPlayerIds,
        ],
      );
    }

    res.status(200).json({
      message: `Processed ${dedupedPlayers.length} player(s) for team ${teamId}`,
      summary: {
        requested: players.length,
        valid: dedupedPlayers.length,
        assigned: insertedPlayerIds.length,
        alreadyAssigned: Math.max(
          dedupedPlayers.length - insertedPlayerIds.length,
          0,
        ),
      },
      details: insertedAssignments,
    });
  } catch (error) {
    console.error("Error assigning players to team:", error);
    if (error?.code === "23514") {
      return res.status(409).json({
        message: "A team can have at most 15 players.",
        code: "TEAM_PLAYER_LIMIT_REACHED",
      });
    }
    res
      .status(500)
      .json({ message: "Failed to assign players", error: error.message });
  }
};

export const getPlayersForTeam = async (req, res) => {
  try {
    const { teamId } = req.params;

    const players = await sql`
      SELECT p.*, tp.is_captain AS "isCaptain", tp.is_vicecaptain AS "isViceCaptain"
      FROM players p
      INNER JOIN team_players tp ON tp.player_id = p.id
      WHERE tp.team_id = ${teamId}
    `;

    res.status(200).json({
      message: `Players for team ${teamId} retrieved successfully`,
      players,
    });
  } catch (error) {
    console.error("Error fetching players for team:", error);
    res
      .status(500)
      .json({ message: "Failed to get players", error: error.message });
  }
};

export const getPlayersForTeams = async (req, res) => {
  try {
    const { teamIds } = req.body;
    if (!Array.isArray(teamIds) || teamIds.length === 0) {
      return res.status(400).json({ error: "teamIds array is required" });
    }

    const playersByTeam = {};

    for (const teamId of teamIds) {
      const players = await sql`
        SELECT p.*, tp.is_captain AS "isCaptain", tp.is_vicecaptain AS "isViceCaptain"
        FROM players p
        INNER JOIN team_players tp ON tp.player_id = p.id
        WHERE tp.team_id = ${teamId}
      `;
      playersByTeam[teamId] = players;
    }

    res.status(200).json(playersByTeam); // <-- Return the map directly!
  } catch (error) {
    console.error("Error fetching players for teams:", error);
    res.status(500).json({ error: error.message });
  }
};

export const getTeamsForPlayer = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({ message: "mobile is required" });
    }

    const rawMobile = String(mobile || "").trim();

    const teams = await sql`
      SELECT DISTINCT t.id, t.name, t.location, t.sport_id AS "sportId", t.created_by AS "createdBy"
      FROM players p
      INNER JOIN team_players tp ON tp.player_id = p.id
      INNER JOIN teams t ON t.id = tp.team_id
      WHERE p.mobile = ${rawMobile}
         OR p.id::text = ${rawMobile}
      ORDER BY t.id DESC
    `;

    return res.status(200).json({ teams });
  } catch (error) {
    console.error("Error fetching teams for player:", error);
    return res.status(500).json({
      message: "Failed to fetch teams for player",
      error: error.message,
    });
  }
};

export const removePlayerFromTeam = async (req, res) => {
  try {
    const { teamId, playerId } = req.params;

    const result = await sql`
      DELETE FROM team_players
      WHERE team_id = ${teamId} AND player_id = ${playerId}
      RETURNING *
    `;

    if (result.length === 0) {
      return res
        .status(404)
        .json({ message: "No matching player-team relationship found" });
    }

    await sql`
      DELETE FROM player_notifications
      WHERE team_id = ${teamId} AND player_id = ${playerId}
    `;

    res.status(200).json({
      message: `Player ${playerId} removed from team ${teamId}`,
      data: result[0],
    });
  } catch (error) {
    console.error("Error removing player from team:", error);
    res
      .status(500)
      .json({ message: "Failed to remove player", error: error.message });
  }
};

export const removePlayerFromTeamByMobile = async (req, res) => {
  try {
    const { teamId, mobile } = req.params;
    const rawMobile = String(mobile || "").trim();

    const result = await sql`
      DELETE FROM team_players tp
      USING players p
      WHERE tp.player_id = p.id
        AND tp.team_id = ${teamId}
        AND (p.mobile = ${rawMobile} OR p.id::text = ${rawMobile})
      RETURNING tp.*
    `;

    if (result.length === 0) {
      return res
        .status(404)
        .json({ message: "No matching player-team relationship found" });
    }

    await sql`
      DELETE FROM player_notifications pn
      USING players p
      WHERE pn.player_id = p.id
        AND pn.team_id = ${teamId}
        AND (p.mobile = ${rawMobile} OR p.id::text = ${rawMobile})
    `;

    res.status(200).json({
      message: `Player with mobile ${rawMobile} removed from team ${teamId}`,
      data: result[0],
    });
  } catch (error) {
    console.error("Error removing player from team by mobile:", error);
    res
      .status(500)
      .json({ message: "Failed to remove player", error: error.message });
  }
};

export const getPlayerNotifications = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({ message: "mobile is required" });
    }

    const rawMobile = String(mobile || "").trim();

    await clearExpiredPlayerNotifications(rawMobile);

    const notifications = await sql`
      SELECT
        pn.id,
        pn.title,
        pn.message,
        pn.is_read AS "isRead",
        pn.created_at AS "createdAt",
        pn.team_id AS "teamId",
        t.name AS "teamName"
      FROM player_notifications pn
      INNER JOIN players p ON p.id = pn.player_id
      LEFT JOIN teams t ON t.id = pn.team_id
      WHERE p.mobile = ${rawMobile}
         OR p.id::text = ${rawMobile}
      ORDER BY pn.created_at DESC, pn.id DESC
    `;

    return res.status(200).json({ notifications });
  } catch (error) {
    console.error("Error fetching player notifications:", error);
    return res.status(500).json({
      message: "Failed to fetch player notifications",
      error: error.message,
    });
  }
};

export const markPlayerNotificationsRead = async (req, res) => {
  try {
    const { mobile } = req.params;

    if (!mobile) {
      return res.status(400).json({ message: "mobile is required" });
    }

    const rawMobile = String(mobile || "").trim();

    const updatedRows = await sql`
      UPDATE player_notifications pn
      SET is_read = TRUE
      FROM players p
      WHERE p.id = pn.player_id
        AND (p.mobile = ${rawMobile} OR p.id::text = ${rawMobile})
        AND pn.is_read = FALSE
      RETURNING pn.id
    `;

    return res.status(200).json({ updated: updatedRows.length });
  } catch (error) {
    console.error("Error marking player notifications read:", error);
    return res.status(500).json({
      message: "Failed to mark notifications read",
      error: error.message,
    });
  }
};
