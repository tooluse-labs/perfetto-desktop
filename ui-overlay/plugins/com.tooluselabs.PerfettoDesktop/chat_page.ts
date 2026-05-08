// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import m from 'mithril';

export const ChatPage: m.Component = {
  view() {
    return m('.pf-multi-llm-chat-placeholder', [
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
    ]);
  },
};
