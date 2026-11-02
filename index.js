
import express from "express";
import cors from "cors";
import session from "express-session";
import bcrypt from "bcryptjs";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const app = express();
const PORT = Number(process.env.PORT) || 5001;

// ========================================
// Middleware
// ========================================

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// ========================================
// MongoDB Connection
// ========================================

let client;

export async function connectToMongoDB() {
  if (client) return client;

  client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
    return client;
  } catch (err) {
    client = null;
    console.error("MongoDB connection failed:", err);
    throw err;
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
// Authentication Middleware
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

// Register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "email and password required",
      });
    }

    const users = await getUsersCollection();

    const existing = await users.findOne({ email });

    if (existing) {
      return res.status(409).json({
        error: "email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await users.insertOne({
      email,
      passwordHash,
      name: name || "",
      createdAt: new Date(),
    });

    const user = {
      id: result.insertedId.toString(),
      email,
      name: name || "",
    };

    req.session.user = user;

req.session.save((err) => {
  if (err) {
    console.error("Session save error:", err);

    return res.status(500).json({
      error: "Failed to save registration session",
    });
  }

  return res.status(201).json({ user });
});
  } catch (err) {
    console.error("Registration error:", err);

    return res.status(500).json({
      error: "registration failed",
    });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "email and password required",
      });
    }

    const users = await getUsersCollection();
    const user = await users.findOne({ email });

    if (!user) {
      return res.status(401).json({
        error: "invalid credentials",
      });
    }

    const match = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!match) {
      return res.status(401).json({
        error: "invalid credentials",
      });
    }

    const profile = {
      id: user._id.toString(),
      email: user.email,
      name: user.name || "",
    };

    req.session.user = profile;

    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);

        return res.status(500).json({
          error: "Failed to save login session",
        });
      }

      return res.json({ user: profile });
    });
  } catch (err) {
    console.error("Login error:", err);

    return res.status(500).json({
      error: "login failed",
    });
  }
});

app.get("/auth/me", (req, res) => {
  return res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null,
  });
});

    

// Logout
app.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: "logout failed",
      });
    }

    res.clearCookie("connect.sid");

    return res.json({
      message: "logged out",
    });
  });
});

// ========================================
// EVENT ROUTES
// ========================================

// GET ALL EVENTS

app.get("/events", async (req, res) => {
  try {
    const events = await getEventsCollection();
    const users = await getUsersCollection();

    const result = await events
      .find()
      .sort({ dateTime: 1 })
      .toArray();

    // Get all valid organizer IDs
    const organizerIds = [
      ...new Set(
        result
          .map((event) => event.organizerId)
          .filter((id) => id && ObjectId.isValid(id))
      ),
    ];

    // Fetch organizer information from users collection
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
  } catch (err) {
    console.error("Get events error:", err);

    return res.status(500).json({
      error: "Failed to get events",
    });
  }
});

// ========================================
// CREATE EVENT
// ========================================


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
  } catch (err) {
    console.error("Create event error:", err);

    return res.status(500).json({
      error: "Failed to create event",
    });
  }
});

// ========================================
// GET ALL EVENTS
// ========================================

app.get("/events", async (req, res) => {
  try {
    const events = await getEventsCollection();

    const allEvents = await events
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const formattedEvents = allEvents.map(({ _id, ...event }) => ({
      ...event,
      id: _id.toString(),
      attendeeIds: event.attendeeIds ?? [],
    }));

    return res.json({
      events: formattedEvents,
    });
  } catch (err) {
    console.error("Get events error:", err);

    return res.status(500).json({
      error: "Failed to get events",
    });
  }
});

// ========================================
// GET SINGLE EVENT
// ========================================

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
  } catch (err) {
    console.error("Get event error:", err);

    return res.status(500).json({
      error: "Failed to get event",
    });
  }
});

// ========================================
// JOIN EVENT
// ========================================

app.post("/events/:id/join", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid event ID" });
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
      return res.status(404).json({ error: "Event not found" });
    }

    const event = await events.findOne({
      _id: new ObjectId(req.params.id),
    });

    return res.json({
      message: "Successfully joined the event",
      attendeeIds: event.attendeeIds ?? [],
    });
  } catch (err) {
    console.error("Join event error:", err);
    return res.status(500).json({ error: "Failed to join event" });
  }
});
// ========================================
// LEAVE EVENT
// ========================================

app.delete("/events/:id/join", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid event ID" });
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
      return res.status(404).json({ error: "Event not found" });
    }

    const event = await events.findOne({
      _id: new ObjectId(req.params.id),
    });

    return res.json({
      message: "Successfully left the event",
      attendeeIds: event.attendeeIds ?? [],
    });
  } catch (err) {
    console.error("Leave event error:", err);
    return res.status(500).json({ error: "Failed to leave event" });
  }
});



// ========================================
// DELETE EVENT (ONLY ORGANIZER)
// ========================================

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
  } catch (err) {
    console.error("Delete event error:", err);

    return res.status(500).json({
      error: "Failed to delete event",
    });
  }
});

// ========================================
// UPDATE EVENT (ONLY ORGANIZER)
// ========================================


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

    const startDateTime = updates.dateTime ?? existingEvent.dateTime;
    const endDateTime = updates.endDateTime ?? existingEvent.endDateTime;

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
  } catch (err) {
    console.error("Update event error:", err);

    return res.status(500).json({
      error: "Failed to update event",
    });
  }
});

// ========================================
// HOME ROUTE
// ========================================

app.get("/", (req, res) => {
  res.json({
    message: "GreenLife server is running",
  });
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
