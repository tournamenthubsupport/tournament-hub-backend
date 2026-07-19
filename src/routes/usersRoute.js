import express from "express";
import {
    authenticateUser,
    createUser,
    deleteAdminNotification,
    getAdminNotifications,
    getSupportRepliesForUser,
    replyToSupportRequest,
    submitSupportRequest,
} from "../controllers/usersController.js";

const router = express.Router();

// Signup route
router.post("/signup", createUser);
// Signin route
router.post("/signin", authenticateUser);
// Help & support request route
router.post("/support", submitSupportRequest);

// Admin notification routes
router.get("/admin/notifications", getAdminNotifications);
router.delete("/admin/notifications/:id", deleteAdminNotification);
router.post("/admin/notifications/:id/reply", replyToSupportRequest);

// Organizer/player support reply route
router.get('/support/replies/:phone', getSupportRepliesForUser);

export default router;
