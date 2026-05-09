// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';

export default class PerfettoDesktopPlugin implements PerfettoPlugin {
  static readonly id = 'com.tooluselabs.PerfettoDesktop';
  static readonly description = `
    Tooluse Labs desktop integration plugin for Perfetto Desktop. This
    fork-owned plugin is the extension point for desktop-only features such as
    the planned local Agent Bridge.
  `;

  async onTraceLoad(_trace: Trace): Promise<void> {
    // Reserved for desktop-only integrations. Keep the plugin enabled so the
    // overlay and default-plugin patch path remain exercised.
  }
}
