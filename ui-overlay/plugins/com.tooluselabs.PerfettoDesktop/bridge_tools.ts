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
import {sqliteString} from '../../base/string_utils';
import type {Trace} from '../../public/trace';
import type {Engine} from '../../trace_processor/engine';
import {runQueryForMcp} from '../com.google.PerfettoMcp/query';
import {registerUiTools} from '../com.google.PerfettoMcp/uitools';

const SQL_ROW_CAP = 500;
const SQL_BYTE_CAP = 1024 * 1024;
const SQL_TIMEOUT_MS = 15_000;

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

const BRIDGE_TOOL_DEFINITIONS = [
  {
    name: 'perfetto-get-trace-info',
    description:
      'Return current Perfetto Desktop trace metadata and CLI Agent tool guidance.',
    inputSchema: {
      type: 'object',
      properties: {reason: {type: 'string'}},
      additionalProperties: false,
    },
  },
  {
    name: 'perfetto-execute-query',
    description:
      'Query the trace loaded in Perfetto Desktop using bounded PerfettoSQL.',
    inputSchema: {
      type: 'object',
      properties: {query: {type: 'string'}},
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'perfetto-list-android-processes',
    description: 'List process details from the current trace process table.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'perfetto-list-interesting-tables',
    description:
      'List non-internal PerfettoSQL tables and views visible in sqlite_schema.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'perfetto-list-macrobenchmark-slices',
    description:
      'List macrobenchmark measureBlock slices when present in the current trace.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'perfetto-list-table-structure',
    description: 'List the column structure for one PerfettoSQL table or view.',
    inputSchema: {
      type: 'object',
      properties: {table: {type: 'string'}},
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'show-perfetto-sql-view',
    description: 'Shows a SQL query in the Perfetto SQL view.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string'},
        viewName: {type: 'string'},
      },
      required: ['query', 'viewName'],
      additionalProperties: false,
    },
  },
  {
    name: 'show-timeline',
    description: 'Shows some context in the Perfetto Timeline view.',
    inputSchema: {
      type: 'object',
      properties: {
        timeSpan: {
          type: 'object',
          properties: {
            startTime: {type: 'string'},
            endTime: {type: 'string'},
          },
          required: ['startTime', 'endTime'],
          additionalProperties: false,
        },
        focus: {
          type: 'object',
          properties: {
            table: {type: 'string'},
            id: {type: 'number'},
          },
          required: ['table', 'id'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
] as const;

const BRIDGE_TOOL_NAMES: readonly string[] = BRIDGE_TOOL_DEFINITIONS.map(
  (tool) => tool.name,
);

export function handleNoTraceRpcRequest(
  request: AgentBridgeRpcRequest,
  getTraceContext: () => JsonValue,
): AgentBridgeRpcResponse {
  switch (request.method) {
    case 'tools/list':
      return {result: {tools: BRIDGE_TOOL_DEFINITIONS}};
    case 'tools/call':
      return handleNoTraceToolCall(request.params, getTraceContext);
    default:
      return {
        error: {
          code: -32601,
          message: `unsupported WebView MCP method: ${request.method}`,
        },
      };
  }
}

export class AgentBridgeToolServer {
  private constructor(
    private readonly mcpServer: McpServer,
    private readonly client: Client,
  ) {}

  static async create(
    trace: Trace,
    getTraceContext: () => JsonValue,
  ): Promise<AgentBridgeToolServer> {
    const mcpServer = new McpServer({
      name: 'perfetto-desktop-bridge',
      version: '1.0.0',
    });

    registerBridgeTraceTools(mcpServer, trace.engine, getTraceContext);
    registerUiTools(mcpServer, trace);

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
  engine: Engine,
  getTraceContext: () => JsonValue,
): void {
  server.tool(
    'perfetto-get-trace-info',
    'Return current Perfetto Desktop trace metadata and Agent Bridge tool guidance.',
    {reason: z.string().optional()},
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              trace: getTraceContext(),
              implementedTools: BRIDGE_TOOL_NAMES,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    'perfetto-execute-query',
    `
      Query the trace loaded in Perfetto Desktop using PerfettoSQL.
      Prefer aggregates and stdlib views over raw table scans. The bridge
      applies row, byte, and timeout caps to protect the UI.
    `,
    {query: z.string()},
    async ({query}) => toolText(await runBoundedQueryForMcp(engine, query)),
  );

  server.tool(
    'perfetto-list-android-processes',
    'List process details from the current trace process table.',
    {},
    async () =>
      toolText(
        await runBoundedQueryForMcp(
          engine,
          `
            SELECT *
            FROM process
            ORDER BY name
          `,
        ),
      ),
  );

  server.tool(
    'perfetto-list-interesting-tables',
    'List non-internal PerfettoSQL tables and views visible in sqlite_schema.',
    {},
    async () =>
      toolText(
        await runBoundedQueryForMcp(
          engine,
          `
            SELECT name, type
            FROM sqlite_schema
            WHERE type in ('table', 'view')
              AND name NOT LIKE 'sqlite_%'
              AND name NOT LIKE '\\_%' ESCAPE '\\'
            ORDER BY type, name
          `,
        ),
      ),
  );

  server.tool(
    'perfetto-list-macrobenchmark-slices',
    'List macrobenchmark measureBlock slices when present in the current trace.',
    {},
    async () =>
      toolText(
        await runBoundedQueryForMcp(
          engine,
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
      ),
  );

  server.tool(
    'perfetto-list-table-structure',
    'List the column structure for one PerfettoSQL table or view.',
    {table: z.string()},
    async ({table}) =>
      toolText(
        await runBoundedQueryForMcp(
          engine,
          `SELECT * FROM pragma_table_info(${sqliteString(table)})`,
        ),
      ),
  );
}

function handleNoTraceToolCall(
  params: Record<string, unknown> | undefined,
  getTraceContext: () => JsonValue,
): AgentBridgeRpcResponse {
  const name = params?.name;
  if (typeof name !== 'string' || name.length === 0) {
    return {result: toolText('tools/call requires a tool name', true)};
  }
  if (!BRIDGE_TOOL_NAMES.includes(name)) {
    return {error: {code: -32601, message: `unknown tool: ${name}`}};
  }
  if (name === 'perfetto-get-trace-info') {
    return {
      result: toolText(
        JSON.stringify(
          {
            trace: getTraceContext(),
            traceLoaded: false,
            implementedTools: BRIDGE_TOOL_NAMES,
            note:
              'No trace is loaded in Perfetto Desktop yet. Ask the user to load a trace, then call perfetto-get-trace-info again before analyzing trace data.',
          },
          null,
          2,
        ),
      ),
    };
  }
  return {
    result: toolText(
      'No trace is loaded in Perfetto Desktop yet. Ask the user to load a trace, then retry this tool call.',
      true,
    ),
  };
}

async function runBoundedQueryForMcp(
  engine: Engine,
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
