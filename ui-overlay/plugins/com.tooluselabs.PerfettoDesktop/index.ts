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
import {Intent} from '../../widgets/common';
import {Icon} from '../../widgets/icon';
import {Section} from '../../widgets/section';
import {SegmentedButton, SegmentedButtons} from '../../widgets/segmented_buttons';
import QueryPagePlugin from '../dev.perfetto.QueryPage';
import {AgentBridgeToolServer} from './bridge_tools';
import type {
  AgentBridgeRpcRequest,
  AgentBridgeRpcResponse,
  JsonValue,
} from './bridge_tools';

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
  readonly claudeCommandPs?: string;
  readonly codexCommandPs?: string;
}

type Shell = 'bash' | 'powershell';

function detectDefaultShell(): Shell {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
    return 'powershell';
  }
  return 'bash';
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
    a.codexCommand === b.codexCommand &&
    a.claudeCommandPs === b.claudeCommandPs &&
    a.codexCommandPs === b.codexCommandPs
  );
}

class AgentBridgePage implements m.ClassComponent<{readonly app: App}> {
  private status?: AgentBridgeSnapshot;
  private error?: string;
  private copied?: string;
  private refreshTimer?: number;
  private shell: Shell = detectDefaultShell();
  // Monotonic sequence so a slow `refresh` cannot overwrite a newer snapshot
  // produced by a button click in `runCommand`.
  private inflight = 0;

