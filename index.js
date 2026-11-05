
import express from "express";
import cors from "cors";
import session from "express-session";
import MongoStore from "connect-mongo";
import bcrypt from "bcryptjs";
import { MongoClient, ObjectId } from "mongodb";
import { OAuth2Client } from "google-auth-library";
import "dotenv/config";

// --------------------------------------------------
// APP CONFIGURATION
// --------------------------------------------------

const app = express();
const PORT = Number(process.env.PORT) || 5001;
const isProduction = process.env.NODE_ENV === "production";

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("isProduction:", isProduction);

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID
);

// --------------------------------------------------
// ENVIRONMENT VALIDATION
// --------------------------------------------------

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from .env");
}

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from .env");
}

if (!process.env.GOOGLE_CLIENT_ID) {
  throw new Error("GOOGLE_CLIENT_ID is missing from .env");
}


// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
  "http://localhost:3000",
  "https://greenlife-client.vercel.app",
  "https://greenlife-client.netlify.app",
  process.env.FRONTEND_URL,
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/$/, ""));

app.use(
  cors({
    origin(origin, callback) {
      const normalizedOrigin = origin?.replace(/\/$/, "");

      if (!origin || allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      console.error("CORS blocked origin:", origin);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


// --------------------------------------------------
// SESSION MIDDLEWARE
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
    }),

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);




// --------------------------------------------------
// MONGODB CONNECTION
// --------------------------------------------------

let client;
let connectionPromise;

async function connectToMongoDB() {
  if (client) return client;

  if (!connectionPromise) {
    const newClient = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      maxPoolSize: 10,
    });

    connectionPromise = newClient
      .connect()
      .then(() => {
        client = newClient;
        console.log("Successfully connected to MongoDB!");
        return client;
      })
      .catch(async (error) => {
        connectionPromise = null;
        await newClient.close().catch(() => {});
        throw error;
      });
  }

  return connectionPromise;
}

async function getCollection(collectionName) {
  const connectedClient = await connectToMongoDB();

  const db = connectedClient.db(
    process.env.MONGODB_DB || "greenlife"
  );

  return db.collection(collectionName);
}

const getUsersCollection = () => getCollection("users");
const getEventsCollection = () => getCollection("events");

// --------------------------------------------------
// SESSION CONFIGURATION
// --------------------------------------------------


// --------------------------------------------------
// AUTH HELPERS
// --------------------------------------------------

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({
      success: false,
      message: "Please login first",
    });
  }

  next();
}
function createSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);

      console.log("SESSION REGENERATED:", req.sessionID);

      req.session.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        picture: user.picture || "",
      };

      console.log("USER ASSIGNED:", req.session.user);

      req.session.save((saveError) => {
        if (saveError) {
          console.error("SESSION SAVE ERROR:", saveError);
          return reject(saveError);
        }

        console.log("SESSION SAVED:", req.sessionID);
        console.log("SAVED SESSION USER:", req.session.user);

        resolve(req.session.user);
      });
    });
  });
}

// --------------------------------------------------
// ROOT & HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
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
    const { name, email, password } = req.body || {};

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const users = await getUsersCollection();

    const existingUser = await users.findOne({
      email: normalizedEmail,
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already registered",
      });
    }

    const newUser = {
      name: name.trim(),
      email: normalizedEmail,
      password: await bcrypt.hash(password, 12),
      picture: "",
      createdAt: new Date(),
    };

    const result = await users.insertOne(newUser);

    const sessionUser = await createSession(req, {
      ...newUser,
      _id: result.insertedId,
    });

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      user: sessionUser,
    });
  } catch (error) {
    console.error("Registration error:", error);
    next(error);
  }
});

// --------------------------------------------------
// EMAIL/PASSWORD LOGIN
// --------------------------------------------------

app.post("/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

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

    if (!user?.password) {
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

    const sessionUser = await createSession(req, user);

    return res.json({
      success: true,
      message: "Login successful",
      user: sessionUser,
    });
  } catch (error) {
    console.error("Login error:", error);
    next(error);
  }
});

// --------------------------------------------------
// GOOGLE LOGIN
// --------------------------------------------------

app.post("/auth/google", async (req, res, next) => {
  try {
    const credential = req.body?.credential;

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
    const email = payload.email.toLowerCase().trim();

    let user = await users.findOne({
      googleId: payload.sub,
    });

    if (!user) {
      user = await users.findOne({ email });

      if (user?.googleId && user.googleId !== payload.sub) {
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
              picture: payload.picture || user.picture || "",
            },
          }
        );

        user.googleId = payload.sub;
        user.picture = payload.picture || user.picture || "";
      } else {
        const newUser = {
          name: payload.name || "Google User",
          email,
          googleId: payload.sub,
          picture: payload.picture || "",
          createdAt: new Date(),
        };

        const result = await users.insertOne(newUser);

        user = {
          ...newUser,
          _id: result.insertedId,
        };
      }
    }

    const sessionUser = await createSession(req, user);

    console.log("Google login successful:", email);

    return res.json({
      success: true,
      message: "Google login successful",
      user: sessionUser,
    });
  } catch (error) {
    console.error("Google login error:", error);

    if (
      error.message?.includes("Wrong recipient") ||
      error.message?.includes("audience")
    ) {
      return res.status(401).json({
        success: false,
        message: "Google Client ID does not match",
      });
    }

    next(error);
  }
});

// --------------------------------------------------
// CURRENT AUTHENTICATED USER
// --------------------------------------------------



