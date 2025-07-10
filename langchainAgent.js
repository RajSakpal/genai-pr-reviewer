import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";

// ✅ Check if API key is loaded - try both possible env variable names
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("❌ Google API key environment variable is not set!");
  console.error("Please check your .env file and ensure it contains either:");
  console.error("GOOGLE_API_KEY=your_actual_api_key_here");
  console.error("or");
  console.error("GEMINI_API_KEY=your_actual_api_key_here");
  process.exit(1);
}

// ✅ Configure Gemini model
const model = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash", // Fixed parameter name and stable model
  apiKey: apiKey,
  temperature: 0.3,
});

// ✅ Your prompt template
const promptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request.
Below is the diff of a file:
-----------------
{diff}
-----------------

Suggest improvements or highlight issues in the above code. Be concise, technical, and helpful.
`,
  inputVariables: ["diff"],
});

// ✅ Diff analysis function
async function analyzeDiffWithAI(diff, filename) {
  try {
    const prompt = await promptTemplate.format({ diff });
    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("❌ Error analyzing diff:", error.message);
    throw error;
  }
}

export default analyzeDiffWithAI;