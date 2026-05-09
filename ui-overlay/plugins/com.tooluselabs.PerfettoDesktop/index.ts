// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import m from 'mithril';
import {App} from '../../public/app';
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {Button, ButtonBar, ButtonVariant} from '../../widgets/button';
import {Callout} from '../../widgets/callout';
import {CodeSnippet} from '../../widgets/code_snippet';
import {Intent} from '../../widgets/common';
import {Section} from '../../widgets/section';

type BridgeStatus =
  | 'Disabled'
  | 'Starting'
  | 'Listening'
  | 'Pending Authorization'
  | 'Connected'
  | 'Error';

type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

interface AgentBridgeClient {
  readonly clientId: string;
  readonly name: string;
}

interface AgentBridgeSnapshot {
  readonly status: BridgeStatus;
  readonly port?: number;
  readonly endpoint?: string;
  readonly fallbackPort: boolean;
  readonly sessionId?: string;
  readonly pendingClient?: AgentBridgeClient;
  readonly connectedClient?: AgentBridgeClient;
  readonly lastError?: string;
  readonly lastMethod?: string;
  readonly claudeCommand?: string;
  readonly codexCommand?: string;
}

interface AgentBridgeTraceContext {
  readonly title: string;
  readonly url: string;
  readonly start: string;
  readonly end: string;
  readonly unixOffset: string;
  readonly timezoneOffsetMinutes: number;
  readonly importErrors: number;
  readonly traceTypes: readonly string[];
  readonly hasFtrace: boolean;
  readonly uuid: string;
  readonly cached: boolean;
  readonly downloadable: boolean;
}

declare global {
  interface Window {
    readonly __TAURI_INTERNALS__?: {
      readonly invoke?: TauriInvoke;
    };
  }
}

function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (invoke === undefined) {
    throw new Error('Tauri invoke API is not available in this runtime');
  }
  return invoke<T>(command, args);
}

function isEnabled(status?: AgentBridgeSnapshot): boolean {
  return status !== undefined && status.status !== 'Disabled';
}

function snapshotsEqual(
  a: AgentBridgeSnapshot | undefined,
  b: AgentBridgeSnapshot | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.status === b.status &&
    a.port === b.port &&
    a.endpoint === b.endpoint &&
    a.fallbackPort === b.fallbackPort &&
    a.sessionId === b.sessionId &&
    a.pendingClient?.clientId === b.pendingClient?.clientId &&
    a.pendingClient?.name === b.pendingClient?.name &&
    a.connectedClient?.clientId === b.connectedClient?.clientId &&
    a.connectedClient?.name === b.connectedClient?.name &&
    a.lastError === b.lastError &&
    a.lastMethod === b.lastMethod &&
    a.claudeCommand === b.claudeCommand &&
    a.codexCommand === b.codexCommand
  );
}

class AgentBridgePage implements m.ClassComponent<{readonly app: App}> {
  private status?: AgentBridgeSnapshot;
  private error?: string;
  private copied?: string;
  private refreshTimer?: number;
  private manuallyStopped = false;
  // Monotonic sequence so a slow `refresh` cannot overwrite a newer snapshot
  // produced by a button click in `runCommand`.
  private inflight = 0;

  oncreate(): void {
    void this.refresh({autoStart: true});
    this.refreshTimer = window.setInterval(() => {
      void this.refresh();
    }, 2000);
  }

  onremove(): void {
    if (this.refreshTimer !== undefined) {
      window.clearInterval(this.refreshTimer);
    }
  }

  view({attrs}: m.CVnode<{readonly app: App}>): m.Children {
    const status = this.status;
    return m(
      '.pf-agent-bridge-page',
      {
        style: {
          maxWidth: '920px',
          padding: '24px',
          display: 'grid',
          gap: '16px',
        },
      },
      [
        this.renderStatusSection(attrs.app, status),
        this.renderApprovalSection(status),
        this.renderCommandSection(status),
        this.renderConnectionSection(status),
      ],
    );
  }

