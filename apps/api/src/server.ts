// Start OpenTelemetry BEFORE any instrumented module (express, pg, Kysely) is
// imported. ESM evaluates sibling imports in source order, so this must stay
// the very first import in this file.
import "./infrastructure/observability/instrumentation";

import express from "express";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import YAML from "yaml";

const app = express();
const port = process.env.PORT || 5000;

// 1. Load the YAML file
const fileContents = fs.readFileSync("./openapi.yaml", "utf8");
const swaggerDocument = YAML.parse(fileContents);

// 2. The Sanitization Fix: Stringify, escape the invisible characters, and re-parse
const sanitizedDoc = JSON.parse(
  JSON.stringify(swaggerDocument)
    .replace(/\u2028/g, "\\u2028") // Escapes Line Separators
    .replace(/\u2029/g, "\\u2029"), // Escapes Paragraph Separators
);

// 3. Mount the Swagger UI middleware
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(sanitizedDoc));

// 4. A simple health check route
app.get("/", (req, res) => {
  res.json({
    message: "Lekki Fashion API is running. Visit /api-docs for documentation.",
  });
});

// 5. Start the server
app.listen(port, () => {
  console.log(`🚀 Live Express server running at http://localhost:${port}`);
  console.log(`📑 Swagger UI available at http://localhost:${port}/api-docs`);
});
