import express from 'express';
import {
    addTeamToTournament,
    approveTeamInTournament,
    deleteTeamFromTournament,
    getPendingRequestsByOrganizer,
    getTeamByTournamentAndTeamId,
    getTeamsByTournament,
    getTeamsByTournamentAndTeamIds,
    getTournamentsForTeams,
    rejectTeamInTournament,
    updateTeamInTournament
} from '../controllers/tournamentTeamsController.js';

const router = express.Router();

// Add a team to a tournament
router.post('/add', addTeamToTournament);

// Update fee_paid for a team in a tournament
router.put('/update', updateTeamInTournament);

// Approve a team in a tournament
router.put('/approve', approveTeamInTournament);

// Reject (remove) a team from a tournament
router.delete('/reject', rejectTeamInTournament);

// Get pending requests for organiser notifications
router.get('/pending/:organiser_contact', getPendingRequestsByOrganizer);

// Get all teams for a tournament
router.get('/:tournament_id', getTeamsByTournament);

// Get teams by tournament and team IDs (expects team_ids array in body)
router.post('/:tournament_id/teams', getTeamsByTournamentAndTeamIds);

router.post('/list', getTournamentsForTeams);

// Get a single team by tournament and team ID
router.get('/:tournament_id/team/:team_id', getTeamByTournamentAndTeamId);

// Delete a team from a tournament
router.delete('/remove', deleteTeamFromTournament);

export default router;