  oncreate(): void {
    void this.refresh();
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
      {style: pageStyle},
      [
        this.renderStatusSection(attrs.app, status),
        this.renderCommandSection(status, attrs.app.trace !== undefined),
        this.renderConnectionSection(status),
      ],
    );
  }

  private renderStatusSection(app: App, status?: AgentBridgeSnapshot): m.Children {
    return m(
      Section,
      {
        title: renderSectionTitle(
          'CLI Agent',
          this.renderStatusBadge(status),
        ),
      },
      this.renderOverviewPanel(app, status),
      m('div', {style: metaGridStyle}, [
        renderMeta(
          'Trace',
          app.trace === undefined ? 'No trace loaded' : 'Trace loaded',
          'timeline',
        ),
        renderMeta('Endpoint', status?.endpoint ?? 'Starting', 'link'),
        renderMeta(
          'Port',
          status?.port === undefined
            ? 'None'
            : `${status.port}${status.fallbackPort ? ' fallback' : ''}`,
          'settings_ethernet',
        ),
      ]),
      this.error !== undefined &&
        m(Callout, {icon: 'error', intent: Intent.Danger}, this.error),
      status?.lastError !== undefined &&
        m(
          Callout,
          {icon: 'warning', intent: Intent.Warning},
          status.lastError,
        ),
    );
  }

  private renderOverviewPanel(
    app: App,
    status?: AgentBridgeSnapshot,
  ): m.Children {
    return m('div', {style: overviewPanelStyle(status?.status)}, [
      m('div', {style: overviewMainStyle}, [
        m(
          'div',
          {style: overviewIconStyle(status?.status)},
          m(Icon, {
            icon: statusIcon(status?.status),
            intent: statusIntent(status?.status),
            filled: true,
          }),
        ),
        m('div', {style: overviewTextStyle}, [
          m('div', {style: overviewKickerStyle}, 'Local MCP Bridge'),
          m('div', {style: overviewTitleStyle}, statusHeadline(app, status)),
          m(
            'div',
            {style: overviewSubtitleStyle},
            status?.endpoint ?? 'Endpoint is starting',
          ),
        ]),
      ]),
      this.renderBridgeActions(status),
    ]);
  }

  private renderBridgeActions(status?: AgentBridgeSnapshot): m.Children {
    return m(
      ButtonBar,
      {style: bridgeActionsStyle},
      [
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
            intent: Intent.Danger,
            variant: ButtonVariant.Outlined,
            disabled: status?.status === 'Starting',
            onclick: () => this.stopBridge(),
          }),
        isEnabled(status) &&
          m(Button, {
            label: 'Regenerate Session',
            icon: 'refresh',
            variant: ButtonVariant.Outlined,
            disabled: status?.status === 'Starting',
            onclick: () => this.regenerateSession(),
          }),
        m(Button, {
          label: 'Refresh',
          icon: 'sync',
          variant: ButtonVariant.Outlined,
          onclick: () => this.refresh(),
        }),
      ],
    );
  }

  private renderStatusBadge(status?: AgentBridgeSnapshot): m.Children {
    const label = status?.status ?? 'Starting';
    return m('span', {style: statusBadgeStyle(status?.status)}, label);
  }

  private renderConnectionSection(status?: AgentBridgeSnapshot): m.Children {
    const pending = status?.pendingClient ?? undefined;
    const connected = status?.connectedClient ?? undefined;
    return m(
      Section,
      {title: renderSectionTitle('Current Connection')},
      pending === undefined &&
        connected === undefined &&
        renderEmptyState('link_off', 'No client connected.'),
      pending !== undefined &&
        m(
          'div',
          {style: clientPanelStyle},
          [
            renderPanelIcon('pending', Intent.Warning),
            m('div', {style: clientTextStyle}, [
              m('div', {style: clientLabelStyle}, 'Connecting client'),
              m('div', {style: subtleStyle}, pending.name),
              m('code', {style: codeStyle}, pending.clientId),
            ]),
          ],
        ),
      connected !== undefined &&
        m('div', {style: clientPanelStyle}, [
          m('div', {style: clientMainStyle}, [
            renderPanelIcon('hub', Intent.Success),
            m('div', {style: clientTextStyle}, [
              m('div', {style: clientLabelStyle}, 'Connected client'),
              m('div', {style: subtleStyle}, connected.name),
              m('code', {style: codeStyle}, connected.clientId),
            ]),
          ]),
          m(Button, {
            label: 'Revoke',
            icon: 'link_off',
            intent: Intent.Danger,
            variant: ButtonVariant.Outlined,
            onclick: () => this.runCommand('agent_bridge_revoke_connected'),
          }),
        ]),
      status?.lastMethod !== undefined &&
        m('p', {style: subtleStyle}, `Last MCP method: ${status.lastMethod}`),
    );
  }

  private renderCommandSection(
    status: AgentBridgeSnapshot | undefined,
    hasTrace: boolean,
  ): m.Children {
    if (!isEnabled(status)) {
      return m(
        Section,
        {title: renderSectionTitle('Connection Commands')},
        renderEmptyState('power_settings_new', 'Bridge stopped.'),
      );
    }
    const isPs = this.shell === 'powershell';
    const claudeCmd = isPs ? status?.claudeCommandPs : status?.claudeCommand;
    const codexCmd = isPs ? status?.codexCommandPs : status?.codexCommand;
    return m(
      Section,
      {title: renderSectionTitle('Connection Commands')},
      this.renderShellToggle(),
      this.copied !== undefined &&
        m(
          Callout,
          {icon: 'content_copy', intent: Intent.Success},
          `${this.copied} copied.`,
        ),
      !hasTrace &&
        m(
          Callout,
          {icon: 'timeline', intent: Intent.Warning},
          'Load a trace before copying a CLI command so the agent starts with trace context.',
        ),
      this.renderCommandBlock('Claude Code', claudeCmd, !hasTrace),
      this.renderCommandBlock('Codex', codexCmd, !hasTrace),
    );
  }

  private renderShellToggle(): m.Children {
    return m('div', {style: shellToggleStyle}, [
      m('span', {style: shellToggleLabelStyle}, 'Shell'),
      m(
        SegmentedButtons,
        {
          selectedValue: this.shell,
          intent: Intent.Primary,
          onOptionSelected: (value) => this.selectShell(value as Shell),
        },
        [
          m(SegmentedButton, {value: 'bash', icon: 'terminal'}, 'Bash / Zsh'),
          m(SegmentedButton, {value: 'powershell', icon: 'terminal'}, 'PowerShell'),
        ],
      ),
    ]);
  }

  private selectShell(shell: Shell): void {
    if (this.shell === shell) return;
    this.shell = shell;
    this.copied = undefined;
  }

  private renderCommandBlock(
    label: string,
    command: string | undefined,
    copyDisabled: boolean,
  ): m.Children {
    if (command === undefined || command === null) return null;
    return m('div', {style: commandBlockStyle}, [
      m('div', {style: commandHeaderStyle}, [
        m('div', {style: commandTitleStyle}, [
          renderPanelIcon('terminal', Intent.Primary),
          m('div', {style: commandLabelStyle}, label),
        ]),
        m(
          'div',
          {style: commandActionsStyle},
          m(Button, {
            label: 'Copy',
            icon: 'content_copy',
            intent: Intent.Primary,
            variant: ButtonVariant.Filled,
            disabled: copyDisabled,
            onclick: () => this.copyCommand(label, command),
          }),
        ),
      ]),
      m('pre', {style: commandTextStyle}, m('code', command)),
    ]);
  }

  private async refresh(): Promise<void> {
    const seq = ++this.inflight;
    let next: AgentBridgeSnapshot | undefined;
    let nextError: string | undefined;
    try {
      next = await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_status');
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
    await this.runCommand('agent_bridge_enable');
  }

  private async stopBridge(): Promise<void> {
    await this.runCommand('agent_bridge_disable');
  }

  private async regenerateSession(): Promise<void> {
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

const pageStyle = {
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '960px',
  margin: '0 auto',
  padding: '24px 16px 32px',
  display: 'grid',
  gap: '20px',
  overflowX: 'hidden',
};

const sectionTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '16px',
  width: '100%',
};

const sectionHeadingStyle = {
  margin: '0',
  fontSize: '20px',
  fontWeight: '600',
};

const statusBadgeBaseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: '24px',
  padding: '2px 10px',
  borderRadius: '6px',
  border: '1px solid var(--pf-color-border)',
  background: 'var(--pf-color-background-secondary)',
  fontSize: '12px',
  fontWeight: '600',
  whiteSpace: 'nowrap',
};

const overviewMainStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  flex: '1 1 320px',
  minWidth: '0',
};

const overviewTextStyle = {
  minWidth: '0',
};

const overviewKickerStyle = {
  color: 'var(--pf-color-text-muted)',
  fontSize: '12px',
  fontWeight: '600',
  textTransform: 'uppercase',
};

const overviewTitleStyle = {
  marginTop: '2px',
  fontSize: '22px',
  fontWeight: '650',
};

const overviewSubtitleStyle = {
  marginTop: '4px',
  color: 'var(--pf-color-text-muted)',
  fontFamily: 'Roboto Mono, monospace',
  fontSize: '12px',
  overflowWrap: 'anywhere',
};

const bridgeActionsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  maxWidth: '100%',
};

const metaGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))',
  gap: '12px',
  minWidth: '0',
};

const metaItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 12px',
  border: '1px solid var(--pf-color-border-secondary)',
  borderRadius: '6px',
  background: 'var(--pf-color-background-secondary)',
  minWidth: '0',
};

const clientPanelStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '16px',
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '12px',
  border: '1px solid var(--pf-color-border-secondary)',
  borderRadius: '6px',
  background: 'var(--pf-color-background-secondary)',
  minWidth: '0',
};

const clientMainStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minWidth: '0',
};

const clientTextStyle = {
  minWidth: '0',
};

const clientLabelStyle = {
  color: 'var(--pf-color-text-muted)',
  fontSize: '12px',
  fontWeight: '600',
  marginBottom: '4px',
};

const emptyStateStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '12px',
  border: '1px dashed var(--pf-color-border)',
  borderRadius: '6px',
  color: 'var(--pf-color-text-muted)',
  background: 'var(--pf-color-background-secondary)',
};

const commandBlockStyle = {
  boxSizing: 'border-box',
  marginTop: '12px',
  padding: '12px',
  border: '1px solid var(--pf-color-border-secondary)',
  borderLeft: '4px solid var(--pf-color-primary)',
  borderRadius: '6px',
  background: 'var(--pf-color-background-secondary)',
  maxWidth: '100%',
  minWidth: '0',
};

const commandHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '12px',
  alignItems: 'center',
  flexWrap: 'wrap',
  marginBottom: '8px',
  minWidth: '0',
};

const commandTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minWidth: '0',
};

const commandLabelStyle = {
  fontWeight: '600',
  overflowWrap: 'anywhere',
};

const commandActionsStyle = {
  flex: '0 0 auto',
};

const commandTextStyle = {
  boxSizing: 'border-box',
  margin: '0',
  padding: '12px',
  width: '100%',
  maxWidth: '100%',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  border: '1px solid var(--pf-color-border)',
  borderRadius: '6px',
  background: 'var(--pf-color-background)',
  fontFamily: 'Roboto Mono, monospace',
  fontSize: '12px',
  lineHeight: '18px',
};

const panelIconStyle = {
  display: 'inline-grid',
  placeItems: 'center',
  width: '32px',
  height: '32px',
  flex: '0 0 32px',
  borderRadius: '6px',
  border: '1px solid var(--pf-color-border)',
  background: 'var(--pf-color-background)',
};

const shellToggleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  marginBottom: '12px',
  flexWrap: 'wrap',
};

const shellToggleLabelStyle = {
  color: 'var(--pf-color-text-muted)',
  fontSize: '12px',
  fontWeight: '600',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const codeStyle = {
  overflowWrap: 'anywhere',
};

const subtleStyle = {
  color: 'var(--pf-color-text-muted)',
};

function renderSectionTitle(title: string, right?: m.Children): m.Children {
  return m('div', {style: sectionTitleStyle}, [
    m('h1', {style: sectionHeadingStyle}, title),
    right,
  ]);
}

function overviewPanelStyle(status?: BridgeStatus): Partial<CSSStyleDeclaration> {
  const color = statusAccentColor(status);
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '16px',
    padding: '16px',
    border: '1px solid var(--pf-color-border-secondary)',
    borderLeft: `4px solid ${color}`,
    borderRadius: '6px',
    background: `color-mix(in srgb, ${color} 7%, var(--pf-color-background))`,
  };
}

function overviewIconStyle(status?: BridgeStatus): Partial<CSSStyleDeclaration> {
  const color = statusAccentColor(status);
  return {
    display: 'grid',
    placeItems: 'center',
    width: '48px',
    height: '48px',
    flex: '0 0 48px',
    borderRadius: '8px',
    border: `1px solid color-mix(in srgb, ${color} 45%, var(--pf-color-border))`,
    background: `color-mix(in srgb, ${color} 13%, var(--pf-color-background-secondary))`,
    fontSize: '24px',
  };
}

function statusBadgeStyle(status?: BridgeStatus): Partial<CSSStyleDeclaration> {
  const color = statusAccentColor(status);
  return {
    ...statusBadgeBaseStyle,
    borderColor: `color-mix(in srgb, ${color} 55%, var(--pf-color-border))`,
    background: `color-mix(in srgb, ${color} 10%, var(--pf-color-background-secondary))`,
    color,
  };
}

function statusAccentColor(status?: BridgeStatus): string {
  switch (status) {
    case 'Connected':
    case 'Listening':
      return 'var(--pf-color-success)';
    case 'Pending Authorization':
      return 'var(--pf-color-warning)';
    case 'Error':
      return 'var(--pf-color-danger)';
    case 'Disabled':
      return 'var(--pf-color-text-muted)';
    case 'Starting':
    case undefined:
      return 'var(--pf-color-primary)';
  }
}

function statusIntent(status?: BridgeStatus): Intent {
  switch (status) {
    case 'Connected':
    case 'Listening':
      return Intent.Success;
    case 'Pending Authorization':
      return Intent.Warning;
    case 'Error':
      return Intent.Danger;
    case 'Disabled':
      return Intent.Warning;
    case 'Starting':
    case undefined:
      return Intent.Primary;
  }
}

function statusIcon(status?: BridgeStatus): string {
  switch (status) {
    case 'Connected':
      return 'hub';
    case 'Listening':
      return 'radio_button_checked';
    case 'Pending Authorization':
      return 'pending';
    case 'Error':
      return 'error';
    case 'Disabled':
      return 'pause_circle';
    case 'Starting':
    case undefined:
      return 'sync';
  }
}

function statusHeadline(
  app: App,
  status?: AgentBridgeSnapshot,
): string {
  if (app.trace === undefined) return 'No trace loaded';
  switch (status?.status) {
    case 'Connected':
      return `Connected to ${status.connectedClient?.name ?? 'client'}`;
    case 'Listening':
      return 'Ready for CLI connection';
    case 'Pending Authorization':
      return 'Client connecting';
    case 'Error':
      return 'Bridge needs attention';
    case 'Disabled':
      return 'Bridge stopped';
    case 'Starting':
    case undefined:
      return 'Starting bridge';
  }
}

function renderPanelIcon(icon: string, intent = Intent.None): m.Children {
  return m(
    'span',
    {style: panelIconStyle},
    m(Icon, {icon, intent, filled: true}),
  );
}

function renderEmptyState(icon: string, text: string): m.Children {
  return m('div', {style: emptyStateStyle}, [
    renderPanelIcon(icon),
    m('span', text),
  ]);
}

