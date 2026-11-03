
import express from "express";
import cors from "cors";
import session from "express-session";
import { MongoStore } from "connect-mongo";
import bcrypt from "bcryptjs";
import { MongoClient, ObjectId } from "mongodb";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";

const app = express();
const PORT = Number(process.env.PORT) || 5001;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const isProduction = process.env.NODE_ENV === "production";

// --------------------------------------------------
// CORS CONFIGURATION
// --------------------------------------------------

const allowedOrigins = [
  "http://localhost:3000",
  "https://greenlife-client.vercel.app",
  process.env.FRONTEND_URL?.replace(/\/$/, ""),
].filter(Boolean);

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(
  cors({
    origin(origin, callback) {
      const normalizedOrigin = origin?.replace(/\/$/, "");

      if (!origin || allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      console.error("CORS blocked origin:", origin);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// --------------------------------------------------
// MONGODB CONNECTION
// --------------------------------------------------

let client;

async function connectToMongoDB() {
  if (client) return client;

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  const newClient = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 0,
  });

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

async function getCollection(collectionName) {
  const connectedClient = await connectToMongoDB();

  const db = connectedClient.db(process.env.MONGODB_DB || "greenlife");

  return db.collection(collectionName);
}

const getUsersCollection = () => getCollection("users");
const getEventsCollection = () => getCollection("events");

// --------------------------------------------------
// SESSION CONFIGURATION
// --------------------------------------------------

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

// --------------------------------------------------
// AUTH MIDDLEWARE
// --------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please login first",
    });
  }

  next();
}

// --------------------------------------------------
// ROOT & HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "GreenLife server is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is healthy",
  });
});

// --------------------------------------------------
// REGISTER
// --------------------------------------------------

app.post("/auth/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    const users = await getUsersCollection();

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await users.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = {
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      createdAt: new Date(),
    };

    const result = await users.insertOne(newUser);

    req.session.user = {
      id: result.insertedId.toString(),
      name: newUser.name,
      email: newUser.email,
    };

    res.status(201).json({
      success: true,
      message: "Registration successful",
      user: req.session.user,
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

app.post("/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const users = await getUsersCollection();

    const user = await users.findOne({
      email: email.toLowerCase().trim(),
    });

    if (!user || !user.password) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    req.session.regenerate((error) => {
      if (error) return next(error);

      req.session.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
      };

      req.session.save((saveError) => {
        if (saveError) return next(saveError);

        res.json({
          success: true,
          message: "Login successful",
          user: req.session.user,
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// GOOGLE LOGIN
// --------------------------------------------------

app.post("/auth/google", async (req, res, next) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Google credential is required",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload?.email || !payload.email_verified) {
      return res.status(401).json({
        success: false,
        message: "Google email is not verified",
      });
    }

    const users = await getUsersCollection();
    const email = payload.email.toLowerCase();

    let user = await users.findOne({ googleId: payload.sub });

    if (!user) {
      user = await users.findOne({ email });

      if (user && user.googleId && user.googleId !== payload.sub) {
        return res.status(409).json({
          success: false,
          message: "This email is linked to another Google account",
        });
      }

      if (user) {
        await users.updateOne(
          { _id: user._id },
          {
            $set: {
              googleId: payload.sub,
              picture: payload.picture || "",
            },
          }
        );
      } else {
        const newUser = {
          name: payload.name || "Google User",
          email,
          googleId: payload.sub,
          picture: payload.picture || "",
          createdAt: new Date(),
        };

        const result = await users.insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
      }
    }

    req.session.regenerate((error) => {
      if (error) return next(error);

      req.session.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        picture: user.picture || payload.picture || "",
      };

      req.session.save((saveError) => {
        if (saveError) return next(saveError);

        res.json({
          success: true,
          message: "Google login successful",
          user: req.session.user,
        });
      });
    });
  } catch (error) {
    console.error("Google login error:", error);
    next(error);
  }
});

// --------------------------------------------------
// GET CURRENT USER
// --------------------------------------------------

app.get("/auth/me", (req, res) => {
  if (!req.session.user) {
    return res.json({
      authenticated: false,
      user: null,
    });
  }

  res.json({
    authenticated: true,
    user: req.session.user,
  });
});

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

app.post("/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("greenlife.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
    });

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  });
});

// --------------------------------------------------
// GET ALL EVENTS
// --------------------------------------------------

app.get("/events", async (req, res, next) => {
  try {
    const eventsCollection = await getEventsCollection();
    const usersCollection = await getUsersCollection();

    const events = await eventsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const organizerIds = [
      ...new Set(
        events
          .map((event) => event.organizerId)
          .filter((id) => id && ObjectId.isValid(id))
      ),
    ];

    const organizers = organizerIds.length
      ? await usersCollection
          .find({
            _id: {
              $in: organizerIds.map((id) => new ObjectId(id)),
            },
          })
          .project({ password: 0 })
          .toArray()
      : [];

    const organizerMap = new Map(
      organizers.map((user) => [user._id.toString(), user])
    );

    const formattedEvents = events.map((event) => ({
      ...event,
      _id: event._id.toString(),
      organizer:
        organizerMap.get(event.organizerId)?.name || "Unknown Organizer",
    }));

    res.json({
      success: true,
      events: formattedEvents,
    });
  } catch (error) {
    console.error("GET /events error:", error);
    next(error);
  }
});

// --------------------------------------------------
// GET SINGLE EVENT
// --------------------------------------------------

app.get("/events/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const event = await events.findOne({
      _id: new ObjectId(id),
    });

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      event: {
        ...event,
        _id: event._id.toString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// CREATE EVENT
// --------------------------------------------------

app.post("/events", requireAuth, async (req, res, next) => {
  try {
    const events = await getEventsCollection();

    const eventData = {
      ...req.body,
      organizerId: req.session.user.id,
      createdAt: new Date(),
      participants: [],
    };

    const result = await events.insertOne(eventData);

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event: {
        ...eventData,
        _id: result.insertedId.toString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// JOIN EVENT
// --------------------------------------------------

app.post("/events/:id/join", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();
    const userId = req.session.user.id;

    const result = await events.updateOne(
      { _id: new ObjectId(id) },
      { $addToSet: { participants: userId } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      message: "Joined event successfully",
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// LEAVE EVENT
// --------------------------------------------------

app.delete("/events/:id/join", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const result = await events.updateOne(
      { _id: new ObjectId(id) },
      { $pull: { participants: req.session.user.id } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    res.json({
      success: true,
      message: "Left event successfully",
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// DELETE EVENT
// --------------------------------------------------

app.delete("/events/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const events = await getEventsCollection();

    const result = await events.deleteOne({
      _id: new ObjectId(id),
      organizerId: req.session.user.id,
    });

    if (!result.deletedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found or you are not the organizer",
      });
    }

    res.json({
      success: true,
      message: "Event deleted successfully",
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// UPDATE EVENT
// --------------------------------------------------

app.patch("/events/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID",
      });
    }

    const allowedFields = [
      "title",
      "description",
      "date",
      "time",
      "location",
      "category",
      "image",
      "capacity",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided",
      });
    }

    updates.updatedAt = new Date();

    const events = await getEventsCollection();

    const result = await events.updateOne(
      {
        _id: new ObjectId(id),
        organizerId: req.session.user.id,
      },
      { $set: updates }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found or you are not the organizer",
      });
    }

    res.json({
      success: true,
      message: "Event updated successfully",
    });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: isProduction ? undefined : error.message,
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

if (!process.env.NETLIFY) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GreenLife server running on port ${PORT}`);
  });
}

export default app;