
import express from "express";
import cors from "cors";
import session from "express-session";
import MongoStore from "connect-mongo";
import bcrypt from "bcryptjs";
import { MongoClient, ObjectId } from "mongodb";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";

const app = express();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ========================================
// ENVIRONMENT CONFIGURATION
// ========================================

const isProduction = process.env.NODE_ENV === "production";

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

// Vercel runs behind a proxy.
if (isProduction) {
  app.set("trust proxy", 1);
}

// ========================================
// MIDDLEWARE
// ========================================

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header (e.g. health checks).
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    name: "greenlife.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      dbName: process.env.MONGODB_DB || "greenlife",
      collectionName: "sessions",
      touchAfter: 24 * 60 * 60,
    }),

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// ========================================
// MONGODB CONNECTION
// ========================================

let client;

async function connectToMongoDB() {
  if (client) {
    return client;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  const newClient = new MongoClient(process.env.MONGODB_URI);

  try {
    await newClient.connect();
    client = newClient;

    console.log("Successfully connected to MongoDB!");

    return client;
  } catch (error) {
    await newClient.close().catch(() => {});
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

async function getUsersCollection() {
  const mongoClient = await connectToMongoDB();
  const db = mongoClient.db(process.env.MONGODB_DB || "greenlife");

  return db.collection("users");
}

async function getEventsCollection() {
  const mongoClient = await connectToMongoDB();
  const db = mongoClient.db(process.env.MONGODB_DB || "greenlife");

  return db.collection("events");
}

// ========================================
// AUTHENTICATION MIDDLEWARE
// ========================================

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please login first",
    });
  }

  next();
}

// ========================================
// AUTH ROUTES
// ========================================

// REGISTER
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters",
      });
    }

    const users = await getUsersCollection();

    const existing = await users.findOne({
      email: normalizedEmail,
    });

    if (existing) {
      return res.status(409).json({
        error: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await users.insertOne({
      email: normalizedEmail,
      passwordHash,
      name: name?.trim() || "",
      authProvider: "local",
      createdAt: new Date(),
    });

    const profile = {
      id: result.insertedId.toString(),
      email: normalizedEmail,
      name: name?.trim() || "",
    };

    req.session.user = profile;

    req.session.save((error) => {
      if (error) {
        console.error("Registration session error:", error);

        return res.status(500).json({
          error: "Failed to save registration session",
        });
      }

      return res.status(201).json({
        user: profile,
      });
    });
  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      error: "Registration failed",
    });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const users = await getUsersCollection();

    const user = await users.findOne({
      email: normalizedEmail,
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const match = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!match) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const profile = {
      id: user._id.toString(),
      email: user.email,
      name: user.name || "",
    };

    req.session.regenerate((error) => {
      if (error) {
        console.error("Login session error:", error);

        return res.status(500).json({
          error: "Failed to create login session",
        });
      }

      req.session.user = profile;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Login session save error:", saveError);

          return res.status(500).json({
            error: "Failed to save login session",
          });
        }

        return res.json({
          user: profile,
        });
      });
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Login failed",
    });
  }
});

// GOOGLE LOGIN
app.post("/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        error: "Google credential is required",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      return res.status(401).json({
        error: "Invalid or unverified Google account",
      });
    }

    const googleId = payload.sub;
    const email = payload.email.toLowerCase();
    const name = payload.name || "";

    const users = await getUsersCollection();

    let user = await users.findOne({ googleId });

    if (!user) {
      const existingUser = await users.findOne({ email });

      if (existingUser) {
        return res.status(409).json({
          error:
            "An account with this email already exists. Please login using your password first.",
        });
      }

      const result = await users.insertOne({
        email,
        name,
        googleId,
        authProvider: "google",
        emailVerified: true,
        createdAt: new Date(),
      });

      user = {
        _id: result.insertedId,
        email,
        name,
      };
    }

    const profile = {
      id: user._id.toString(),
      email: user.email,
      name: user.name || "",
    };

    req.session.regenerate((error) => {
      if (error) {
        console.error("Google session regeneration error:", error);

        return res.status(500).json({
          error: "Failed to create Google login session",
        });
      }

      req.session.user = profile;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Google session save error:", saveError);

          return res.status(500).json({
            error: "Failed to save Google login session",
          });
        }

        return res.json({
          message: "Google login successful",
          user: profile,
        });
      });
    });
  } catch (error) {
    console.error("Google authentication error:", error);

    return res.status(401).json({
      error: "Google authentication failed",
    });
  }
});

