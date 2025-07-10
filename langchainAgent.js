import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";

const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error("❌ Google API key environment variable is not set!");
  console.error("Please check your .env file and ensure it contains either:");
}

const model = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash", // Fixed parameter name and stable model
  apiKey: apiKey,
  temperature: 0.3,
});

const promptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request.

The following changes are in the file: \`{filename}\`
-----------------
{hunk}
-----------------

Provide clear, concise, and constructive feedback on the code changes. 
Highlight any issues, suggest improvements, and mention best practices if applicable.
`,
  inputVariables: ["hunk", "filename"],
});

async function analyzeDiffWithAI(hunk, filename) {
  try {
    const prompt = await promptTemplate.format({ hunk , filename });
    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("❌ Error analyzing diff:", error.message);
    throw error;
  }
}

export default analyzeDiffWithAI;