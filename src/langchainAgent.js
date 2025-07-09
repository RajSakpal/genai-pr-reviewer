import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";

const model = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4",
  temperature: 0.3,
});

const promptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request.

Below is a code diff from a file:
-----------------
{diff}
-----------------

Please review the changes and suggest improvements, point out any bugs, or recommend better practices. Be clear and concise.
`,
  inputVariables: ["diff"],
});

async function analyzeDiffWithAI(diff, filename) {
  try {
    const prompt = await promptTemplate.format({ diff });
    const response = await model.invoke(prompt);
    return response?.content || "No suggestions.";
  } catch (error) {
    console.error("❌ Error generating AI response:", error);
    return "⚠️ AI review failed.";
  }
}

export default analyzeDiffWithAI;