app.get("/auth/me", (req, res) => {
  console.log("\n========== AUTH CHECK ==========");
  console.log("Session ID:", req.sessionID);
  console.log("Session exists:", Boolean(req.session));
  console.log("Session user:", req.session?.user);
  console.log("Cookie received:", Boolean(req.headers.cookie));

  if (!req.session?.user) {
    console.log("STATUS: NOT AUTHENTICATED");

    return res.status(200).json({
      success: true,
      authenticated: false,
      user: null,
    });
  }

  console.log("STATUS: AUTHENTICATED");

  return res.status(200).json({
    success: true,
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

    return res.json({
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
          .map((event) => String(event.organizerId || ""))
          .filter(ObjectId.isValid)
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

    const formattedEvents = events.map((event) => {
      const organizer = organizerMap.get(
        String(event.organizerId || "")
      );

      return {
        ...event,
        id: event._id.toString(),
        _id: event._id.toString(),
        attendeeIds: event.attendeeIds ?? event.participants ?? [],
        organizer: organizer
          ? {
              name: organizer.name || "Unknown Organizer",
              email: organizer.email || "",
              avatarUrl: organizer.avatarUrl || organizer.picture || "",
            }
          : {
              name: "Unknown Organizer",
              email: "",
              avatarUrl: "",
            },
      };
    });

    return res.json({
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

    const users = await getUsersCollection();

    const organizer = ObjectId.isValid(
      String(event.organizerId || "")
    )
      ? await users.findOne(
          { _id: new ObjectId(String(event.organizerId)) },
          { projection: { password: 0 } }
        )
      : null;

    return res.json({
      success: true,
      event: {
        ...event,
        id: event._id.toString(),
        _id: event._id.toString(),
        attendeeIds: event.attendeeIds ?? event.participants ?? [],
        organizer: organizer
          ? {
              name: organizer.name || "Unknown Organizer",
              email: organizer.email || "",
              avatarUrl: organizer.avatarUrl || organizer.picture || "",
            }
          : {
              name: "Unknown Organizer",
              email: "",
              avatarUrl: "",
            },
      },
    });
  } catch (error) {
    console.error("GET SINGLE EVENT error:", error);
    next(error);
  }
});

// --------------------------------------------------
// CREATE EVENT
// --------------------------------------------------

app.post("/events", requireAuth, async (req, res, next) => {
  try {
    const {
      title,
      description,
      location,
      dateTime,
      endDateTime,
      category,
      imageUrl,
    } = req.body || {};

    if (
      !title?.trim() ||
      !description?.trim() ||
      !location?.trim() ||
      !dateTime ||
      !endDateTime ||
      !category?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required event fields",
      });
    }

    const start = new Date(dateTime);
    const end = new Date(endDateTime);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      return res.status(400).json({
        success: false,
        message: "End time must be after start time",
      });
    }

    const events = await getEventsCollection();

    const eventData = {
      title: title.trim(),
      description: description.trim(),
      location: location.trim(),
      dateTime,
      endDateTime,
      category: category.trim(),
      imageUrl: imageUrl || "",
      organizerId: req.session.user.id,
      attendeeIds: [],
      createdAt: new Date(),
    };

    const result = await events.insertOne(eventData);

    return res.status(201).json({
      success: true,
      message: "Event created successfully",
      event: {
        ...eventData,
        id: result.insertedId.toString(),
        _id: result.insertedId.toString(),
        organizer: {
          name: req.session.user.name,
          email: req.session.user.email,
        },
      },
    });
  } catch (error) {
    console.error("CREATE EVENT error:", error);
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

    const result = await events.updateOne(
      { _id: new ObjectId(id) },
      {
        $addToSet: {
          attendeeIds: req.session.user.id,
        },
        $pull: {
          participants: req.session.user.id,
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    return res.json({
      success: true,
      message: "Joined event successfully",
    });
  } catch (error) {
    console.error("JOIN EVENT error:", error);
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
      {
        $pull: {
          attendeeIds: req.session.user.id,
          participants: req.session.user.id,
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Event not found",
      });
    }

    return res.json({
      success: true,
      message: "Left event successfully",
    });
  } catch (error) {
    console.error("LEAVE EVENT error:", error);
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

    return res.json({
      success: true,
      message: "Event deleted successfully",
    });
  } catch (error) {
    console.error("DELETE EVENT error:", error);
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
      "location",
      "dateTime",
      "endDateTime",
      "category",
      "imageUrl",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body?.[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided",
      });
    }

    const events = await getEventsCollection();

    const existingEvent = await events.findOne({
      _id: new ObjectId(id),
      organizerId: req.session.user.id,
    });

    if (!existingEvent) {
      return res.status(404).json({
        success: false,
        message: "Event not found or you are not the organizer",
      });
    }

    const start = new Date(
      updates.dateTime ?? existingEvent.dateTime
    );

    const end = new Date(
      updates.endDateTime ?? existingEvent.endDateTime
    );

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      return res.status(400).json({
        success: false,
        message: "Event end time must be after start time",
      });
    }

    updates.updatedAt = new Date();

    await events.updateOne(
      {
        _id: new ObjectId(id),
        organizerId: req.session.user.id,
      },
      { $set: updates }
    );

    return res.json({
      success: true,
      message: "Event updated successfully",
    });
  } catch (error) {
    console.error("UPDATE EVENT error:", error);
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

  return res.status(500).json({
    success: false,
    message: isProduction
      ? "Internal server error"
      : error.message || "Internal server error",
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const isNetlify = process.env.NETLIFY === "true";

if (!isNetlify) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GreenLife server running on port ${PORT}`);
  });
}

export default app;