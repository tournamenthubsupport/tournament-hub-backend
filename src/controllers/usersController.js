import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { sql } from "../config/db.js";

const ADMIN_SUPPORT_EMAIL = "tournamenthubsupport@gmail.com";

const createMailer = () => {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
};

const sendAdminSupportEmail = async ({
  requestId,
  role,
  category,
  description,
  userName,
  userPhone,
  userId,
}) => {
  const transporter = createMailer();
  if (!transporter) {
    console.warn(
      "Support email skipped: SMTP_HOST/SMTP_USER/SMTP_PASS not configured.",
    );
    return;
  }

  const subject = `New ${role} support request #${requestId} - ${category}`;
  const text = [
    "A new support request was submitted.",
    "",
    `Request ID: ${requestId}`,
    `Role: ${role}`,
    `Name: ${userName || "N/A"}`,
    `Phone: ${userPhone || "N/A"}`,
    `User ID: ${userId || "N/A"}`,
    `Category: ${category}`,
    `Description: ${description}`,
  ].join("\n");

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: ADMIN_SUPPORT_EMAIL,
    subject,
    text,
  });
};

// Create a new user
export const createUser = async (req, res) => {
  try {
    const { name, phone, mpin, role } = req.body;
    const normalizedRole =
      role === "admin"
        ? "admin"
        : role === "organizer"
          ? "organizer"
          : "player";
    if (!name || !phone || !mpin) {
      return res
        .status(400)
        .json({ error: "Name, phone, and mpin are required." });
    }
    // Hash the MPIN
    const hashedMpin = await bcrypt.hash(mpin, 10);
    let result;
    try {
      result = await sql`
        INSERT INTO users (name, phone, hashed_mpin, role)
        VALUES (${name}, ${phone}, ${hashedMpin}, ${normalizedRole})
        RETURNING id, name, phone, role;
      `;
    } catch (insertError) {
      // Backward compatibility: if role column is not yet present, create user without role column.
      if (insertError?.code === "42703") {
        result = await sql`
          INSERT INTO users (name, phone, hashed_mpin)
          VALUES (${name}, ${phone}, ${hashedMpin})
          RETURNING id, name, phone;
        `;
        result[0].role = normalizedRole;
      } else {
        throw insertError;
      }
    }
    res.status(201).json(result[0]);
  } catch (error) {
    if (error.code === "23505") {
      // Unique violation
      return res.status(409).json({ error: "Phone number already exists." });
    }
    res.status(500).json({ error: "Failed to create user." });
  }
};

// Authenticate user by phone and mpin
export const authenticateUser = async (req, res) => {
  try {
    const { phone, mpin } = req.body;
    if (!phone || !mpin) {
      return res.status(400).json({ error: "Phone and mpin are required." });
    }
    const users = await sql`SELECT * FROM users WHERE phone = ${phone}`;
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    const user = users[0];
    const isMatch = await bcrypt.compare(mpin, user.hashed_mpin);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid MPIN." });
    }
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role || "player",
      token: bcrypt.hashSync(`${user.id}:${user.phone}`, 10),
    });
  } catch (error) {
    res.status(500).json({ error: "Authentication failed." });
  }
};

// Submit a help/support request and notify admin.
export const submitSupportRequest = async (req, res) => {
  try {
    const { user_id, user_name, user_phone, role, category, description } =
      req.body;

    if (!category || !description) {
      return res
        .status(400)
        .json({ error: "Category and description are required." });
    }

    const normalizedRole =
      role === "admin"
        ? "admin"
        : role === "organizer"
          ? "organizer"
          : "player";

    const supportRows = await sql`
      INSERT INTO support_requests (user_id, user_name, user_phone, role, category, description)
      VALUES (${user_id || null}, ${user_name || null}, ${user_phone || null}, ${normalizedRole}, ${category}, ${description})
      RETURNING *;
    `;

    const supportRequest = supportRows[0];

    await sql`
      INSERT INTO admin_notifications (notification_type, reference_id, title, message)
      VALUES (
        'support_request',
        ${supportRequest.id},
        ${`Support: ${category}`},
        ${`New support request from ${user_name || "User"} (${user_phone || "N/A"}) - ${description}`}
      );
    `;

    if (normalizedRole === "organizer" || normalizedRole === "player") {
      try {
        await sendAdminSupportEmail({
          requestId: supportRequest.id,
          role: normalizedRole,
          category,
          description,
          userName: user_name,
          userPhone: user_phone,
          userId: user_id,
        });
      } catch (emailError) {
        console.error("Failed to send support request email:", emailError);
      }
    }

    return res.status(201).json({
      message: "Support request submitted. Admin has been notified.",
      supportRequest,
    });
  } catch (error) {
    console.error("Failed to submit support request:", error);
    return res.status(500).json({ error: "Failed to submit support request." });
  }
};

