import { sql } from "../config/db.js";

export async function getTournamentRosterConflicts(tournamentId, teamId) {
  return sql.query(
    `SELECT DISTINCT
       p.id AS player_id,
       p.name AS player_name,
       p.mobile AS player_mobile,
       other_team.id AS conflicting_team_id,
       other_team.name AS conflicting_team_name
     FROM team_players candidate
     INNER JOIN team_players existing
       ON existing.player_id = candidate.player_id
      AND existing.team_id <> candidate.team_id
     INNER JOIN tournament_teams existing_entry
       ON existing_entry.team_id = existing.team_id
      AND existing_entry.tournament_id = $1
     INNER JOIN players p ON p.id = candidate.player_id
     INNER JOIN teams other_team ON other_team.id = existing.team_id
     WHERE candidate.team_id = $2
     ORDER BY p.name, other_team.name`,
    [Number(tournamentId), Number(teamId)],
  );
}

export async function getPlayerAssignmentTournamentConflicts(teamId, playerIds) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) return [];

  return sql.query(
    `SELECT DISTINCT
       candidate_entry.tournament_id,
       tournament.name AS tournament_name,
       p.id AS player_id,
       p.name AS player_name,
       p.mobile AS player_mobile,
       other_team.id AS conflicting_team_id,
       other_team.name AS conflicting_team_name
     FROM tournament_teams candidate_entry
     INNER JOIN tournaments tournament
       ON tournament.id = candidate_entry.tournament_id
     INNER JOIN tournament_teams existing_entry
       ON existing_entry.tournament_id = candidate_entry.tournament_id
      AND existing_entry.team_id <> candidate_entry.team_id
     INNER JOIN team_players existing
       ON existing.team_id = existing_entry.team_id
      AND existing.player_id = ANY($2::bigint[])
     INNER JOIN players p ON p.id = existing.player_id
     INNER JOIN teams other_team ON other_team.id = existing_entry.team_id
     WHERE candidate_entry.team_id = $1
     ORDER BY tournament.name, p.name, other_team.name`,
    [Number(teamId), playerIds.map(Number)],
  );
}

export function buildTournamentRosterConflictResponse(conflicts) {
  const firstConflict = conflicts?.[0];
  const playerName = firstConflict?.player_name || "A player";
  const teamName = firstConflict?.conflicting_team_name || "another team";
  const tournamentName = firstConflict?.tournament_name;
  const tournamentText = tournamentName ? ` in ${tournamentName}` : " in this tournament";

  return {
    error: `${playerName} is already registered with ${teamName}${tournamentText}. A player can represent only one team in the same tournament.`,
    code: "PLAYER_ALREADY_IN_TOURNAMENT",
    conflicts,
  };
}