function renderMeta(label: string, value: string, icon: string): m.Children {
  return m('div', {style: metaItemStyle}, [
    renderPanelIcon(icon, Intent.Primary),
    m(
      'div',
      {style: {minWidth: '0'}},
      [
        m(
          'div',
          {
            style: {
              color: 'var(--pf-color-text-muted)',
              fontSize: '12px',
              fontWeight: '600',
            },
          },
          label,
        ),
        m(
          'div',
          {style: {fontWeight: '600', overflowWrap: 'anywhere'}},
          value,
        ),
      ],
    ),
  ]);
}

export default class PerfettoDesktopPlugin implements PerfettoPlugin {
  static readonly id = 'com.tooluselabs.PerfettoDesktop';
  static readonly dependencies = [QueryPagePlugin];
  static readonly description = `
    Tooluse Labs desktop integration plugin for Perfetto Desktop. This
    fork-owned plugin is the extension point for desktop-only features such as
    local CLI agent access.
  `;
  private static bridgeToolsPromise?: Promise<AgentBridgeToolServer>;
  private static currentTrace: Trace | null = null;
  private static traceContext?: AgentBridgeTraceContext;
  private static rpcPumpStarted = false;
  private static bridgeStartPromise?: Promise<void>;

  static onActivate(app: App): void {
    PerfettoDesktopPlugin.bridgeToolsPromise = AgentBridgeToolServer.create(
      () => PerfettoDesktopPlugin.currentTrace,
      () => (PerfettoDesktopPlugin.traceContext ?? null) as JsonValue,
    );
    void PerfettoDesktopPlugin.ensureBridgeStarted();
    PerfettoDesktopPlugin.startRpcRequestPump();
    app.pages.registerPage({
      route: '/agent_bridge',
      render: () => m(AgentBridgePage, {app}),
    });
    app.sidebar.addMenuItem({
      section: 'current_trace',
      text: 'CLI Agent',
      href: '#!/agent_bridge',
      icon: 'hub',
      sortOrder: 11,
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
    PerfettoDesktopPlugin.currentTrace = _trace;
    PerfettoDesktopPlugin.traceContext = context;
    await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_set_trace_context', {
      context,
    });
  }

  private static async ensureBridgeStarted(): Promise<void> {
    if (PerfettoDesktopPlugin.bridgeStartPromise !== undefined) {
      return PerfettoDesktopPlugin.bridgeStartPromise;
    }
    PerfettoDesktopPlugin.bridgeStartPromise = (async () => {
      try {
        const status = await tauriInvoke<AgentBridgeSnapshot>(
          'agent_bridge_status',
        );
        if (status.status === 'Disabled') {
          await tauriInvoke<AgentBridgeSnapshot>('agent_bridge_enable');
        }
      } catch (err) {
        console.warn('Perfetto Desktop Agent Bridge auto-start failed', err);
      } finally {
        PerfettoDesktopPlugin.bridgeStartPromise = undefined;
      }
    })();
    return PerfettoDesktopPlugin.bridgeStartPromise;
  }

  private static startRpcRequestPump(): void {
    if (PerfettoDesktopPlugin.rpcPumpStarted) return;
    PerfettoDesktopPlugin.rpcPumpStarted = true;
    void PerfettoDesktopPlugin.runRpcRequestPump();
  }

  // The Tauri command long-polls (~25s) and resolves immediately when a new
  // request lands, so this loop is the entire pump — no setInterval needed.
  private static async runRpcRequestPump(): Promise<void> {
    while (true) {
      try {
        const request = await tauriInvoke<AgentBridgeRpcRequest | null>(
          'agent_bridge_next_rpc_request',
        );
        if (request === null || request === undefined) continue;
        const response = await PerfettoDesktopPlugin.handleRpcRequest(request);
        await tauriInvoke('agent_bridge_complete_rpc_request', {
          requestId: request.requestId,
          response,
        });
      } catch (err) {
        // Keep the pump alive; the MCP side will time out if completion cannot
        // be delivered. Back off briefly to avoid a tight error loop.
        console.warn('Perfetto Desktop Agent Bridge RPC pump failed', err);
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    }
  }

  private static async handleRpcRequest(
    request: AgentBridgeRpcRequest,
  ): Promise<AgentBridgeRpcResponse> {
    const promise = PerfettoDesktopPlugin.bridgeToolsPromise;
    if (promise === undefined) {
      return {
        error: {
          code: -32603,
          message: 'Agent Bridge tool server is not initialized',
        },
      };
    }
    try {
      const bridgeTools = await promise;
      return bridgeTools.handle(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: {
          code: -32603,
          message: `Agent Bridge tool server failed to initialize: ${message}`,
        },
      };
    }
  }
}
