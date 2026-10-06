import { sql } from "../config/db.js";

export const createTeam = async (req, res) => {
  try {
    const { name, state, city, location, sportId, createdBy } = req.body;
    if (!name || !state || !city || !location || !createdBy) {
      return res.status(400).json({ message: "name, state, city, location and createdBy are required" });
    }

    const normalizedSportId = Number(sportId) || 1;
    const existingTeam = await sql`
      SELECT id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
      FROM teams
        WHERE LOWER(REGEXP_REPLACE(TRIM(name), '\s+', ' ', 'g')) =
          LOWER(REGEXP_REPLACE(TRIM(${name}), '\s+', ' ', 'g'))
        AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(city, '')), '\s+', ' ', 'g')) =
          LOWER(REGEXP_REPLACE(TRIM(${city}), '\s+', ' ', 'g'))
        AND LOWER(REGEXP_REPLACE(TRIM(location), '\s+', ' ', 'g')) =
          LOWER(REGEXP_REPLACE(TRIM(${location}), '\s+', ' ', 'g'))
      ORDER BY id
      LIMIT 1
    `;

    if (existingTeam.length > 0) {
      return res.status(409).json({
        error: `Team "${existingTeam[0].name}" already exists in ${existingTeam[0].location}, ${existingTeam[0].city}. Please choose another team name.`,
        code: "TEAM_ALREADY_EXISTS",
        team: existingTeam[0],
      });
    }

    const newTeam = await sql`
      INSERT INTO teams (name, state, city, location, sport_id, created_by)
      VALUES (${name}, ${state}, ${city}, ${location}, ${normalizedSportId}, ${createdBy})
      RETURNING id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
    `;
    res.status(201).json({
      message: "Team created successfully",
      team: newTeam[0],
    });
  } catch (error) {
    console.error("Error creating team:", error);
    res.status(500).json({ message: "Failed to create team", error: error.message });
  }
};

export const getAllTeams = async (req, res) => {
  try {
    const teams = await sql`
      SELECT id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
      FROM teams
    `;
    res.status(200).json({
      message: "Teams retrieved successfully",
      teams: teams,
    });
  } catch (error) {
    console.error("Error getting all teams:", error);
    res.status(500).json({ message: "Failed to retrieve teams", error: error.message });
  }
};

export const getTeamsCreatedByYou = async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile) {
      return res.status(400).json({ message: "Mobile number is required" });
    }

    const teams = await sql`
      SELECT id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
      FROM teams
      WHERE created_by = ${mobile}
    `;

    res.status(200).json({
      message: "Teams retrieved successfully",
      teams: teams,
    });
  } catch (error) {
    console.error("Error getting teams by mobile number:", error);
    res.status(500).json({ message: "Failed to retrieve teams", error: error.message });
  }
};


export const getTeamById = async (req, res) => {
  try {
    const { id } = req.params;
    const team = await sql`
      SELECT id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
      FROM teams
      WHERE id = ${id}
    `;
    if (team.length === 0) {
      return res.status(404).json({ message: "Team not found" });
    }
    res.status(200).json({
      message: "Team retrieved successfully",
      team: team[0],
    });
  } catch (error) {
    console.error("Error getting team by ID:", error);
    res.status(500).json({ message: "Failed to retrieve team", error: error.message });
  }
};

export const getTeamsByIds = async (req, res) => {
  try {
    const { teamIds } = req.body; // expects array
    if (!Array.isArray(teamIds) || teamIds.length === 0) {
      return res.status(400).json({ message: "teamIds array required" });
    }
    const teams = await sql`
      SELECT id, name, state, city, location, sport_id AS "sportId", created_by AS "createdBy"
      FROM teams
      WHERE id = ANY(${teamIds})
    `;
    res.status(200).json(teams);
  } catch (error) {
    console.error('Error fetching teams by IDs:', error);
    res.status(500).json({ message: 'Failed to fetch teams', error: error.message });
  }
};

export const updateTeam = async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body?.name || "").trim();
    const state = String(req.body?.state || "").trim();
    const city = String(req.body?.city || "").trim();
    const location = String(req.body?.location || "").trim();

    if (!name || !state || !city || !location) {
      return res.status(400).json({ message: "Team name, state, city, and location are required." });
    }

    const duplicateTeam = await sql`
      SELECT id
      FROM teams
      WHERE id <> ${id}
        AND LOWER(REGEXP_REPLACE(TRIM(name), '\s+', ' ', 'g')) =
            LOWER(REGEXP_REPLACE(TRIM(${name}), '\s+', ' ', 'g'))
        AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(city, '')), '\s+', ' ', 'g')) =
            LOWER(REGEXP_REPLACE(TRIM(${city}), '\s+', ' ', 'g'))
        AND LOWER(REGEXP_REPLACE(TRIM(location), '\s+', ' ', 'g')) =
            LOWER(REGEXP_REPLACE(TRIM(${location}), '\s+', ' ', 'g'))
      LIMIT 1
    `;
    if (duplicateTeam.length > 0) {
      return res.status(409).json({ message: "A team with this name, city, and location already exists." });
    }

    const updatedTeam = await sql`
      UPDATE teams
      SET name = ${name},
          state = ${state},
          city = ${city},
          location = ${location}
      WHERE id = ${id}
      RETURNING *
    `;
    if (updatedTeam.length === 0) {
      return res.status(404).json({ message: "Team not found" });
    }
    res.status(200).json({
      message: "Team updated successfully",
      team: updatedTeam[0],
    });
  } catch (error) {
    console.error("Error updating team:", error);
    res.status(500).json({ message: "Failed to update team", error: error.message });
  }
};

export const deleteTeam = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedTeam = await sql`
      DELETE FROM teams
      WHERE id = ${id}
      RETURNING *
    `;
    if (deletedTeam.length === 0) {
      return res.status(404).json({ message: "Team not found" });
    }
    res.status(200).json({
      message: "Team deleted successfully",
      team: deletedTeam[0],
    });
  } catch (error) {
    console.error("Error deleting team:", error);
    res.status(500).json({ message: "Failed to delete team", error: error.message });
  }
};