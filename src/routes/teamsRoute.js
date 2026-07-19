import express from 'express';
import {
    createTeam,
    deleteTeam,
    getAllTeams,
    getTeamById,
    getTeamsByIds,
    getTeamsCreatedByYou,
    updateTeam,
} from '../controllers/teamsController.js';

const router = express.Router();

router.get('/', getAllTeams);

router.post("/search", getTeamsCreatedByYou)

router.get('/:id', getTeamById);

router.post('/by-ids', getTeamsByIds);

router.post('/add', createTeam);

router.put('/:id', updateTeam);

router.delete('/:id', deleteTeam);


export default router;