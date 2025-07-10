import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    const result = await genAI.listModels();
    const models = result.models;

    console.log("✅ Available Gemini Models:\n");

    for (const model of models) {
      console.log(`🧠 ${model.name}`);
      console.log(`   Display Name: ${model.displayName}`);
      console.log(`   Description : ${model.description}`);
      console.log(`   Input Token Limit: ${model.inputTokenLimit}`);
      console.log(`   Output Token Limit: ${model.outputTokenLimit}`);
      console.log("   ---------------------------");
    }
  } catch (err) {
    console.error("❌ Error fetching models:", err.message);
  }
}

listModels();
