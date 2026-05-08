// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import m from 'mithril';
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {ChatPage} from './chat_page';

export default class PerfettoDesktopPlugin implements PerfettoPlugin {
  static readonly id = 'com.tooluselabs.PerfettoDesktop';
  static readonly description = `
    Tooluse Labs Multi-LLM Chat for Perfetto Desktop. Coexists with
    upstream com.google.PerfettoMcp (Gemini); this plugin will host
    OpenAI-compatible providers (DeepSeek, ZAI, Kimi, MiniMax, Qwen,
    Doubao, OpenAI, Ollama, ...) and Anthropic in later cuts.
  `;

  async onTraceLoad(trace: Trace): Promise<void> {
    trace.pages.registerPage({
      route: '/multillmchat',
      render: () => m(ChatPage),
    });
    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: 'Multi-LLM Chat',
      href: '#!/multillmchat',
      // Distinct from upstream com.google.PerfettoMcp's 'smart_toy' so
      // both entries are visually disambiguated when both plugins are
      // enabled.
      icon: 'forum',
      // Anchored on upstream PerfettoMcp's sortOrder=10; we sit just below.
      sortOrder: 11,
    });
  }
}
