import { ChatAnthropic } from "@langchain/anthropic";
import dotenv from "dotenv";

dotenv.config();

export class AnthropicAIClient {
  constructor(enableWebSearch = false) {
    // Initialize Anthropic client configuration
    const clientConfig = {
      model: "claude-3-5-sonnet-20241022",
      apiKey: process.env.ANTHROPIC_API_KEY,
      temperature: 0.3,
      maxRetries: 2
    };

    // Add web search tool if enabled
    if (enableWebSearch) {
      // Correct tool configuration format
      const webSearchTool = {
        type: "web_search_20250305",
        name: "web_search"
      };

      this.anthropicClient = new ChatAnthropic(clientConfig);
      // Bind tools using the correct LangChain method
      this.anthropicClient = this.anthropicClient.bindTools([webSearchTool]);
    } else {
      this.anthropicClient = new ChatAnthropic(clientConfig);
    }

    this.webSearchEnabled = enableWebSearch;

    // Statistics
    this.stats = {
      success: 0,
      failures: 0,
      totalRequests: 0,
      rateLimitHits: 0,
      webSearches: 0,
      lastError: null
    };
  }

  /**
   * Identify rate limit or quota errors
   */
  isRateLimitError(error) {
    const errorMessage = (error.message || '').toLowerCase();
    const errorCode = error.code || error.status;
    
    return errorMessage.includes('quota') ||
           errorMessage.includes('rate limit') ||
           errorMessage.includes('too many requests') ||
           errorCode === 429 ||
           errorCode === 403;
  }

  /**
   * Main invoke method with retry logic for rate limits
   */
  async invoke(prompt, options = {}) {
    const maxRetries = 3;
    let attempt = 0;
    
    this.stats.totalRequests++;

    while (attempt < maxRetries) {
      try {
        console.log(`🤖 Calling Anthropic Claude${this.webSearchEnabled ? ' (Web Search Enabled)' : ''}... (attempt ${attempt + 1}/${maxRetries})`);
        
        // ChatAnthropic expects messages array format
        const messages = [
          {
            role: "user",
            content: prompt
          }
        ];

        const response = await this.anthropicClient.invoke(messages, {
          temperature: options.temperature || 0.3,
          maxTokens: options.maxTokens || 2048,
          ...options
        });

        this.stats.success++;
        
        // Check if web search was used (look for citations or tool usage in response)
        if (this.webSearchEnabled && response.content.includes('Source:')) {
          this.stats.webSearches++;
          console.log(`✅ Anthropic Claude success (with web search)`);
        } else {
          console.log(`✅ Anthropic Claude success`);
        }
        
        return {
          content: response.content,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          webSearchUsed: this.webSearchEnabled && response.content.includes('Source:')
        };
        
      } catch (error) {
        attempt++;
        this.stats.failures++;
        this.stats.lastError = error.message;
        
        console.error(`❌ Anthropic attempt ${attempt} failed:`, error.message);
        
        // Check if it's a rate limit error
        if (this.isRateLimitError(error)) {
          this.stats.rateLimitHits++;
          
          if (attempt < maxRetries) {
            // Exponential backoff for rate limits: 2s, 8s, 32s
            const backoffTime = Math.pow(4, attempt) * 500;
            console.log(`⏳ Rate limit detected, waiting ${backoffTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }
        } else {
          // For non-rate-limit errors, shorter backoff: 1s, 2s, 4s
          if (attempt < maxRetries) {
            const backoffTime = Math.pow(2, attempt) * 1000;
            console.log(`⏳ Retrying in ${backoffTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
            continue;
          }
        }
        
        // If we've exhausted retries
        if (attempt >= maxRetries) {
          console.error(`❌ Anthropic failed after ${maxRetries} attempts`);
          throw new Error(`Anthropic AI request failed after ${maxRetries} attempts: ${error.message}`);
        }
      }
    }
  }

  /**
   * Check Anthropic API health
   */
  async checkHealth() {
    try {
      console.log('🔍 Checking Anthropic API health...');
      
      const testMessages = [
        {
          role: "user",
          content: "Test connection. Reply with 'OK'."
        }
      ];
      
      const testResponse = await this.anthropicClient.invoke(testMessages);
      
      return {
        status: 'healthy',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        webSearchEnabled: this.webSearchEnabled,
        response: testResponse.content
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'anthropic',
        error: error.message,
        webSearchEnabled: this.webSearchEnabled,
        isRateLimit: this.isRateLimitError(error)
      };
    }
  }

  /**
   * Get usage statistics
   */
  getStats() {
    const totalAttempts = this.stats.success + this.stats.failures;
    
    return {
      ...this.stats,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      webSearchEnabled: this.webSearchEnabled,
      successRate: totalAttempts > 0 ? (this.stats.success / totalAttempts) : 0,
      failureRate: totalAttempts > 0 ? (this.stats.failures / totalAttempts) : 0,
      rateLimitRate: this.stats.totalRequests > 0 ? (this.stats.rateLimitHits / this.stats.totalRequests) : 0,
      webSearchRate: this.stats.success > 0 ? (this.stats.webSearches / this.stats.success) : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      success: 0,
      failures: 0,
      totalRequests: 0,
      rateLimitHits: 0,
      webSearches: 0,
      lastError: null
    };
    console.log('📊 Anthropic statistics reset');
  }
}
