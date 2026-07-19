import { neon } from "@neondatabase/serverless";
import "dotenv/config";
import { MongoClient, ServerApiVersion } from "mongodb";

export const sql = neon(process.env.DATABASE_URL);

let mongoClient;
let mongoDb;

export async function initMongoDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("MONGODB_URI is not set. Skipping MongoDB connection.");
    return null;
  }

  if (mongoDb) {
    return mongoDb;
  }

  mongoClient = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  await mongoClient.connect();
  await mongoClient.db("admin").command({ ping: 1 });

  const dbName = process.env.MONGODB_DB_NAME || "tournament_hub";
  mongoDb = mongoClient.db(dbName);
  await mongoDb
    .collection("match_scorecards")
    .createIndex({ matchId: 1 }, { unique: true });
  console.log(`MongoDB connected successfully (${dbName})`);

  return mongoDb;
}

export function getMongoDB() {
  if (!mongoDb) {
    throw new Error("MongoDB is not initialized. Call initMongoDB() first.");
  }

  return mongoDb;
}

export async function closeMongoDB() {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = undefined;
    mongoDb = undefined;
  }
}

export async function initDB() {
  try {
    // Sports master table
    await sql`
      CREATE TABLE IF NOT EXISTS sports (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      );
    `;
    console.log("Sports table created successfully");

    // Seed default sports (id is kept stable for client references)
    await sql`
      INSERT INTO sports (id, name)
      VALUES
        (1, 'Cricket'),
        (2, 'Football'),
        (3, 'Hockey'),
        (4, 'Basketball'),
        (5, 'Volleyball')
      ON CONFLICT (id)
      DO UPDATE SET name = EXCLUDED.name;
    `;

    await sql`
      SELECT setval(
        pg_get_serial_sequence('sports', 'id'),
        COALESCE((SELECT MAX(id) FROM sports), 1),
        true
      );
    `;

    // Tournaments table
    await sql`
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        sport_id INTEGER NOT NULL,
        location VARCHAR(255) NOT NULL,
        ground VARCHAR(255) NOT NULL,
        organiser_name VARCHAR(100) NOT NULL,
        organiser_contact VARCHAR(15) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        ball_type VARCHAR(50),
        tournament_type VARCHAR(100),
        match_type VARCHAR(100),
        teams INTEGER NOT NULL,
        prize VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Open',
        entry_fees INTEGER,
        state VARCHAR(100),
        city VARCHAR(100),
        created_date DATE NOT NULL DEFAULT CURRENT_DATE
      );
    `;
    console.log("Tournaments table created successfully");

    // Users table for auth
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(15) NOT NULL UNIQUE,
        hashed_mpin VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'player',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Users table created successfully");

    // Safe migration for older DBs where users.role may not exist
    await sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'player';
    `;
    await sql`
      UPDATE users
      SET role = 'player'
      WHERE role IS NULL;
    `;
    await sql`
      ALTER TABLE users
      ALTER COLUMN role SET NOT NULL;
    `;
    await sql`
      ALTER TABLE users
      ALTER COLUMN role SET DEFAULT 'player';
    `;

    // Teams table
    await sql`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255) NOT NULL,
        sport_id INTEGER NOT NULL DEFAULT 1,
        created_by VARCHAR(20)
      );
    `;
    console.log("Teams table created successfully");

    // Safe migrations for older DBs
    await sql`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS sport_id INTEGER DEFAULT 1;
    `;
    await sql`
      UPDATE teams
      SET sport_id = 1
      WHERE sport_id IS NULL;
    `;
    await sql`
      ALTER TABLE teams
      ALTER COLUMN sport_id SET NOT NULL;
    `;
    await sql`
      ALTER TABLE teams
      ALTER COLUMN sport_id SET DEFAULT 1;
    `;
    await sql`
      ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS created_by VARCHAR(20);
    `;

    // Players table
    await sql`
      CREATE TABLE IF NOT EXISTS players (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        mobile VARCHAR(15) NOT NULL UNIQUE,
        role VARCHAR(50) NOT NULL
      );
    `;

    console.log("Players table created successfully");

    // Team–Player join table
    await sql`
    CREATE TABLE IF NOT EXISTS team_players (
      team_id   INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
      PRIMARY KEY (team_id, player_id),
      is_captain BOOLEAN DEFAULT FALSE,
      is_vicecaptain BOOLEAN DEFAULT FALSE
    );
 `;

    console.log("Team_players table created successfully");

    await sql`
      CREATE TABLE IF NOT EXISTS player_notifications (
        id SERIAL PRIMARY KEY,
        player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;

    console.log("Player_notifications table created successfully");

    // Tournament–Team linking table
    await sql`
      CREATE TABLE IF NOT EXISTS tournament_teams (
        tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        team_id       INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fee_paid      BOOLEAN   NOT NULL DEFAULT FALSE,
        is_approved   BOOLEAN   NOT NULL DEFAULT FALSE,
        PRIMARY KEY (tournament_id, team_id)
      );
    `;
    console.log("Tournament_teams table created successfully");

    await sql`
      ALTER TABLE tournament_teams
      ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE;
    `;
    await sql`
      UPDATE tournament_teams
      SET is_approved = FALSE
      WHERE is_approved IS NULL;
    `;
    await sql`
      ALTER TABLE tournament_teams
      ALTER COLUMN is_approved SET NOT NULL;
    `;
    await sql`
      ALTER TABLE tournament_teams
      ALTER COLUMN is_approved SET DEFAULT FALSE;
    `;

    await sql`
      ALTER TABLE tournaments
      ADD COLUMN IF NOT EXISTS state VARCHAR(100);
    `;

    // Matches table
    await sql`
      CREATE TABLE IF NOT EXISTS matches (
        id             SERIAL PRIMARY KEY,
        tournament_id  INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
        home_team_id   INTEGER REFERENCES teams(id),
        away_team_id   INTEGER REFERENCES teams(id),
        match_date     TIMESTAMP NOT NULL,
        venue          VARCHAR(255),
        home_score     INTEGER DEFAULT 0,
        away_score     INTEGER DEFAULT 0,
        status         VARCHAR(50) NOT NULL DEFAULT 'Scheduled',
        round          VARCHAR(100),
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Matches table created successfully");

    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS winner_team_id INTEGER REFERENCES teams(id);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS next_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL;
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS next_slot VARCHAR(10);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS home_from_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL;
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS away_from_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL;
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS toss_result VARCHAR(10);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS toss_winner_team_id INTEGER REFERENCES teams(id);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS toss_decision VARCHAR(10);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS batting_team_id INTEGER REFERENCES teams(id);
    `;
    await sql`
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS fielding_team_id INTEGER REFERENCES teams(id);
    `;

    // Support requests table
    await sql`
      CREATE TABLE IF NOT EXISTS support_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(255),
        user_phone VARCHAR(20),
        role VARCHAR(20),
        category VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        admin_reply TEXT,
        replied_at TIMESTAMP,
        reply_seen_at TIMESTAMP,
        status VARCHAR(30) NOT NULL DEFAULT 'open',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Support_requests table created successfully");

    await sql`
      ALTER TABLE support_requests
      ADD COLUMN IF NOT EXISTS admin_reply TEXT;
    `;

    await sql`
      ALTER TABLE support_requests
      ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;
    `;

    await sql`
      ALTER TABLE support_requests
      ADD COLUMN IF NOT EXISTS reply_seen_at TIMESTAMP;
    `;

    // Admin notifications table (used for support and operational alerts)
    await sql`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id SERIAL PRIMARY KEY,
        notification_type VARCHAR(50) NOT NULL,
        reference_id INTEGER,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    console.log("Admin_notifications table created successfully");
  } catch (error) {
    console.error("Init DB error", error);
    process.exit(1);
  }
}
