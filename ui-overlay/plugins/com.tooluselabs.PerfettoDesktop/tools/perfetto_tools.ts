// Copyright (C) 2026 Tooluse Labs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

import {Engine} from '../../../trace_processor/engine';
import {ToolDeclaration} from '../provider/types';

export interface PerfettoAiTool extends ToolDeclaration {
  call(input: unknown): Promise<string>;
}

const DEFAULT_ROW_LIMIT = 1000;
const MAX_ROW_LIMIT = 5000;
const MAX_RESULT_CHARS = 20000;

export function createPerfettoAiTools(
  engine: Engine,
): readonly PerfettoAiTool[] {
  return [
    {
      name: 'perfetto_execute_query',
      description: `
Execute a PerfettoSQL query against the currently loaded trace.
Prefer aggregate queries and standard library views. Use INCLUDE PERFETTO
MODULE in a separate query before reading module-provided views.
Row-producing SELECT/WITH queries are wrapped with a hard outer LIMIT before
execution.
      `.trim(),
      inputSchema: {
        type: 'object',
        properties: {
          query: {type: 'string'},
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ROW_LIMIT,
            description: `Maximum rows to return. Defaults to ${DEFAULT_ROW_LIMIT}.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      call: async (input) => {
        const args = requireRecord(input);
        return runQueryAsJson(
          engine,
          requireString(args, 'query'),
          optionalLimit(args.limit),
        );
      },
    },
    {
      name: 'perfetto_list_android_processes',
      description: 'List rows from the trace process table.',
      inputSchema: emptyObjectSchema(),
      call: async () => {
        return runQueryAsJson(
          engine,
          'select * from process',
          DEFAULT_ROW_LIMIT,
        );
      },
    },
    {
      name: 'perfetto_list_interesting_tables',
      description: `
List non-internal tables and views visible in sqlite_schema. Use this when a
query references a table that may not exist in the loaded trace.
      `.trim(),
      inputSchema: emptyObjectSchema(),
      call: async () => {
        return runQueryAsJson(
          engine,
          `
SELECT name, type
FROM sqlite_schema
WHERE type in ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '\\_%' ESCAPE '\\'
ORDER BY type, name
          `,
          MAX_ROW_LIMIT,
        );
      },
    },
    {
      name: 'perfetto_list_table_structure',
      description: 'List columns for a table or view using pragma table_info.',
      inputSchema: {
        type: 'object',
        properties: {
          table: {type: 'string'},
        },
        required: ['table'],
        additionalProperties: false,
      },
      call: async (input) => {
        const args = requireRecord(input);
        return runQueryAsJson(
          engine,
          `pragma table_info('${escapeSqlString(requireString(args, 'table'))}')`,
          DEFAULT_ROW_LIMIT,
        );
      },
    },
  ];
}

async function runQueryAsJson(
  engine: Engine,
  query: string,
  limit: number,
): Promise<string> {
  const result = await engine.query(boundedSql(query, limit));
  const columns = result.columns();
  const rows: unknown[] = [];
  let truncatedRows = false;

  for (const it = result.iter({}); it.valid(); it.next()) {
    if (rows.length >= limit) {
      truncatedRows = true;
      break;
    }

    const row: {[key: string]: unknown} = {};
    for (const name of columns) {
      row[name] = serializeSqlValue(it.get(name));
    }
    rows.push(row);
  }

  return truncateResult(
    JSON.stringify(
      {
        columns,
        rows,
        rowCount: rows.length,
        truncatedRows,
      },
      undefined,
      2,
    ),
  );
}

function boundedSql(query: string, limit: number): string {
  const statement = trimTrailingSemicolons(query);
  if (!isRowProducingQuery(statement)) {
    return statement;
  }
  return `select * from (${statement}) limit ${limit + 1}`;
}

function trimTrailingSemicolons(query: string): string {
  return query.trim().replace(/;+$/, '').trim();
}

function isRowProducingQuery(query: string): boolean {
  const firstToken = firstSqlToken(query)?.toLowerCase();
  return firstToken === 'select' || firstToken === 'with';
}

function firstSqlToken(query: string): string | undefined {
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    const next = query[i + 1];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < query.length && query[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (
        i + 1 < query.length &&
        !(query[i] === '*' && query[i + 1] === '/')
      ) {
        i++;
      }
      i += 2;
      continue;
    }
    return query.slice(i).match(/^(\w+)/)?.[1];
  }
  return undefined;
}

function serializeSqlValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  return value;
}

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) {
    return result;
  }
  return `${result.slice(0, MAX_RESULT_CHARS)}\n... truncated at ${MAX_RESULT_CHARS} characters`;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return input as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Tool argument "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_ROW_LIMIT;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Tool argument "limit" must be a number');
  }
  return Math.max(1, Math.min(MAX_ROW_LIMIT, Math.floor(value)));
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
