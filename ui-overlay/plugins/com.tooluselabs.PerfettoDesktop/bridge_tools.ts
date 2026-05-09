// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {assertTrue} from '../../base/assert';
import {sqliteString} from '../../base/string_utils';
import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import {runQueryForMcp} from '../com.google.PerfettoMcp/query';
import QueryPagePlugin from '../dev.perfetto.QueryPage';

const SQL_ROW_CAP = 500;
const SQL_BYTE_CAP = 1024 * 1024;
const SQL_TIMEOUT_MS = 15_000;

const NO_TRACE_HINT =
  'No trace is loaded in Perfetto Desktop yet. Ask the user to load a trace, then retry this tool call.';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};

export interface AgentBridgeRpcRequest {
  readonly requestId: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface AgentBridgeRpcResponse {
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

// Single source of truth for the names exposed via tools/list. The actual
// schemas come from the McpServer registrations below; this list only feeds
// the `perfetto-get-trace-info` payload so the agent sees a stable surface
// before and after a trace is loaded.
const BRIDGE_TOOL_NAMES: readonly string[] = [
  'perfetto-get-trace-info',
  'perfetto-execute-query',
  'perfetto-list-android-processes',
  'perfetto-list-interesting-tables',
  'perfetto-list-macrobenchmark-slices',
  'perfetto-list-table-structure',
  'show-perfetto-sql-view',
  'show-timeline',
];

export class AgentBridgeToolServer {
  private constructor(
    private readonly mcpServer: McpServer,
    private readonly client: Client,
  ) {}

  static async create(
    getTrace: () => Trace | null,
    getTraceContext: () => JsonValue,
  ): Promise<AgentBridgeToolServer> {
    const mcpServer = new McpServer({
      name: 'perfetto-desktop-bridge',
      version: '1.0.0',
    });

    registerBridgeTraceTools(mcpServer, getTrace, getTraceContext);
    registerBridgeUiTools(mcpServer, getTrace);

    const client = new Client({
      name: 'perfetto-desktop-bridge-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    return new AgentBridgeToolServer(mcpServer, client);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.client.close(), this.mcpServer.close()]);
  }

  async handle(request: AgentBridgeRpcRequest): Promise<AgentBridgeRpcResponse> {
    try {
      switch (request.method) {
        case 'tools/list':
          return {result: await this.client.listTools(request.params)};
        case 'tools/call':
          return {result: await this.callTool(request.params)};
        default:
          return {
            error: {
              code: -32601,
              message: `unsupported WebView MCP method: ${request.method}`,
            },
          };
      }
    } catch (err) {
      return {
        error: {
          code: -32000,
          message: formatError(err),
        },
      };
    }
  }

  private async callTool(params?: Record<string, unknown>): Promise<unknown> {
    const name = params?.name;
    if (typeof name !== 'string' || name.length === 0) {
      return {
        content: [{type: 'text', text: 'tools/call requires a tool name'}],
        isError: true,
      };
    }
    const toolArguments = params?.arguments;
    return this.client.callTool({
      name,
      arguments: isRecord(toolArguments) ? toolArguments : undefined,
    });
  }
}

function registerBridgeTraceTools(
  server: McpServer,
  getTrace: () => Trace | null,
  getTraceContext: () => JsonValue,
): void {
  server.tool(
    'perfetto-get-trace-info',
    'Return current Perfetto Desktop trace metadata and CLI Agent tool guidance.',
    {reason: z.string().optional()},
    async () => {
      const trace = getTrace();
      const payload: Record<string, unknown> = {
        trace: getTraceContext(),
        traceLoaded: trace !== null,
        implementedTools: BRIDGE_TOOL_NAMES,
      };
      if (trace === null) payload.note = NO_TRACE_HINT;
      return toolText(JSON.stringify(payload, null, 2));
    },
  );

  server.tool(
    'perfetto-execute-query',
    `
      Query the trace loaded in Perfetto Desktop using PerfettoSQL.
      Prefer aggregates and stdlib views over raw table scans. The bridge
      applies row, byte, and timeout caps to protect the UI.
    `,
    {query: z.string()},
    async ({query}) => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      return toolText(await runBoundedQueryForMcp(trace.engine, query));
    },
  );

  server.tool(
    'perfetto-list-android-processes',
    'List process details from the current trace process table.',
    {},
    async () => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      return toolText(
        await runBoundedQueryForMcp(
          trace.engine,
          `
            SELECT *
            FROM process
            ORDER BY name
          `,
        ),
      );
    },
  );

  server.tool(
    'perfetto-list-interesting-tables',
    'List non-internal PerfettoSQL tables and views visible in sqlite_schema.',
    {},
    async () => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      return toolText(
        await runBoundedQueryForMcp(
          trace.engine,
          `
            SELECT name, type
            FROM sqlite_schema
            WHERE type in ('table', 'view')
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE '\\_%' ESCAPE '\\'
            ORDER BY type, name
          `,
        ),
      );
    },
  );

  server.tool(
    'perfetto-list-macrobenchmark-slices',
    'List macrobenchmark measureBlock slices when present in the current trace.',
    {},
    async () => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      return toolText(
        await runBoundedQueryForMcp(
          trace.engine,
          `
            SELECT
              s.name AS slice_name,
              s.ts,
              s.dur,
              t.name AS thread_name,
              p.name AS process_name
            FROM slice s
            JOIN thread_track tt ON s.track_id = tt.id
            JOIN thread t ON tt.utid = t.utid
            JOIN process p ON t.upid = p.upid
            WHERE s.name = 'measureBlock'
            ORDER BY s.ts
          `,
        ),
      );
    },
  );