export const getAdminNotifications = async (req, res) => {
  try {
    const notifications = await sql`
      SELECT
        an.id,
        an.notification_type AS "notificationType",
        an.reference_id AS "referenceId",
        an.title,
        an.message,
        an.is_read AS "isRead",
        an.created_at AS "createdAt",
        sr.user_name AS "userName",
        sr.user_phone AS "userPhone",
        sr.role AS "userRole",
        sr.category,
        sr.description,
        sr.status AS "supportStatus",
        sr.admin_reply AS "adminReply",
        sr.replied_at AS "repliedAt"
      FROM admin_notifications an
      LEFT JOIN support_requests sr
        ON an.notification_type = 'support_request'
       AND an.reference_id = sr.id
      ORDER BY an.created_at DESC, an.id DESC
    `;

    return res.status(200).json({ notifications });
  } catch (error) {
    console.error("Failed to fetch admin notifications:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch admin notifications." });
  }
};

export const deleteAdminNotification = async (req, res) => {
  try {
    const { id } = req.params;

    const rows = await sql`
      DELETE FROM admin_notifications
      WHERE id = ${id}
      RETURNING id
    `;

    if (rows.length === 0) {
      return res.status(404).json({ error: "Notification not found." });
    }

    return res
      .status(200)
      .json({ message: "Notification deleted successfully." });
  } catch (error) {
    console.error("Failed to delete admin notification:", error);
    return res
      .status(500)
      .json({ error: "Failed to delete admin notification." });
  }
};

export const replyToSupportRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { replyMessage } = req.body;

    const normalizedReply = String(replyMessage || "").trim();
    if (!normalizedReply) {
      return res.status(400).json({ error: "Reply message is required." });
    }

    const notificationRows = await sql`
      SELECT id, notification_type AS "notificationType", reference_id AS "referenceId"
      FROM admin_notifications
      WHERE id = ${id}
      LIMIT 1
    `;

    if (notificationRows.length === 0) {
      return res.status(404).json({ error: "Notification not found." });
    }

    const notification = notificationRows[0];
    if (
      notification.notificationType !== "support_request" ||
      !notification.referenceId
    ) {
      return res
        .status(400)
        .json({
          error:
            "Replies are only supported for support request notifications.",
        });
    }

    const supportRows = await sql`
      UPDATE support_requests
      SET
        admin_reply = ${normalizedReply},
        replied_at = CURRENT_TIMESTAMP,
        status = 'replied'
      WHERE id = ${notification.referenceId}
      RETURNING id, user_name AS "userName", user_phone AS "userPhone", admin_reply AS "adminReply", replied_at AS "repliedAt"
    `;

    if (supportRows.length === 0) {
      return res
        .status(404)
        .json({ error: "Related support request not found." });
    }

    await sql`
      UPDATE admin_notifications
      SET
        is_read = TRUE,
        message = ${`Support reply sent: ${normalizedReply}`}
      WHERE id = ${id}
    `;

    return res.status(200).json({
      message: "Reply saved successfully.",
      supportRequest: supportRows[0],
    });
  } catch (error) {
    console.error("Failed to reply to support request:", error);
    return res
      .status(500)
      .json({ error: "Failed to reply to support request." });
  }
};

export const getSupportRepliesForUser = async (req, res) => {
  try {
    const { phone } = req.params;
    const normalizedPhone = String(phone || '').trim();

    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Phone is required.' });
    }

    const staleRows = await sql`
      DELETE FROM support_requests
      WHERE reply_seen_at IS NOT NULL
        AND reply_seen_at < NOW() - INTERVAL '7 day'
      RETURNING id
    `;

    if (staleRows.length > 0) {
      await Promise.all(
        staleRows.map((row) =>
          sql`
            DELETE FROM admin_notifications
            WHERE notification_type = 'support_request'
              AND reference_id = ${row.id}
          `,
        ),
      );
    }

    await sql`
      UPDATE support_requests
      SET reply_seen_at = CURRENT_TIMESTAMP
      WHERE (user_phone = ${normalizedPhone} OR user_id::text = ${normalizedPhone})
        AND admin_reply IS NOT NULL
        AND reply_seen_at IS NULL
    `;

    const requests = await sql`
      SELECT
        id,
        category,
        description,
        role,
        status,
        admin_reply AS "adminReply",
        replied_at AS "repliedAt",
        reply_seen_at AS "replySeenAt",
        created_at AS "createdAt"
      FROM support_requests
      WHERE user_phone = ${normalizedPhone}
         OR user_id::text = ${normalizedPhone}
      ORDER BY created_at DESC, id DESC
    `;

    return res.status(200).json({ requests });
  } catch (error) {
    console.error('Failed to fetch support replies:', error);
    return res.status(500).json({ error: 'Failed to fetch support replies.' });
  }
};