// CURRENT USER
app.get("/auth/me", (req, res) => {
  return res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null,
  });
});

// LOGOUT
app.post("/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        error: "Logout failed",
      });
    }

    res.clearCookie("greenlife.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
    });

    return res.json({
      message: "Logged out successfully",
    });
  });
});

// ========================================
// EVENT ROUTES
// ========================================

// GET ALL EVENTS WITH ORGANIZER INFORMATION
app.get("/events", async (req, res) => {
  try {
    const events = await getEventsCollection();
    const users = await getUsersCollection();

    const result = await events
      .find()
      .sort({ dateTime: 1 })
      .toArray();

    const organizerIds = [
      ...new Set(
        result
          .map((event) => event.organizerId)
          .filter((id) => id && ObjectId.isValid(id))
      ),
    ];

    const organizers = await users
      .find({
        _id: {
          $in: organizerIds.map((id) => new ObjectId(id)),
        },
      })
      .project({ name: 1, email: 1 })
      .toArray();

    const organizerMap = new Map(
      organizers.map((organizer) => [
        organizer._id.toString(),
        {
          name: organizer.name || "Unknown organizer",
          email: organizer.email || "",
        },
      ])
    );

    const formattedEvents = result.map((event) => {
      const { _id, ...rest } = event;

      return {
        ...rest,
        id: _id.toString(),
        attendeeIds: event.attendeeIds ?? [],
        organizer:
          organizerMap.get(event.organizerId) ?? {
            name: "Unknown organizer",
            email: "",
          },
      };
    });

    return res.json({
      events: formattedEvents,
    });
  } catch (error) {
    console.error("Get events error:", error);

    return res.status(500).json({
      error: "Failed to get events",
    });
  }
});

// CREATE EVENT
app.post("/events", requireAuth, async (req, res) => {
  try {
    const {
      title,
      description,
      location,
      dateTime,
      endDateTime,
      category,
      imageUrl,
    } = req.body;

    if (
      !title?.trim() ||
      !description?.trim() ||
      !location?.trim() ||
      !dateTime ||
      !endDateTime ||
      !category?.trim()
    ) {
      return res.status(400).json({
        error: "Please provide all required event information",
      });
    }

    const start = new Date(dateTime);
    const end = new Date(endDateTime);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).json({
        error: "Invalid event date or time",
      });
    }

    if (end <= start) {
      return res.status(400).json({
        error: "Event end time must be after start time",
      });
    }

    const events = await getEventsCollection();

    const newEvent = {
      title: title.trim(),
      description: description.trim(),
      location: location.trim(),
      dateTime,
      endDateTime,
      category: category.trim(),
      imageUrl: imageUrl || "",
      organizerId: req.session.user.id,
      attendeeIds: [],
      createdAt: new Date().toISOString(),
    };

    const result = await events.insertOne(newEvent);

    return res.status(201).json({
      message: "Event created successfully",
      event: {
        ...newEvent,
        id: result.insertedId.toString(),
      },
    });
  } catch (error) {
    console.error("Create event error:", error);

    return res.status(500).json({
      error: "Failed to create event",
    });
  }
});

// GET SINGLE EVENT
app.get("/events/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const event = await events.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      return res.status(404).json({
        error: "Event not found",
      });
    }

    const { _id, ...rest } = event;

    return res.json({
      event: {
        ...rest,
        id: _id.toString(),
        attendeeIds: rest.attendeeIds ?? [],
      },
    });
  } catch (error) {
    console.error("Get event error:", error);

    return res.status(500).json({
      error: "Failed to get event",
    });
  }
});

