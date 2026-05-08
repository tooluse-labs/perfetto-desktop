// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import {
  ChatInput,
  ChatMessage,
  ChatResponse,
  LlmProvider,
  LlmProviderConfig,
  TokenUsage,
  ToolCallRequest,
} from './types';

type OpenAiMessage =
  | {readonly role: 'system'; readonly content: string}
  | {readonly role: 'user'; readonly content: string}
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly OpenAiToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly tool_call_id: string;
      readonly content: string;
    };

interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface OpenAiResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly tool_calls?: readonly OpenAiRawToolCall[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string;
  };
}

interface OpenAiRawToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
}

export class ProviderRequestError extends Error {
  constructor(
    readonly providerName: string,
    readonly status: number,
    message: string,
  ) {
    super(`${providerName} request failed (${status}): ${message}`);
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai_compatible';
  readonly displayName = 'OpenAI Compatible';

  constructor(private readonly config: LlmProviderConfig) {}

  async sendMessage(
    input: ChatInput,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const response = await fetch(chatCompletionsUrl(this.config.baseUrl), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: this.toOpenAiMessages(input.messages),
        tools: input.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: input.tools.length === 0 ? undefined : 'auto',
        stream: false,
      }),
      signal,
    });

    const rawText = await response.text();
    const body = parseJsonObject(rawText);
    if (!response.ok) {
      throw new ProviderRequestError(
        this.displayName,
        response.status,
        responseErrorMessage(body, rawText),
      );
    }

    const message = body.choices?.[0]?.message;
    if (message === undefined) {
      throw new Error(`${this.displayName} response did not include a message`);
    }

    return {
      messages: [
        {
          role: 'assistant',
          content: normalizeContent(message.content),
          toolCalls: parseToolCalls(message.tool_calls),
        },
      ],
      usage: mapUsage(body.usage),
    };
  }

  private toOpenAiMessages(messages: readonly ChatMessage[]): OpenAiMessage[] {
    const openAiMessages: OpenAiMessage[] = [];
    if (this.config.systemPrompt.trim() !== '') {
      openAiMessages.push({
        role: 'system',
        content: this.config.systemPrompt.trim(),
      });
    }

    for (const message of messages) {
      switch (message.role) {
        case 'user':
          openAiMessages.push({role: 'user', content: message.content});
          break;
        case 'assistant':
          openAiMessages.push({
            role: 'assistant',
            content: message.content === '' ? null : message.content,
            tool_calls: message.toolCalls?.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.args ?? {}),
              },
            })),
          });
          break;
        case 'tool':
          openAiMessages.push({
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: message.content,
          });
          break;
      }
    }
    return openAiMessages;
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl.trim());
  if (parsed.protocol !== 'https:') {
    throw new Error('Provider Base URL must use HTTPS');
  }

  const trimmed = parsed.toString().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function parseJsonObject(rawText: string): OpenAiResponse {
  if (rawText.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(rawText) as OpenAiResponse;
  } catch {
    return {};
  }
}

function responseErrorMessage(body: OpenAiResponse, rawText: string): string {
  if (body.error?.message) {
    return body.error.message;
  }
  return rawText.slice(0, 500) || 'empty response body';
}

function normalizeContent(content: unknown): string {
  if (content === undefined || content === null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(normalizeContentPart).join('');
  }
  return String(content);
}

function normalizeContentPart(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }
  if (part !== null && typeof part === 'object' && 'text' in part) {
    return String((part as {readonly text?: unknown}).text ?? '');
  }
  return JSON.stringify(part);
}

function parseToolCalls(
  toolCalls: readonly OpenAiRawToolCall[] | undefined,
): readonly ToolCallRequest[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls
    .filter((toolCall) => toolCall.function?.name)
    .map((toolCall, index) => ({
      id: toolCall.id ?? `tool_call_${index}`,
      name: toolCall.function!.name!,
      args: parseToolArgs(toolCall.function!.arguments),
    }));
}

function parseToolArgs(args: unknown): unknown {
  if (typeof args !== 'string') {
    return args ?? {};
  }
  if (args.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return {raw: args};
  }
}

function mapUsage(usage: OpenAiResponse['usage']): TokenUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}
