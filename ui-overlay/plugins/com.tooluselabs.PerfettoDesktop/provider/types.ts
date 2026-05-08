// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

export const PROVIDER_IDS = ['openai_compatible'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface LlmProviderConfig {
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly systemPrompt: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  sendMessage(input: ChatInput, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface ChatInput {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDeclaration[];
}

export interface ChatResponse {
  readonly messages: readonly ChatMessage[];
  readonly usage?: TokenUsage;
}

export type ChatMessage =
  | {readonly role: 'user'; readonly content: string}
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCallRequest[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly content: string;
    };

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}