  private renderStatusSection(app: App, status?: AgentBridgeSnapshot): m.Children {
    return m(
      Section,
      {title: 'Agent Bridge'},
      this.renderStatusCallout(status),
      m('div', {style: metaGridStyle}, [
        renderMeta('Status', status?.status ?? 'Starting'),
        renderMeta(
          'Trace',
          app.trace === undefined ? 'No trace loaded' : 'Trace loaded',
        ),
        renderMeta('Endpoint', status?.endpoint ?? 'Starting'),
        renderMeta(
          'Port',
          status?.port === undefined
            ? 'None'
            : `${status.port}${status.fallbackPort ? ' fallback' : ''}`,
        ),
      ]),
      this.error !== undefined &&
        m(Callout, {intent: Intent.Danger}, this.error),
      status?.lastError !== undefined &&
        m(Callout, {intent: Intent.Warning}, status.lastError),
      m(ButtonBar, [
        status?.status === 'Disabled' &&
          m(Button, {
            label: 'Start Bridge',
            icon: 'play_arrow',
            intent: Intent.Primary,
            variant: ButtonVariant.Filled,
            onclick: () => this.startBridge(),
          }),
        isEnabled(status) &&
          m(Button, {
            label: 'Stop Bridge',
            icon: 'stop',
            disabled: status?.status === 'Starting',
            onclick: () => this.stopBridge(),
          }),
        isEnabled(status) &&
          m(Button, {
            label: 'Regenerate Session',
            icon: 'refresh',
            disabled: status?.status === 'Starting',
            onclick: () => this.regenerateSession(),
          }),
        m(Button, {
          label: 'Refresh',
          icon: 'sync',
          onclick: () => this.refresh(),
        }),
      ]),
    );
  }

  private renderStatusCallout(status?: AgentBridgeSnapshot): m.Children {
    switch (status?.status) {
      case undefined:
      case 'Starting':
        return m(Callout, {intent: Intent.Primary}, 'Starting local bridge.');
      case 'Disabled':
        return m(Callout, {intent: Intent.Warning}, 'Bridge stopped.');
      case 'Listening':
        return m(Callout, {intent: Intent.Success}, 'Bridge ready.');
      case 'Pending Authorization':
        return m(Callout, {intent: Intent.Warning}, 'Client requesting access.');
      case 'Connected':
        return m(Callout, {intent: Intent.Success}, 'Client connected.');
      case 'Error':
        return m(Callout, {intent: Intent.Danger}, 'Bridge error.');
      default:
        return null;
    }
  }

  private renderApprovalSection(status?: AgentBridgeSnapshot): m.Children {
    const pending = status?.pendingClient ?? undefined;
    if (pending === undefined) return null;

    return m(
      Section,
      {title: 'Authorization Request'},
      m(Callout, {intent: Intent.Warning}, [
        m('strong', pending.name),
        ' is requesting access.',
      ]),
      m('div', {style: clientRowStyle}, [
        m('div', [
          m('div', {style: subtleStyle}, 'Client ID'),
          m('code', {style: codeStyle}, pending.clientId),
        ]),
        m(ButtonBar, [
          m(Button, {
            label: 'Allow',
            icon: 'check',
            intent: Intent.Primary,
            variant: ButtonVariant.Filled,
            onclick: () => this.runCommand('agent_bridge_allow_pending'),
          }),
          m(Button, {
            label: 'Deny',
            icon: 'close',
            intent: Intent.Danger,
            onclick: () => this.runCommand('agent_bridge_deny_pending'),
          }),
        ]),
      ]),
    );
  }

  private renderConnectionSection(status?: AgentBridgeSnapshot): m.Children {
    const pending = status?.pendingClient ?? undefined;
    const connected = status?.connectedClient ?? undefined;
    return m(
      Section,
      {title: 'Connection'},
      pending === undefined &&
        connected === undefined &&
        m('p', {style: subtleStyle}, 'No client connected.'),
      pending !== undefined && m('p', {style: subtleStyle}, pending.name),
      connected !== undefined &&
        m('div', {style: clientRowStyle}, [
          m('div', [
            m('strong', 'Connected'),
            m('div', {style: subtleStyle}, connected.name),
            m('code', {style: codeStyle}, connected.clientId),
          ]),
          m(Button, {
            label: 'Revoke',
            icon: 'link_off',
            intent: Intent.Danger,
            onclick: () => this.runCommand('agent_bridge_revoke_connected'),
          }),
        ]),
      status?.lastMethod !== undefined &&
        m('p', {style: subtleStyle}, `Last MCP method: ${status.lastMethod}`),
    );
  }

  private renderCommandSection(status?: AgentBridgeSnapshot): m.Children {
    if (!isEnabled(status)) {
      return m(
        Section,
        {title: 'Connection Commands'},
        m('p', {style: subtleStyle}, 'Bridge stopped.'),
      );
    }
    return m(
      Section,
      {title: 'Connection Commands'},
      this.copied !== undefined &&
        m(Callout, {intent: Intent.Success}, `${this.copied} copied.`),
      this.renderCommandBlock('Claude Code one-time', status?.claudeCommand),
      this.renderCommandBlock('Codex one-time', status?.codexCommand),
    );
  }

