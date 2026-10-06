import { sql } from "../config/db.js";

// Add Player
export const createPlayer = async (req, res) => {
  try {
    const { id, name, mobile, role } = req.body;

    // Check if mobile already exists
    const existing = await sql`SELECT * FROM players WHERE mobile = ${mobile}`;
    if (existing.length > 0) {
      return res
        .status(409)
        .json({ message: "Mobile number already exists", player: existing[0] });
    }

    const newPlayer = await sql`
      INSERT INTO players (id, name, mobile, role)
      VALUES (${id}, ${name}, ${mobile}, ${role})
      RETURNING *
    `;
    res
      .status(201)
      .json({ message: "Player created successfully", player: newPlayer[0] });
  } catch (error) {
    console.error("Error creating player:", error);
    res
      .status(500)
      .json({ message: "Failed to create player", error: error.message });
  }
};

// Bulk add players in one request to reduce API/DB load on free tiers.
export const createPlayersBulk = async (req, res) => {
  try {
    const { players } = req.body;

    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ message: "players array is required" });
    }

    const invalidPlayers = [];
    const dedupedByMobile = new Map();

    players.forEach((player, index) => {
      const id = Number(String(player?.id || "").trim());
      const name = String(player?.name || "").trim();
      const mobile = String(player?.mobile || "").replace(/\D/g, "");
      const role = String(player?.role || "").trim();

      if (!Number.isFinite(id)) {
        invalidPlayers.push({ index, mobile, reason: "invalid_id" });
        return;
      }

      if (!name) {
        invalidPlayers.push({ index, mobile, reason: "name_required" });
        return;
      }

      if (!/^\d{10}$/.test(mobile)) {
        invalidPlayers.push({ index, mobile, reason: "invalid_mobile" });
        return;
      }

      if (!role) {
        invalidPlayers.push({ index, mobile, reason: "role_required" });
        return;
      }

      if (dedupedByMobile.has(mobile)) {
        invalidPlayers.push({
          index,
          mobile,
          reason: "duplicate_mobile_in_request",
        });
        return;
      }

      dedupedByMobile.set(mobile, { id, name, mobile, role });
    });

    const validPlayers = Array.from(dedupedByMobile.values());

    if (validPlayers.length === 0) {
      return res.status(400).json({
        message: "No valid players found in request",
        createdPlayers: [],
        existingPlayers: [],
        invalidPlayers,
        summary: {
          requested: players.length,
          valid: 0,
          created: 0,
          existing: 0,
          invalid: invalidPlayers.length,
        },
      });
    }

    const payloadJson = JSON.stringify(validPlayers);

    const existingPlayers = await sql.query(
      `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, name text, mobile text, role text)
      )
      SELECT p.*
      FROM players p
      INNER JOIN payload x
        ON p.mobile = x.mobile OR p.id = x.id
      `,
      [payloadJson],
    );

    const existingByMobile = new Set(
      (existingPlayers || []).map((p) => String(p.mobile)),
    );
    const existingById = new Set(
      (existingPlayers || []).map((p) => Number(p.id)),
    );

    const insertCandidates = validPlayers.filter(
      (player) =>
        !existingByMobile.has(String(player.mobile)) &&
        !existingById.has(Number(player.id)),
    );

    let createdPlayers = [];
    if (insertCandidates.length > 0) {
      createdPlayers = await sql.query(
        `
        INSERT INTO players (id, name, mobile, role)
        SELECT x.id, x.name, x.mobile, x.role
        FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, name text, mobile text, role text)
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [JSON.stringify(insertCandidates)],
      );
    }

    const createdMobileSet = new Set(
      (createdPlayers || []).map((p) => String(p.mobile)),
    );

    // Covers race conditions where insert candidate becomes existing between read and write.
    const raceMobiles = insertCandidates
      .map((p) => String(p.mobile))
      .filter((mobile) => !createdMobileSet.has(mobile));

    let raceExistingPlayers = [];
    if (raceMobiles.length > 0) {
      raceExistingPlayers = await sql.query(
        `SELECT * FROM players WHERE mobile = ANY($1::text[])`,
        [raceMobiles],
      );
    }

    const allExistingPlayers = [
      ...(existingPlayers || []),
      ...(raceExistingPlayers || []),
    ];
    const uniqueExistingByMobile = new Map();
    allExistingPlayers.forEach((player) => {
      uniqueExistingByMobile.set(String(player.mobile), player);
    });

    return res.status(200).json({
      message: "Bulk player processing completed",
      createdPlayers: createdPlayers || [],
      existingPlayers: Array.from(uniqueExistingByMobile.values()),
      invalidPlayers,
      summary: {
        requested: players.length,
        valid: validPlayers.length,
        created: (createdPlayers || []).length,
        existing: uniqueExistingByMobile.size,
        invalid: invalidPlayers.length,
      },
    });
  } catch (error) {
    console.error("Error creating players in bulk:", error);
    return res
      .status(500)
      .json({
        message: "Failed to create players in bulk",
        error: error.message,
      });
  }
};

// Get All Players
export const getAllPlayers = async (req, res) => {
  try {
    const players = await sql`SELECT * FROM players`;
    res
      .status(200)
      .json({ message: "Players retrieved successfully", players });
  } catch (error) {
    console.error("Error fetching players:", error);
    res
      .status(500)
      .json({ message: "Failed to retrieve players", error: error.message });
  }
};

// Get Player by ID
// export const getPlayerById = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const player = await sql`SELECT * FROM players WHERE id = ${id}`;
//     if (player.length === 0) {
//       return res.status(404).json({ message: "Player not found" });
//     }
//     res.status(200).json({ message: "Player retrieved successfully", player: player[0] });
//   } catch (error) {
//     console.error("Error fetching player:", error);
//     res.status(500).json({ message: "Failed to retrieve player", error: error.message });
//   }
// };

// Update Player
export const updatePlayer = async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body?.name || "").trim();
    const mobile = String(req.body?.mobile || "").replace(/\D/g, "");
    const role = String(req.body?.role || "").trim().toLowerCase();
    const allowedRoles = new Set(["batsman", "bowler", "allrounder", "wicketkeeper"]);

    if (!name || !/^[A-Za-z ]+$/.test(name)) {
      return res.status(400).json({ message: "Enter a valid player name." });
    }
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ message: "Enter a valid 10-digit mobile number." });
    }
    if (!allowedRoles.has(role)) {
      return res.status(400).json({ message: "Choose a valid player role." });
    }

    const updatedPlayer = await sql`
      UPDATE players
      SET name = ${name},
          mobile = ${mobile},
          role = ${role}
      WHERE id = ${id}
      RETURNING *
    `;
    if (updatedPlayer.length === 0) {
      return res.status(404).json({ message: "Player not found" });
    }
    res
      .status(200)
      .json({
        message: "Player updated successfully",
        player: updatedPlayer[0],
      });
  } catch (error) {
    console.error("Error updating player:", error);
    if (error?.code === "23505") {
      return res.status(409).json({ message: "A player with this mobile number already exists." });
    }
    res
      .status(500)
      .json({ message: "Failed to update player", error: error.message });
  }
};

// Delete Player
export const deletePlayer = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPlayer =
      await sql`DELETE FROM players WHERE id = ${id} RETURNING *`;
    if (deletedPlayer.length === 0) {
      return res.status(404).json({ message: "Player not found" });
    }
    res
      .status(200)
      .json({
        message: "Player deleted successfully",
        player: deletedPlayer[0],
      });
  } catch (error) {
    console.error("Error deleting player:", error);
    res
      .status(500)
      .json({ message: "Failed to delete player", error: error.message });
  }
};

export const getPlayersByName = async (req, res) => {
  try {
    const { name } = req.query;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    const players =
      await sql`SELECT * FROM players WHERE name ILIKE ${"%" + name + "%"}`;

    if (players.length === 0) {
      return res
        .status(404)
        .json({ message: "No players found with that name" });
    }

    res
      .status(200)
      .json({ message: "Players retrieved successfully", players });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to retrieve players", error: error.message });
  }
};

export const getPlayersByNameOrMobile = async (req, res) => {
  try {
    const { query, mobile } = req.query;
    const searchInput = String(query || mobile || "").trim();
    const numericQuery = searchInput.replace(/\D/g, "");

    if (!searchInput) {
      return res.status(400).json({ message: "Search query is required" });
    }

    let players = [];

    if (numericQuery.length > 0) {
      // Mobile-first search for better phone suggestions.
      players = await sql`
        SELECT * FROM players
        WHERE mobile LIKE ${numericQuery + "%"}
           OR mobile LIKE ${"%" + numericQuery + "%"}
        ORDER BY
          CASE
            WHEN mobile = ${numericQuery} THEN 0
            WHEN mobile LIKE ${numericQuery + "%"} THEN 1
            ELSE 2
          END,
          name ASC
        LIMIT 20
      `;
    } else {
      players = await sql`
        SELECT * FROM players
        WHERE name ILIKE ${"%" + searchInput + "%"}
        ORDER BY name ASC
        LIMIT 20
      `;
    }

    res
      .status(200)
      .json({
        message: "Players retrieved successfully",
        players: players || [],
      });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to retrieve players", error: error.message });
  }
};
