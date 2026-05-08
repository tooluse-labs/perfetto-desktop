// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import m from 'mithril';
import markdownit from 'markdown-it';
import {Trace} from '../../public/trace';
import {Button, ButtonVariant} from '../../widgets/button';
import {Intent} from '../../widgets/common';
import {Select} from '../../widgets/select';
import {TextInput} from '../../widgets/text_input';
import {OpenAiCompatibleProvider} from './provider/openai_compatible';
import {ChatMessage, TokenUsage, ToolCallRequest} from './provider/types';
import {
  getProviderPreset,
  PROVIDER_PRESETS,
  ProviderPresetId,
} from './provider/presets';
import {createSessionSecretBridge, SecretBridge} from './secret_bridge';
import {createPerfettoAiTools, PerfettoAiTool} from './tools/perfetto_tools';

export interface ChatPageAttrs {
  readonly trace: Trace;
}

type DisplayRole = 'assistant' | 'user' | 'tool' | 'error' | 'status';

interface DisplayMessage {
  readonly role: DisplayRole;
  text: string;
  detail?: string;
}

const PLUGIN_ID = 'com.tooluselabs.PerfettoDesktop';
const DEFAULT_SYSTEM_PROMPT = `
You are an expert in analyzing Perfetto traces. Use the available tools to
inspect the loaded trace before answering trace-specific questions. Prefer
small aggregate PerfettoSQL queries, explain assumptions, and mention when the
trace does not contain the data needed to answer.
`.trim();

export class ChatPage implements m.ClassComponent<ChatPageAttrs> {
  private readonly trace: Trace;
  private readonly md = markdownit();
  private readonly secretBridge: SecretBridge = createSessionSecretBridge();

  private presetId: ProviderPresetId = 'deepseek';
  private baseUrl = getProviderPreset('deepseek').baseUrl;
  private model = getProviderPreset('deepseek').model;
  private apiKeyInput = '';
  private apiKeySaved = false;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private maxToolCalls = 20;
  private showToolCalls = true;
  private showTokenUsage = true;

  private userInput = '';
  private isLoading = false;
  private abortController?: AbortController;
  private secretLoadGeneration = 0;
  private usage?: TokenUsage;
  private readonly conversation: ChatMessage[] = [];
  private messages: DisplayMessage[] = [
    {
      role: 'assistant',
      text: 'Ready for DeepSeek or ZAI trace analysis.',
    },
  ];

  constructor({attrs}: m.CVnode<ChatPageAttrs>) {
    this.trace = attrs.trace;
  }

  oninit() {
    void this.loadApiKey();
  }

  private activeSecretKey(): string {
    return `${PLUGIN_ID}#${getProviderPreset(this.presetId).secretKey}ApiKey`;
  }

  private async loadApiKey(): Promise<void> {
    const generation = ++this.secretLoadGeneration;
    const secretKey = this.activeSecretKey();
    const apiKey = (await this.secretBridge.get(secretKey)) ?? '';
    if (
      generation !== this.secretLoadGeneration ||
      secretKey !== this.activeSecretKey()
    ) {
      return;
    }
    this.apiKeyInput = apiKey;
    this.apiKeySaved = this.apiKeyInput !== '';
    m.redraw();
  }

  private saveApiKey = async (): Promise<void> => {
    const apiKey = this.apiKeyInput.trim();
    if (apiKey === '') {
      await this.secretBridge.delete(this.activeSecretKey());
      this.apiKeySaved = false;
    } else {
      await this.secretBridge.set(this.activeSecretKey(), apiKey);
      this.apiKeySaved = true;
    }
    m.redraw();
  };

  private forgetApiKey = async (): Promise<void> => {
    await this.secretBridge.delete(this.activeSecretKey());
    this.apiKeyInput = '';
    this.apiKeySaved = false;
    m.redraw();
  };

  private selectPreset(id: ProviderPresetId): void {
    const preset = getProviderPreset(id);
    this.presetId = id;
    this.baseUrl = preset.baseUrl;
    this.model = preset.model;
    this.apiKeyInput = '';
    this.apiKeySaved = false;
    void this.loadApiKey();
  }

  private switchToCustomBaseUrl(value: string): void {
    this.baseUrl = value;
    if (this.presetId === 'custom') {
      return;
    }
    this.presetId = 'custom';
    this.apiKeyInput = '';
    this.apiKeySaved = false;
    void this.loadApiKey();
  }

  private clearConversation = (): void => {
    this.conversation.length = 0;
    this.usage = undefined;
    this.messages = [
      {
        role: 'assistant',
        text: 'Conversation cleared.',
      },
    ];
  };

  private stopRequest = (): void => {
    this.abortController?.abort();
  };

