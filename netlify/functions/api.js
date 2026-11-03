import serverless from "serverless-http";
import app from "../../index.js";

// Runs the Express app inside a Netlify Function.
// basePath strips the function prefix so Express sees routes like /health.
export const handler = serverless(app, { basePath: "/.netlify/functions/api" });
