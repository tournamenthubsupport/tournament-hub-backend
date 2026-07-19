import { sql } from "../config/db.js";

// Get All Players
export const getSports = async (req, res) => {
    try {
      const sports = await sql`SELECT * FROM sports`;
      res.status(200).json({ message: "Sports retrieved successfully", sports });
    } catch (error) {
      console.error("Error fetching Sports:", error);
      res.status(500).json({ message: "Failed to retrieve players", error: error.message });
    }
  };

export const getSportById = async (req, res) => {
  try {
    const { id } = req.params;
    const sport = await sql`SELECT * FROM sports WHERE id = ${id}`;
    if (sport.length === 0) {
      return res.status(404).json({ message: "Sport not found" });
    }
    res.status(200).json({ message: "Sport retrieved successfully", sport: sport[0] });
  } catch (error) {
    console.error("Error fetching sport:", error);
    res.status(500).json({ message: "Failed to retrieve sport", error: error.message });
  }
}