import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import {
  closeMongoDB,
  getMongoDiagnostics,
  initDB,
  initMongoDB,
  sql,
} from "../src/config/db.js";
import { clearExpiredPlayerNotifications } from "./controllers/teamPlayersController.js";
import {
  clearStaleTournamentJoinRequests,
  removeTeamsWithInsufficientPlayers,
} from "./controllers/tournamentTeamsController.js";
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

const MAINTENANCE_ENABLED =
  String(process.env.DB_MAINTENANCE_ENABLED || "false").toLowerCase() ===
  "true";
const MAINTENANCE_CRON = process.env.DB_MAINTENANCE_CRON || "0 * * * *";
const MONGODB_CONNECT_ON_STARTUP =
  String(process.env.MONGODB_CONNECT_ON_STARTUP || "true").toLowerCase() ===
  "true";

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

app.get("/api/admin/db-activity", async (req, res) => {
  try {
    const neonResult = await sql.query(
      `SELECT
         usename,
         state,
         COUNT(*)::int AS connection_count
       FROM pg_stat_activity
       WHERE datname = current_database()
       GROUP BY usename, state
       ORDER BY connection_count DESC, usename ASC`,
    );

    const rows = Array.isArray(neonResult?.rows)
      ? neonResult.rows
      : Array.isArray(neonResult)
        ? neonResult
        : [];
    const mongo = await getMongoDiagnostics();

    return res.status(200).json({
      maintenanceEnabled: MAINTENANCE_ENABLED,
      maintenanceCron: MAINTENANCE_CRON,
      neon: {
        activeConnections: rows,
      },
      mongo,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to inspect DB activity" });
  }
});

async function runMaintenanceJobs() {
  await clearStaleTournamentJoinRequests();
  await clearExpiredPlayerNotifications();
  await removeTeamsWithInsufficientPlayers();
}

// Cleanup endpoint - remove teams with insufficient players
app.post("/api/admin/cleanup", async (req, res) => {
  try {
    await runMaintenanceJobs();
    res.json({ message: "Cleanup completed successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

if (MAINTENANCE_ENABLED) {
  cron.schedule(MAINTENANCE_CRON, async () => {
    try {
      await runMaintenanceJobs();
    } catch (error) {
      console.error("Scheduled maintenance error:", error.message);
    }
  });
  console.log(`DB maintenance cron enabled: ${MAINTENANCE_CRON}`);
} else {
  console.log(
    "DB maintenance cron disabled. Set DB_MAINTENANCE_ENABLED=true to enable.",
  );
}

async function startServer() {
  try {
    await initDB();

    if (MONGODB_CONNECT_ON_STARTUP) {
      try {
        await initMongoDB();
      } catch (error) {
        console.error(
          "MongoDB startup warning: scorecard features will be unavailable until MongoDB reconnects.",
          error,
        );
      }
    } else {
      console.log(
        "MongoDB startup connection is disabled (MONGODB_CONNECT_ON_STARTUP=false).",
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
