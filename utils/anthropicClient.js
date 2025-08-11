import { ChatAnthropic } from "@langchain/anthropic";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config({ path: ".env.local" });

const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
const MAX_RETRIES = 3;
const MaxTokensDefault = 2048;

export class AnthropicAIClient {
  webSearchEnabled = true;

  stats = {
    success: 0,
    failures: 0,
    totalRequests: 0,
    rateLimitHits: 0,
    webSearches: 0,
    lastError: null as null | string
  };

  anthropicClient: any;

  constructor(enableWebSearch = true) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("WARNING: ANTHROPIC_API_KEY is not set");
    }

    const clientConfig: any = {
      model: DEFAULT_MODEL,
      apiKey,
      temperature: 0.9,
      maxRetries: 2
    };

    this.anthropicClient = new ChatAnthropic(clientConfig);

    if (enableWebSearch) {
      const webSearchTool = {
        type: "web_search_20250305",
        name: "web_search"
      };

      this.anthropicClient = this.anthropicClient.bindTools([webSearchTool]);
    } else {
      this.anthropicClient = new ChatAnthropic(clientConfig);
    }

    this.webSearchEnabled = enableWebSearch;

    if (process.env.DEBUG_LOG === "1") {
      fs.writeFileSync(
        "debug.log",
        `API_KEY=${process.env.ANTHROPIC_API_KEY}\n`
      );
    }
  }

  isRateLimitError(error: any) {
    const errorMessage = (error.message || "").toLowerCase();
    const errorCode = (error.code || (error.status as any)) as number;

    return (
      errorMessage.includes("quota") ||
      errorMessage.includes("rate limit") ||
      errorMessage.includes("too many requests") ||
      errorCode === 429 ||
      errorCode === 403
    );
  }

  async invoke(prompt: any, options: any = {}) {
    const maxRetries = MAX_RETRIES;
    let attempt = 0;

    this.stats.totalRequests++;

    while (attempt < maxRetries) {
      try {
        console.log(
          `🤖 Calling Anthropic Claude${
            this.webSearchEnabled ? " (Web Search Enabled)" : ""
          }... (attempt ${attempt + 1}/${maxRetries})`
        );

        const messages = [
          {
            role: "user",
            content: prompt
          }
        ];

        const response: any = await this.anthropicClient.invoke(messages, {
          temperature: options.temperature || 0.3,
          maxTokens: options.maxTokens || MaxTokensDefault,
          ...options
        });

        this.stats.success++;

        const contentStr =
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

        if (this.webSearchEnabled && contentStr.includes("Source:")) {
          this.stats.webSearches++;
          console.log(`✅ Anthropic Claude success (with web search)`);
        } else {
          console.log(`✅ Anthropic Claude success`);
        }

        return {
          content: response.content,
          provider: "anthropic",
          model: DEFAULT_MODEL,
          webSearchUsed:
            this.webSearchEnabled && contentStr.includes("Source:")
        };
      } catch (error: any) {
        attempt++;
        this.stats.failures++;
        this.stats.lastError = error.message;

        console.error(`❌ Anthropic attempt ${attempt} failed:`, error);

        if (this.isRateLimitError(error)) {
          this.stats.rateLimitHits++;

          if (attempt < maxRetries) {
            const backoffTime = Math.pow(4, attempt) * 500;
            console.log(
              `⏳ Rate limit detected, waiting ${backoffTime}ms before retry...`
            );
            await new Promise((resolve) => setTimeout(resolve, backoffTime));
            continue;
          }
        } else {
          if (attempt < maxRetries) {
            const backoffTime = Math.pow(2, attempt) * 1000;
            console.log(`⏳ Retrying in ${backoffTime}ms...`);
            await new Promise((resolve) => setTimeout(resolve, backoffTime));
            continue;
          }
        }

        if (attempt >= maxRetries) {
          console.error(`❌ Anthropic failed after ${maxRetries} attempts`);
          throw new Error(
            `Anthropic AI request failed after ${maxRetries} attempts: ${error.message}`
          );
        }
      }
    }
  }

  async checkHealth() {
    try {
      console.log("🔍 Checking Anthropic API health...");

      const testMessages = [
        {
          role: "user",
          content: "Test connection. Reply with 'OK'."
        }
      ];

      const testResponse = await this.anthropicClient.invoke(testMessages);

      return {
        status: "healthy",
        provider: "anthropic",
        model: DEFAULT_MODEL,
        webSearchEnabled: this.webSearchEnabled,
        response: testResponse.content
      };
    } catch (error: any) {
      return {
        status: "unhealthy",
        provider: "anthropic",
        error: error.message,
        webSearchEnabled: this.webSearchEnabled,
        isRateLimit: this.isRateLimitError(error)
      };
    }
  }

  getStats() {
    const totalAttempts = this.stats.success + this.stats.failures;

    return {
      ...this.stats,
      provider: "anthropic",
      model: DEFAULT_MODEL,
      webSearchEnabled: this.webSearchEnabled,
      successRate: totalAttempts > 0 ? this.stats.success / totalAttempts : 0,
      failureRate: totalAttempts > 0 ? this.stats.failures / totalAttempts : 0,
      rateLimitRate:
        this.stats.totalRequests > 0
          ? this.stats.rateLimitHits / this.stats.totalRequests
          : 0,
      webSearchRate:
        this.stats.success > 0
          ? this.stats.webSearches / this.stats.success
          : 0
    };
  }

  resetStats() {
    console.log("📊 Anthropic statistics reset");

    this.stats = {
      success: 0,
      failures: 0,
      totalRequests: 0,
      rateLimitHits: 0,
      webSearches: 0,
      lastError: null
    };
  }
}

if (require.main === module) {
  const client = new AnthropicAIClient(false);
  client.invoke("Say hello", { temperature: "hot" as any });
  setTimeout(() => process.exit(0), 100);
}
