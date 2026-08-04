import express from "express";
import swaggerUi from "swagger-ui-express";
import yaml from "yamljs";
import path from "path";

const app = express();
const port = process.env.PORT || 5000;

// 1. Load the OpenAPI specification
// We resolve from the current working directory assuming you run the dev script from the apps/api folder
const swaggerDocument = yaml.load(path.resolve("./openapi.yaml"));

// 2. Mount the Swagger UI middleware
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// 3. A simple health check route
app.get("/", (req, res) => {
  res.json({
    message: "Lekki Fashion API is running. Visit /api-docs for documentation.",
  });
});

// 4. Start the server
app.listen(port, () => {
  console.log(`🚀 Live Express server running at http://localhost:${port}`);
  console.log(`📑 Swagger UI available at http://localhost:${port}/api-docs`);
});
