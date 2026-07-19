import express from 'express';
import {
    createPlayer,
    deletePlayer,
    getAllPlayers,
    getPlayersByNameOrMobile,
    updatePlayer
} from '../controllers/playersController.js';

const router = express.Router();

router.get('/', getAllPlayers);

router.post('/add', createPlayer);

router.put('/:id', updatePlayer);

router.delete('/:id', deletePlayer);

router.get('/search', getPlayersByNameOrMobile);

export default router;
