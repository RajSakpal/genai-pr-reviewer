import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";
import { CodebaseEmbeddingService } from "./embeddingService.js";

const model = new ChatGoogleGenerativeAI({
  model: "gemini-1.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0.3,
});

const contextualPromptTemplate = new PromptTemplate({
  template: `
You are a senior software engineer reviewing a GitHub Pull Request with full codebase context.

**File being changed:** \`{filename}\`

**Current file content:**
\`\`\`
{currentFileContent}
\`\`\`

**Changes being made:**
\`\`\`diff
{patch}
\`\`\`

**Relevant codebase context:**
{relevantContext}

**Architecture patterns found in codebase:**
{architecturePatterns}

Provide a comprehensive code review considering:
1. How this change fits with existing patterns
2. Potential impacts on related functionality
3. Code quality and best practices
4. Security implications
5. Performance considerations
6. Testing requirements

Be specific and reference related code when making suggestions.
`,
  inputVariables: ["filename", "patch", "currentFileContent", "relevantContext", "architecturePatterns"],
});

export async function analyzeDiffWithContext(patch, filename, repoOwner, repoName) {
  try {
    const embeddingService = new CodebaseEmbeddingService(repoOwner, repoName);

    // Get current file content
    const currentFileContent = await embeddingService.getFileContext(filename) || "File not found in knowledge base";

    // Find relevant context
    const relevantContext = await embeddingService.findRelevantContext(patch, filename, 5);
    
    // Format relevant context
    const formattedContext = relevantContext.map(ctx => 
      `**${ctx.filePath}** (similarity: ${ctx.score.toFixed(2)}):\n\`\`\`\n${ctx.content}\n\`\`\``
    ).join('\n\n');

    // Get architecture patterns - Fixed the method call
    const architecturePatterns = await embeddingService.extractArchitecturePatterns();

    const prompt = await contextualPromptTemplate.format({
      filename,
      patch,
      currentFileContent,
      relevantContext: formattedContext || "No relevant context found",
      architecturePatterns,
    });

    const response = await model.invoke(prompt);
    return response.content;
  } catch (error) {
    console.error("❌ Contextual AI analysis failed:", error.message);
    // Fallback to basic analysis
    return await fallbackAnalysis(patch, filename);
  }
}

async function fallbackAnalysis(patch, filename) {
  // Basic analysis without context as fallback
  const basicPrompt = `Review this code change in ${filename}:\n\n${patch}`;
  const response = await model.invoke(basicPrompt);
  return response.content;
}