  server.tool(
    'perfetto-list-table-structure',
    'List the column structure for one PerfettoSQL table or view.',
    {table: z.string()},
    async ({table}) => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      return toolText(
        await runBoundedQueryForMcp(
          trace.engine,
          `SELECT * FROM pragma_table_info(${sqliteString(table)})`,
        ),
      );
    },
  );
}

// Vendored from upstream com.google.PerfettoMcp/uitools.ts so handlers can
// resolve the current Trace at call time. Keeping a single AgentBridgeToolServer
// alive across trace load/unload requires the trace getter to be lazy — upstream
// captures the Trace eagerly at registration, which would tear down and rebuild
// the tools/list schema surface every time the loaded trace changed.
//
// When bumping the pinned Perfetto SHA (scripts/update-perfetto.sh), diff this
// against third_party/perfetto/ui/src/plugins/com.google.PerfettoMcp/uitools.ts
// and port over any new tools or argument changes.
function registerBridgeUiTools(
  server: McpServer,
  getTrace: () => Trace | null,
): void {
  server.tool(
    'show-perfetto-sql-view',
    'Shows a SQL query in the Perfetto SQL view.',
    {
      query: z.string(),
      viewName: z.string(),
    },
    async ({query, viewName}) => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      trace.plugins.getPlugin(QueryPagePlugin).addQueryResultsTab({
        query,
        title: viewName,
      });
      return {content: [{type: 'text', text: 'OK'}]};
    },
  );

  server.tool(
    'show-timeline',
    `
      Shows some context in the Timeline view.
      'timeSpan' controls the range of time to be shown. For example { startTime: '261195375150266', endTime: '261197502806936' }
      'focus' controls the row to be shown. For example { table: 'slice', id: 1234 }

      Timestamps in Perfetto are bigints, and in most tables represent nanoseconds in 'trace processor time'.
      These are device and trace specific, you can query the min/max of the slice table to get a valid range.
    `,
    {
      timeSpan: z
        .object({
          startTime: z.string(),
          endTime: z.string(),
        })
        .optional(),
      focus: z
        .object({
          table: z.string(),
          id: z.number(),
        })
        .optional(),
    },
    async ({timeSpan, focus}) => {
      const trace = getTrace();
      if (trace === null) return toolText(NO_TRACE_HINT, true);
      if (timeSpan) {
        const startTime = BigInt(timeSpan.startTime);
        const endTime = BigInt(timeSpan.endTime);
        assertTrue(startTime >= trace.traceInfo.start);
        assertTrue(endTime <= trace.traceInfo.end);
        trace.timeline.panSpanIntoView(
          Time.fromRaw(startTime),
          Time.fromRaw(endTime),
          {align: 'zoom'},
        );
      }
      if (focus) {
        trace.selection.selectSqlEvent(focus.table, focus.id, {
          scrollToSelection: true,
          switchToCurrentSelectionTab: true,
        });
      }
      return {content: [{type: 'text', text: 'OK'}]};
    },
  );
}

async function runBoundedQueryForMcp(
  engine: import('../../trace_processor/engine').Engine,
  query: string,
): Promise<string> {
  const started = performance.now();
  const executedQuery = boundSql(query);
  const rawText = await withTimeout(
    runQueryForMcp(engine, executedQuery),
    SQL_TIMEOUT_MS,
  );
  const elapsedMs = performance.now() - started;
  const byteCount = new TextEncoder().encode(rawText).byteLength;
  const parsed = parseJsonArray(rawText);
  const rowTruncated = parsed.length > SQL_ROW_CAP;
  const rows = rowTruncated ? parsed.slice(0, SQL_ROW_CAP) : parsed;
  const payload = {
    data: rows,
    truncated: rowTruncated
      ? {reason: 'row_cap', rowCap: SQL_ROW_CAP, returnedRows: rows.length}
      : null,
    elapsedMs,
    byteCount,
    executedQuery,
  };
  const payloadText = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(payloadText).byteLength;
  if (payloadBytes <= SQL_BYTE_CAP) return payloadText;
  return JSON.stringify({
    data: payloadText.slice(0, SQL_BYTE_CAP),
    dataFormat: 'truncated-json-string',
    truncated: {
      reason: 'byte_cap',
      byteCap: SQL_BYTE_CAP,
      byteCount: payloadBytes,
    },
    elapsedMs,
    byteCount,
    executedQuery,
  });
}

function boundSql(query: string): string {
  const trimmed = query.trim().replace(/;+$/, '').trim();
  if (trimmed.includes(';')) {
    throw new Error('Only a single SQL statement is supported');
  }
  if (/^(select|with)\b/i.test(trimmed)) {
    return `SELECT * FROM (${trimmed}) LIMIT ${SQL_ROW_CAP + 1}`;
  }
  if (/^include\s+perfetto\s+module\b/i.test(trimmed)) {
    return trimmed;
  }
  throw new Error('Only SELECT, WITH, or INCLUDE PERFETTO MODULE statements are supported');
}

function parseJsonArray(text: string): unknown[] {
  const value = JSON.parse(text) as unknown;
  return Array.isArray(value) ? value : [value];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`PerfettoSQL query exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function toolText(text: string, isError = false) {
  const result: {
    content: Array<{type: 'text'; text: string}>;
    isError?: boolean;
  } = {content: [{type: 'text', text}]};
  if (isError) result.isError = true;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stackLine = err.stack?.split('\n').find((line) => line.includes('/'));
  return stackLine === undefined ? err.message : `${err.message} (${stackLine.trim()})`;
}
