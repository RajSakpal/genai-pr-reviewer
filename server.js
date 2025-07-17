import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { processPullRequest } from "./github/githubService.js";
import sequelize from './config/sequelize.js';
import ProjectSummary from './models/ProjectSummary.js';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  console.log(`📦 Received GitHub event: ${event}`);
  console.log("📄 Request body:", JSON.stringify(req.body, null, 2));

  if (event === "pull_request" && req.body.action === "opened") {
    const { pull_request, repository } = req.body;
    try {
      await processPullRequest(pull_request, repository);
      res.sendStatus(200);
    } catch (error) {
      console.error("❌ Failed to process PR:", error.message);
      res.status(500).send("Internal Server Error");
    }
  } else {
    res.sendStatus(204); // No action needed
  }
});

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ PostgreSQL connection established');

    await ProjectSummary.sync(); // 🔧 Create table if it doesn't exist
    console.log('✅ ProjectSummary table synced');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('❌ Error starting server:', error.message);
  }
})();


app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on http://localhost:${PORT}`);
});