  private renderCommandBlock(label: string, command?: string): m.Children {
    if (command === undefined || command === null) return null;
    return m('div', {style: {marginTop: '12px'}}, [
      m('div', {style: commandHeaderStyle}, [
        m('strong', label),
        m(Button, {
          label: 'Copy',
          icon: 'content_copy',
          onclick: () => this.copyCommand(label, command),
        }),
      ]),
      m(CodeSnippet, {text: command, language: 'sh'}),
    ]);
  }

  private async refresh(
    options: {readonly autoStart?: boolean} = {},
  ): Promise<void> {
    const seq = ++this.inflight;
    let next: AgentBridgeSnapshot | undefined;
    let nextError: string | undefined;
    try {
      next = await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_status');
      if (
        options.autoStart === true &&
        !this.manuallyStopped &&
        next.status === 'Disabled'
      ) {
        next = await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_enable');
      }
    } catch (err) {
      nextError = err instanceof Error ? err.message : String(err);
    }
    if (seq !== this.inflight) return;
    if (
      nextError === this.error &&
      snapshotsEqual(next, this.status)
    ) {
      return;
    }
    this.status = next;
    this.error = nextError;
    m.redraw();
  }

  private async startBridge(): Promise<void> {
    this.manuallyStopped = false;
    await this.runCommand('agent_bridge_enable');
  }

  private async stopBridge(): Promise<void> {
    this.manuallyStopped = true;
    await this.runCommand('agent_bridge_disable');
  }

  private async regenerateSession(): Promise<void> {
    this.manuallyStopped = false;
    await this.runCommand('agent_bridge_regenerate_session');
  }

  private async runCommand(command: string): Promise<void> {
    const seq = ++this.inflight;
    try {
      const next = await tauriInvoke<AgentBridgeSnapshot>(command);
      if (seq !== this.inflight) return;
      this.status = next;
      this.error = undefined;
      this.copied = undefined;
    } catch (err) {
      if (seq !== this.inflight) return;
      this.error = err instanceof Error ? err.message : String(err);
    }
    m.redraw();
  }

  private async copyCommand(label: string, command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copied = label;
      this.error = undefined;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    m.redraw();
  }
}

const metaGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '12px',
};

const clientRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  alignItems: 'center',
};

const commandHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
};

const codeStyle = {
  overflowWrap: 'anywhere',
};

const subtleStyle = {
  color: 'var(--pf-color-text-muted)',
};

function renderMeta(label: string, value: string): m.Children {
  return m('div', [
    m('div', {style: {color: 'var(--pf-color-text-muted)', fontSize: '12px'}}, label),
    m('div', {style: {fontWeight: '600', overflowWrap: 'anywhere'}}, value),
  ]);
}

export default class PerfettoDesktopPlugin implements PerfettoPlugin {
  static readonly id = 'com.tooluselabs.PerfettoDesktop';
  static readonly description = `
    Tooluse Labs desktop integration plugin for Perfetto Desktop. This
    fork-owned plugin is the extension point for desktop-only features such as
    the planned local Agent Bridge.
  `;

  static onActivate(app: App): void {
    app.pages.registerPage({
      route: '/agent_bridge',
      render: () => m(AgentBridgePage, {app}),
    });
    app.sidebar.addMenuItem({
      section: 'settings',
      text: 'Agent Bridge',
      href: '#!/agent_bridge',
      icon: 'hub',
      sortOrder: 35,
    });
  }

  async onTraceLoad(_trace: Trace): Promise<void> {
    const traceInfo = _trace.traceInfo;
    const context: AgentBridgeTraceContext = {
      title: traceInfo.traceTitle,
      url: traceInfo.traceUrl,
      start: traceInfo.start.toString(),
      end: traceInfo.end.toString(),
      unixOffset: traceInfo.unixOffset.toString(),
      timezoneOffsetMinutes: traceInfo.tzOffMin,
      importErrors: traceInfo.importErrors,
      traceTypes: traceInfo.traceTypes,
      hasFtrace: traceInfo.hasFtrace,
      uuid: traceInfo.uuid,
      cached: traceInfo.cached,
      downloadable: traceInfo.downloadable,
    };
    await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_set_trace_context', {
      context,
    });
  }
}
