import express from 'express';
import {
    assignPlayersToTeam,
    getPlayerNotifications,
    getPlayersForTeam,
    getPlayersForTeams,
    getTeamsForPlayer,
    markPlayerNotificationsRead,
    removePlayerFromTeam,
    removePlayerFromTeamByMobile
} from '../controllers/teamPlayersController.js';

const router = express.Router();

// Assign players to a team
router.post('/assign', assignPlayersToTeam);

// Get all players for a team
router.get('/team/:teamId', getPlayersForTeam);

router.post('/list', getPlayersForTeams);

router.get('/player/:mobile/teams', getTeamsForPlayer);

router.get('/player/:mobile/notifications', getPlayerNotifications);

router.put('/player/:mobile/notifications/read', markPlayerNotificationsRead);

// Remove a player from a team
router.delete('/remove/:teamId/:playerId', removePlayerFromTeam);

router.delete('/leave/:teamId/:mobile', removePlayerFromTeamByMobile);

export default router;
