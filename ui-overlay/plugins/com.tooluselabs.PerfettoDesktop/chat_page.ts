// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import m from 'mithril';

// Phase 2 first cut placeholder. Replaced by the real chat UI once
// the OpenAI-compatible Provider abstraction lands.
export const ChatPage: m.Component = {
  view() {
    return m(
      '.pf-multi-llm-chat-placeholder',
      {
        style: {
          padding: '24px',
          fontFamily: 'sans-serif',
          color: 'var(--pf-color-fg, #0F172A)',
        },
      },
      [
        m('h2', 'Multi-LLM Chat'),
        m('p', [
          'This is a Phase 2 placeholder for the Tooluse Labs ',
          m('strong', 'fork-owned'),
          ' AI Chat plugin. Confirms that the ',
          m('code', 'ui-overlay/'),
          ' → Perfetto plugin pipeline is wired end-to-end.',
        ]),
        m('p', [
          'Provider implementations (DeepSeek, ZAI, Kimi, MiniMax, Qwen, ',
          'Doubao, OpenAI, local Ollama / LM Studio, Anthropic) land in ',
          'a subsequent commit.',
        ]),
        m('p', [
          'For Gemini, the upstream ',
          m('code', 'com.google.PerfettoMcp'),
          ' plugin (sidebar menu ',
          m('strong', '"AI Chat"'),
          ') already covers it; this plugin focuses on Providers ',
          'upstream does not.',
        ]),
      ],
    );
  },
};
