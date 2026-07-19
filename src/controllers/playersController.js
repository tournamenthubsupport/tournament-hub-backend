import { sql } from "../config/db.js";

// Add Player
export const createPlayer = async (req, res) => {
  try {
    const { id, name, mobile, role } = req.body;

    // Check if mobile already exists
    const existing = await sql`SELECT * FROM players WHERE mobile = ${mobile}`;
    if (existing.length > 0) {
      return res.status(409).json({ message: "Mobile number already exists", player: existing[0] });
    }

    const newPlayer = await sql`
      INSERT INTO players (id, name, mobile, role)
      VALUES (${id}, ${name}, ${mobile}, ${role})
      RETURNING *
    `;
    res.status(201).json({ message: "Player created successfully", player: newPlayer[0] });
  } catch (error) {
    console.error("Error creating player:", error);
    res.status(500).json({ message: "Failed to create player", error: error.message });
  }
};

// Get All Players
export const getAllPlayers = async (req, res) => {
  try {
    const players = await sql`SELECT * FROM players`;
    res.status(200).json({ message: "Players retrieved successfully", players });
  } catch (error) {
    console.error("Error fetching players:", error);
    res.status(500).json({ message: "Failed to retrieve players", error: error.message });
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
    const { name, mobile, role, iscaptain, isvicecaptain } = req.body;
    const updatedPlayer = await sql`
      UPDATE players
      SET name = ${name},
          mobile = ${mobile},
          role = ${role},
          iscaptain = ${iscaptain},
          isvicecaptain = ${isvicecaptain}
      WHERE id = ${id}
      RETURNING *
    `;
    if (updatedPlayer.length === 0) {
      return res.status(404).json({ message: "Player not found" });
    }
    res.status(200).json({ message: "Player updated successfully", player: updatedPlayer[0] });
  } catch (error) {
    console.error("Error updating player:", error);
    res.status(500).json({ message: "Failed to update player", error: error.message });
  }
};

// Delete Player
export const deletePlayer = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedPlayer = await sql`DELETE FROM players WHERE id = ${id} RETURNING *`;
    if (deletedPlayer.length === 0) {
      return res.status(404).json({ message: "Player not found" });
    }
    res.status(200).json({ message: "Player deleted successfully", player: deletedPlayer[0] });
  } catch (error) {
    console.error("Error deleting player:", error);
    res.status(500).json({ message: "Failed to delete player", error: error.message });
  }
};

export const getPlayersByName = async (req, res) => {
  try {
    const { name } = req.query;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    const players = await sql`SELECT * FROM players WHERE name ILIKE ${'%' + name + '%'}`;

    if (players.length === 0) {
      return res.status(404).json({ message: "No players found with that name" });
    }

    res.status(200).json({ message: "Players retrieved successfully", players });
  } catch (error) {
    res.status(500).json({ message: "Failed to retrieve players", error: error.message });
  }
};


export const getPlayersByNameOrMobile = async (req, res) => {
  try {
    const { query, mobile } = req.query;
    const searchInput = String(query || mobile || '').trim();
    const numericQuery = searchInput.replace(/\D/g, '');

    if (!searchInput) {
      return res.status(400).json({ message: "Search query is required" });
    }

    let players = [];

    if (numericQuery.length > 0) {
      // Mobile-first search for better phone suggestions.
      players = await sql`
        SELECT * FROM players
        WHERE mobile LIKE ${numericQuery + '%'}
           OR mobile LIKE ${'%' + numericQuery + '%'}
        ORDER BY
          CASE
            WHEN mobile = ${numericQuery} THEN 0
            WHEN mobile LIKE ${numericQuery + '%'} THEN 1
            ELSE 2
          END,
          name ASC
        LIMIT 20
      `;
    } else {
      players = await sql`
        SELECT * FROM players
        WHERE name ILIKE ${'%' + searchInput + '%'}
        ORDER BY name ASC
        LIMIT 20
      `;
    }

    res.status(200).json({ message: "Players retrieved successfully", players: players || [] });
  } catch (error) {
    res.status(500).json({ message: "Failed to retrieve players", error: error.message });
  }
};