  private sendMessage = async (): Promise<void> => {
    const prompt = this.userInput.trim();
    if (prompt === '' || this.isLoading) {
      return;
    }
    const apiKey = this.apiKeyInput.trim();
    if (apiKey === '') {
      this.messages.push({
        role: 'error',
        text: 'Enter an API key before sending a message.',
      });
      return;
    }

    this.userInput = '';
    this.isLoading = true;
    this.abortController = new AbortController();
    this.conversation.push({role: 'user', content: prompt});
    this.messages.push({role: 'user', text: prompt});
    m.redraw();

    try {
      const provider = new OpenAiCompatibleProvider({
        provider: 'openai_compatible',
        apiKey,
        baseUrl: this.baseUrl,
        model: this.model,
        systemPrompt: this.systemPrompt,
      });
      const tools = createPerfettoAiTools(this.trace.engine);
      await this.runToolLoop(provider, tools, this.abortController.signal);
    } catch (error) {
      if (isAbortError(error)) {
        this.messages.push({role: 'status', text: 'Stopped.'});
      } else {
        this.messages.push({
          role: 'error',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.isLoading = false;
      this.abortController = undefined;
      m.redraw();
    }
  };

  private async runToolLoop(
    provider: OpenAiCompatibleProvider,
    tools: readonly PerfettoAiTool[],
    signal: AbortSignal,
  ): Promise<void> {
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    let toolCallCount = 0;

    while (!signal.aborted) {
      const response = await provider.sendMessage(
        {
          messages: this.conversation,
          tools,
        },
        signal,
      );
      this.addUsage(response.usage);

      const assistantMessage = response.messages.find(
        (message): message is Extract<ChatMessage, {role: 'assistant'}> =>
          message.role === 'assistant',
      );
      if (assistantMessage === undefined) {
        throw new Error(
          'Provider response did not include an assistant message',
        );
      }

      if (assistantMessage.content.trim() !== '') {
        this.messages.push({
          role: 'assistant',
          text: assistantMessage.content,
        });
      }

      const toolCalls = assistantMessage.toolCalls ?? [];
      if (toolCalls.length === 0) {
        this.conversation.push(assistantMessage);
        return;
      }

      const toolMessages: ChatMessage[] = [];
      for (const toolCall of toolCalls) {
        if (toolCallCount >= this.maxToolCalls) {
          throw new Error(`Reached Max Tool Calls (${this.maxToolCalls})`);
        }
        toolCallCount++;
        toolMessages.push(
          await this.executeToolCall(toolMap, toolCall, signal),
        );
      }
      this.conversation.push(assistantMessage, ...toolMessages);
    }
  }

  private async executeToolCall(
    toolMap: ReadonlyMap<string, PerfettoAiTool>,
    toolCall: ToolCallRequest,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    const displayMessage: DisplayMessage = {
      role: 'tool',
      text: `Tool: ${toolCall.name}`,
      detail: `Arguments:\n${formatJson(toolCall.args)}`,
    };
    if (this.showToolCalls) {
      this.messages.push(displayMessage);
      m.redraw();
    }

    const tool = toolMap.get(toolCall.name);
    let result: string;
    if (tool === undefined) {
      result = JSON.stringify({error: `Unknown tool: ${toolCall.name}`});
    } else {
      try {
        result = await tool.call(toolCall.args);
      } catch (error) {
        result = JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (signal.aborted) {
      throw new DOMException('Request stopped', 'AbortError');
    }

    if (this.showToolCalls) {
      displayMessage.detail = [
        `Arguments:\n${formatJson(toolCall.args)}`,
        `Result:\n${result}`,
      ].join('\n\n');
      m.redraw();
    }
    return {
      role: 'tool',
      toolCallId: toolCall.id,
      content: result,
    };
  }

  private addUsage(usage?: TokenUsage): void {
    if (usage === undefined) {
      return;
    }
    this.usage = {
      inputTokens: addTokenCount(this.usage?.inputTokens, usage.inputTokens),
      outputTokens: addTokenCount(this.usage?.outputTokens, usage.outputTokens),
      totalTokens: addTokenCount(this.usage?.totalTokens, usage.totalTokens),
    };
  }

  view(): m.Children {
    return m('.pf-multi-llm-chat', [
      this.renderSettings(),
      m(
        '.pf-multi-llm-chat__conversation',
        {
          onupdate: (vnode: m.VnodeDOM) => {
            const element = vnode.dom as HTMLElement;
            element.scrollTop = element.scrollHeight;
          },
        },
        this.messages.map((message) => this.renderMessage(message)),
      ),
      this.renderComposer(),
    ]);
  }

  private renderSettings(): m.Children {
    return m('.pf-multi-llm-chat__settings', [
      m('.pf-multi-llm-chat__settings-grid', [
        m('label', [
          m('span', 'Provider'),
          m(
            Select,
            {
              value: this.presetId,
              disabled: this.isLoading,
              onchange: (event: Event) => {
                this.selectPreset(
                  (event.target as HTMLSelectElement).value as ProviderPresetId,
                );
              },
            },
            PROVIDER_PRESETS.map((preset) =>
              m('option', {value: preset.id}, preset.label),
            ),
          ),
        ]),
        m('label', [
          m('span', 'Base URL'),
          m(TextInput, {
            value: this.baseUrl,
            disabled: this.isLoading,
            onInput: (value: string) => {
              this.switchToCustomBaseUrl(value);
            },
          }),
        ]),
        m('label', [
          m('span', 'Model'),
          m(TextInput, {
            value: this.model,
            disabled: this.isLoading,
            onInput: (value: string) => {
              this.model = value;
            },
          }),
        ]),
        m('label', [
          m('span', 'API Key'),
          m('.pf-multi-llm-chat__key-row', [
            m(TextInput, {
              type: 'password',
              value: this.apiKeyInput,
              disabled: this.isLoading,
              placeholder: this.apiKeySaved ? 'Session key saved' : '',
              onInput: (value: string) => {
                this.apiKeyInput = value;
                this.apiKeySaved = false;
              },
            }),
            m(Button, {
              icon: 'key',
              title: 'Save API key for this session',
              onclick: this.saveApiKey,
              disabled: this.isLoading,
            }),
            m(Button, {
              icon: 'delete',
              title: 'Forget API key',
              onclick: this.forgetApiKey,
              disabled: this.isLoading || this.apiKeyInput === '',
            }),
          ]),
        ]),
        m('label', [
          m('span', 'Max Tool Calls'),
          m('input.pf-multi-llm-chat__number', {
            type: 'number',
            min: 1,
            max: 100,
            value: this.maxToolCalls,
            disabled: this.isLoading,
            oninput: (event: Event) => {
              this.maxToolCalls = Number(
                (event.target as HTMLInputElement).value,
              );
            },
          }),
        ]),
      ]),
      m('.pf-multi-llm-chat__toggles', [
        m('label', [
          m('input', {
            type: 'checkbox',
            checked: this.showToolCalls,
            onchange: (event: Event) => {
              this.showToolCalls = (event.target as HTMLInputElement).checked;
            },
          }),
          m('span', 'Show tool calls'),
        ]),
        m('label', [
          m('input', {
            type: 'checkbox',
            checked: this.showTokenUsage,
            onchange: (event: Event) => {
              this.showTokenUsage = (event.target as HTMLInputElement).checked;
            },
          }),
          m('span', 'Show token usage'),
        ]),
      ]),
      m('label.pf-multi-llm-chat__prompt', [
        m('span', 'System Prompt'),
        m('textarea', {
          value: this.systemPrompt,
          disabled: this.isLoading,
          oninput: (event: Event) => {
            this.systemPrompt = (event.target as HTMLTextAreaElement).value;
          },
        }),
      ]),
      m('.pf-multi-llm-chat__settings-actions', [
        m(Button, {
          icon: 'delete_sweep',
          label: 'Clear',
          onclick: this.clearConversation,
          disabled: this.isLoading,
        }),
      ]),
    ]);
  }

  private renderMessage(message: DisplayMessage): m.Children {
    const roleLabel = {
      assistant: 'AI',
      user: 'You',
      tool: 'Tool',
      error: 'Error',
      status: 'Status',
    }[message.role];

    return m(
      `.pf-multi-llm-chat__message.pf-multi-llm-chat__message--${message.role}`,
      [
        m('b', roleLabel),
        m(
          '.pf-multi-llm-chat__message-text',
          m.trust(this.md.render(message.text)),
        ),
        message.detail &&
          m(
            'details',
            {open: false},
            m('summary', 'Details'),
            m('pre', message.detail),
          ),
      ],
    );
  }

  private renderComposer(): m.Children {
    return m('footer.pf-multi-llm-chat__composer', [
      m('textarea', {
        value: this.userInput,
        disabled: this.isLoading,
        placeholder: this.isLoading
          ? 'Waiting for response...'
          : 'Ask about this trace...',
        oninput: (event: Event) => {
          this.userInput = (event.target as HTMLTextAreaElement).value;
        },
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void this.sendMessage();
          }
        },
      }),
      this.showTokenUsage &&
        m('.pf-multi-llm-chat__tokens', [
          m('span', 'Tokens'),
          m('strong', this.usage?.totalTokens ?? '--'),
        ]),
      this.isLoading
        ? m(Button, {
            icon: 'stop',
            title: 'Stop',
            onclick: this.stopRequest,
            variant: ButtonVariant.Filled,
            intent: Intent.Danger,
          })
        : m(Button, {
            icon: 'arrow_forward',
            title: 'Send',
            onclick: () => void this.sendMessage(),
            variant: ButtonVariant.Filled,
            intent: Intent.Primary,
            disabled: this.userInput.trim() === '',
          }),
    ]);
  }
}

function addTokenCount(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return String(value);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
