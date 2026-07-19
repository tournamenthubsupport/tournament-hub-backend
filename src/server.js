import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import { closeMongoDB, initDB, initMongoDB } from "../src/config/db.js";
import { clearExpiredPlayerNotifications } from "./controllers/teamPlayersController.js";
import { clearStaleTournamentJoinRequests, removeTeamsWithInsufficientPlayers } from "./controllers/tournamentTeamsController.js";
import playersRouter from "./routes/playersRoute.js";
import sportsRouter from "./routes/sportsRoute.js";
import teamPlayersRouter from "./routes/teamPlayersRoute.js";
import teamsRouter from "./routes/teamsRoute.js";
import tournamentsRouter from "./routes/tournamentsRoute.js";
import tournamentsTeamsRouter from "./routes/tournamentTeamsRoute.js";
import usersRouter from "./routes/usersRoute.js";

dotenv.config();
const app = express();
app.use(express.json());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "PUT"],
    credentials: false,
  }),
);

app.use("/api/tournaments", tournamentsRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/players", playersRouter);
app.use("/api/team-players", teamPlayersRouter);
app.use("/api/sports", sportsRouter);
app.use("/api/tournament-teams", tournamentsTeamsRouter);
app.use("/api/users", usersRouter);

const PORT = process.env.PORT || 5000;

app.get("/health", (req, res) => {
  res.send("It's working");
});

// Cleanup endpoint - remove teams with insufficient players
app.post("/api/admin/cleanup", async (req, res) => {
  try {
    await removeTeamsWithInsufficientPlayers();
    res.json({ message: "Cleanup completed successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule API call every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  try {
    await clearStaleTournamentJoinRequests();
    await clearExpiredPlayerNotifications();
    await removeTeamsWithInsufficientPlayers();
  } catch (error) {
    console.error("Scheduled API call error:", error.message);
  }
});

async function startServer() {
  try {
    await initDB();

    try {
      await initMongoDB();
    } catch (error) {
      console.error(
        "MongoDB startup warning: scorecard features will be unavailable until MongoDB reconnects.",
        error,
      );
    }

    const server = app.listen(PORT, () => {
      console.log(`Backend server running on port ${PORT}`);
    });

    server.on("error", async (error) => {
      if (error?.code === "EADDRINUSE") {
        console.error(
          `Port ${PORT} is already in use. Stop the existing process or run: npm run start:clean`,
        );
      } else {
        console.error("HTTP server error:", error);
      }

      await closeMongoDB();
      process.exit(1);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await closeMongoDB();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeMongoDB();
  process.exit(0);
});

startServer();
