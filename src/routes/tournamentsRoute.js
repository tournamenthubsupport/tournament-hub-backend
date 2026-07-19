import express from "express";

import {
    addBallEvent,
    completeMatchScorecard,
    getMatchScorecard,
    replaceLastBallEvent,
    resetMatchScorecard,
    setupMatchScorecard,
    undoLastBallEvent,
} from "../controllers/matchScorecardController.js";
import {
    completeMatchWithWinner,
    getTournamentMatches,
    resetTournamentMatches,
    scheduleTournamentMatches,
    setMatchToss,
    startScheduledMatch,
} from "../controllers/matchesController.js";
import {
    addTournament,
    deleteTournament,
    deleteTournamentByContact,
    getGroundSuggestions,
    getTournamentByContact,
    getTournamentById,
    getTournamentList,
    updateTournament,
} from "../controllers/tournamentsController.js";
const router = express.Router();

router.get("/", getTournamentList);

router.get("/ground-suggestions", getGroundSuggestions);

router.get("/contact/:organiser_contact", getTournamentByContact);

router.get("/id/:id", getTournamentById);

router.get("/:id/matches", getTournamentMatches);

router.post("/:id/matches/schedule", scheduleTournamentMatches);

router.delete("/:id/matches/reset", resetTournamentMatches);

router.put("/matches/:matchId/start", startScheduledMatch);

router.put("/matches/:matchId/toss", setMatchToss);

router.put("/:id/matches/toss", setMatchToss);

router.put("/matches/:matchId/complete", completeMatchWithWinner);

router.get("/matches/:matchId/scorecard", getMatchScorecard);

router.put("/matches/:matchId/scorecard/setup", setupMatchScorecard);

router.post("/matches/:matchId/scorecard/events", addBallEvent);

router.post("/matches/:matchId/scorecard/events/undo", undoLastBallEvent);

router.put("/matches/:matchId/scorecard/events/last", replaceLastBallEvent);

router.put("/matches/:matchId/scorecard/complete", completeMatchScorecard);

router.delete("/matches/:matchId/scorecard", resetMatchScorecard);

router.post("/add", addTournament);

router.put("/:id", updateTournament);

router.delete("/contact/:organiser_contact", deleteTournamentByContact);

router.delete("/id/:id", deleteTournament);

export default router;
