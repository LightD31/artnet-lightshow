/**
 * Generate src/types/analysis.ts from src/analysis/document.schema.json.
 *
 *   npm run gen:analysis-types
 *
 * The schema is the one description of the analysis document that the Python
 * analyser and the TypeScript show engine share: the analyser's tests validate
 * what it writes against it, and the show engine's types come from it. A test
 * (tests/unit/analysis-schema.test.js) fails when the generated file is out of
 * date, so the two can only change together.
 *
 * It understands the part of JSON Schema the file uses: types (with null),
 * required and optional properties, maps (additionalProperties), arrays,
 * enums, descriptions and local $refs.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface JsonSchema {
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

const ROOT = path.join(import.meta.dirname, '..');
export const SCHEMA_FILE = path.join(ROOT, 'src', 'analysis', 'document.schema.json');
export const TYPES_FILE = path.join(ROOT, 'src', 'types', 'analysis.ts');

const PRIMITIVES: Record<string, string> = {
  string: 'string', number: 'number', integer: 'number', boolean: 'boolean', null: 'null',
};

/** A doc comment for `text` at `indent`, wrapped to the line length. */
function doc(text: string | undefined, indent: string): string {
  if (!text) return '';
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${indent} * ${line} ${word}`.length > 100) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function refName(ref: string): string {
  const m = ref.match(/^#\/\$defs\/(.+)$/);
  if (!m) throw new Error(`only local $defs references are supported, not ${ref}`);
  return m[1];
}

/** The TypeScript type for a schema, inline. */
function typeOf(schema: JsonSchema, indent: string): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length) return schema.properties || schema.additionalProperties ? objectOf(schema, indent) : 'unknown';

  return types.map((t) => {
    if (t in PRIMITIVES) return PRIMITIVES[t];
    if (t === 'array') {
      const item = schema.items && Object.keys(schema.items).length ? typeOf(schema.items, indent) : 'unknown';
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    if (t === 'object') return objectOf(schema, indent);
    throw new Error(`unsupported type ${t}`);
  }).join(' | ');
}

/** An object type: its properties, or a map of its additional properties. */
function objectOf(schema: JsonSchema, indent: string): string {
  const props = schema.properties || {};
  const extra = schema.additionalProperties;
  if (!Object.keys(props).length) {
    return extra && typeof extra === 'object' ? `Record<string, ${typeOf(extra, indent)}>` : 'Record<string, unknown>';
  }
  return `{\n${members(schema, `${indent}  `)}${indent}}`;
}

function members(schema: JsonSchema, indent: string): string {
  const required = new Set(schema.required || []);
  let out = '';
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    out += doc(prop.description, indent);
    out += `${indent}${key}${required.has(name) ? '' : '?'}: ${typeOf(prop, indent)};\n`;
  }
  const extra = schema.additionalProperties;
  if (extra && typeof extra === 'object' && Object.keys(schema.properties || {}).length) {
    out += `${indent}[key: string]: unknown;\n`;
  }
  return out;
}

function declaration(name: string, schema: JsonSchema): string {
  const head = doc(schema.description, '');
  const isInterface = (schema.type === 'object' || schema.type === undefined) && schema.properties;
  if (isInterface) return `${head}export interface ${name} {\n${members(schema, '  ')}}\n`;
  return `${head}export type ${name} = ${typeOf(schema, '')};\n`;
}

/** The whole generated module for a schema. */
export function generate(schema: JsonSchema): string {
  const parts = [
    '// Generated from src/analysis/document.schema.json by scripts/gen-analysis-types.ts.\n'
      + '// Do not edit: change the schema and run `npm run gen:analysis-types`.\n',
    declaration(schema.title || 'Document', schema),
  ];
  for (const [name, def] of Object.entries(schema.$defs || {})) parts.push(declaration(name, def));
  return parts.join('\n');
}

export function readSchema(): JsonSchema {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')) as JsonSchema;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  fs.mkdirSync(path.dirname(TYPES_FILE), { recursive: true });
  fs.writeFileSync(TYPES_FILE, generate(readSchema()));
  console.log(`wrote ${path.relative(ROOT, TYPES_FILE)}`);
}
