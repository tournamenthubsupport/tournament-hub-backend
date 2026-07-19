import { sql } from "../config/db.js";

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

    // Insert relationships into team_players
    const insertResults = await Promise.all(
      players.map(
        ({ playerId, is_captain = false, is_vicecaptain = false }) =>
          sql`
          INSERT INTO team_players (team_id, player_id, is_captain, is_vicecaptain)
          VALUES (${teamId}, ${playerId}, ${is_captain}, ${is_vicecaptain})
          ON CONFLICT DO NOTHING
          RETURNING team_id, player_id
        `,
      ),
    );

    const insertedAssignments = insertResults
      .flatMap((rows) => (Array.isArray(rows) ? rows : []))
      .filter((row) => row?.player_id);

    await Promise.all(
      insertedAssignments.map(
        ({ player_id }) =>
          sql`
          INSERT INTO player_notifications (player_id, team_id, title, message)
          VALUES (
            ${player_id},
            ${teamId},
            ${`Added to ${teamName}`},
            ${`You were added to the ${teamName} team. If you do not want to be part of this team, you can leave it from the app.`}
          )
        `,
      ),
    );

    res.status(200).json({
      message: `Assigned ${players.length} player(s) to team ${teamId}`,
      details: insertedAssignments,
    });
  } catch (error) {
    console.error("Error assigning players to team:", error);
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
    return res
      .status(500)
      .json({
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
    return res
      .status(500)
      .json({
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
    return res
      .status(500)
      .json({
        message: "Failed to mark notifications read",
        error: error.message,
      });
  }
};
