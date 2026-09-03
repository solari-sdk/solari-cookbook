export interface LLMRequest {
    system: string;
    user: string;
  }
  
  export interface LLMResponse {
    content: string;
  }
  
  export interface LLMProvider {
    complete(request: LLMRequest): Promise<LLMResponse>;
  }
  
  /**
   * Placeholder provider.
   *
   * PatchPilot's agent logic talks to the LLM through this interface,
   * so the actual provider can be swapped without changing the agent.
   */
  export class LLMClient implements LLMProvider {
    async complete(
      request: LLMRequest
    ): Promise<LLMResponse> {
      throw new Error(
        "No LLM provider configured. Configure an LLM provider before running AI analysis."
      );
    }
  }
  
  export const llm = new LLMClient();