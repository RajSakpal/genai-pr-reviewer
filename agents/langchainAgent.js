import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";

const model = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0.3,
});

const promptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request.

The following are the code changes in the file: \`{filename}\`

--------------------------
{patch}
--------------------------

Provide clear, concise, and constructive feedback on the changes.
Point out potential issues, improvements, or best practices.
If nothing major is wrong, affirm that.
`,
  inputVariables: ["patch", "filename"],
});

export async function analyzeDiffWithAI(patch, filename) {
  try {
    const prompt = await promptTemplate.format({ patch, filename });
    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("❌ AI analysis failed:", error.message);
    throw error;
  }
}
