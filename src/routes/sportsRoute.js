import express from 'express';
import {
    getSportById,
    getSports
} from '../controllers/sportsController.js';

const router = express.Router();

router.get('/', getSports);
router.get('/:id', getSportById);

export default router;