// JOIN EVENT
app.post("/events/:id/join", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const result = await events.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $addToSet: {
          attendeeIds: req.session.user.id,
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        error: "Event not found",
      });
    }

    const event = await events.findOne({
      _id: new ObjectId(req.params.id),
    });

    return res.json({
      message: "Successfully joined the event",
      attendeeIds: event.attendeeIds ?? [],
    });
  } catch (error) {
    console.error("Join event error:", error);

    return res.status(500).json({
      error: "Failed to join event",
    });
  }
});

// LEAVE EVENT
app.delete("/events/:id/join", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const result = await events.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $pull: {
          attendeeIds: req.session.user.id,
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        error: "Event not found",
      });
    }

    const event = await events.findOne({
      _id: new ObjectId(req.params.id),
    });

    return res.json({
      message: "Successfully left the event",
      attendeeIds: event.attendeeIds ?? [],
    });
  } catch (error) {
    console.error("Leave event error:", error);

    return res.status(500).json({
      error: "Failed to leave event",
    });
  }
});

// DELETE EVENT - ORGANIZER ONLY
app.delete("/events/:id", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const result = await events.deleteOne({
      _id: new ObjectId(req.params.id),
      organizerId: req.session.user.id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        error: "Event not found or you are not its organizer",
      });
    }

    return res.json({
      message: "Event deleted successfully",
    });
  } catch (error) {
    console.error("Delete event error:", error);

    return res.status(500).json({
      error: "Failed to delete event",
    });
  }
});

// UPDATE EVENT - ORGANIZER ONLY
app.patch("/events/:id", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const existingEvent = await events.findOne({
      _id: new ObjectId(req.params.id),
      organizerId: req.session.user.id,
    });

    if (!existingEvent) {
      return res.status(404).json({
        error: "Event not found or you are not its organizer",
      });
    }

    const allowedFields = [
      "title",
      "description",
      "location",
      "dateTime",
      "endDateTime",
      "category",
      "imageUrl",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "No valid fields provided",
      });
    }

    const startDateTime =
      updates.dateTime ?? existingEvent.dateTime;

    const endDateTime =
      updates.endDateTime ?? existingEvent.endDateTime;

    if (!startDateTime || !endDateTime) {
      return res.status(400).json({
        error: "Both event start and end times are required",
      });
    }

    const start = new Date(startDateTime);
    const end = new Date(endDateTime);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).json({
        error: "Invalid event date or time",
      });
    }

    if (end <= start) {
      return res.status(400).json({
        error: "Event end time must be after start time",
      });
    }

    const result = await events.findOneAndUpdate(
      {
        _id: new ObjectId(req.params.id),
        organizerId: req.session.user.id,
      },
      {
        $set: updates,
      },
      {
        returnDocument: "after",
      }
    );

    if (!result) {
      return res.status(404).json({
        error: "Event not found or you are not its organizer",
      });
    }

    const { _id, ...rest } = result;

    return res.json({
      message: "Event updated successfully",
      event: {
        ...rest,
        id: _id.toString(),
        attendeeIds: rest.attendeeIds ?? [],
      },
    });
  } catch (error) {
    console.error("Update event error:", error);

    return res.status(500).json({
      error: "Failed to update event",
    });
  }
});

// ========================================
// HOME AND HEALTH ROUTES
// ========================================

app.get("/", (req, res) => {
  res.json({
    message: "GreenLife server is running",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "GreenLife API is running",
  });
});

// ========================================
// ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "Internal server error",
  });
});

// ========================================
// VERCEL EXPORT
// ========================================

// Do not use app.listen() when deploying this Express app
// as a Vercel serverless application.

const PORT = Number(process.env.PORT) || 5001;

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GreenLife server running on port ${PORT}`);
  });
}

export default app;