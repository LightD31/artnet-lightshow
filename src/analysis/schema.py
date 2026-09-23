"""The analysis document's contract: document.schema.json, and a validator.

The schema is the one description of the document both sides agree on. The
pipeline's tests validate what it produces against it, and the show engine's
TypeScript types are generated from it (scripts/gen-analysis-types.ts), so a
field renamed on one side and not the other fails a test instead of reaching a
show as `undefined`.

The validator covers the subset of JSON Schema the file uses — types, required
and known properties, additional properties, items, enums and local `$ref`s —
and needs nothing beyond the standard library, so it runs wherever the
analyser does.
"""

import json
import os

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'document.schema.json')

_schema = None


def load_schema():
    """The document schema, read once."""
    global _schema
    if _schema is None:
        with open(SCHEMA_PATH, encoding='utf-8') as handle:
            _schema = json.load(handle)
    return _schema


_TYPE_CHECKS = {
    'object': lambda v: isinstance(v, dict),
    'array': lambda v: isinstance(v, list),
    'string': lambda v: isinstance(v, str),
    # JSON has one number type; bool is an int subclass in Python but is not a
    # number in JSON.
    'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    'integer': lambda v: (isinstance(v, int) and not isinstance(v, bool))
                         or (isinstance(v, float) and v.is_integer()),
    'boolean': lambda v: isinstance(v, bool),
    'null': lambda v: v is None,
}


def _resolve(schema, root):
    ref = schema.get('$ref')
    if not ref:
        return schema
    if not ref.startswith('#/'):
        raise ValueError(f'only local $refs are supported, not {ref}')
    node = root
    for part in ref[2:].split('/'):
        node = node[part]
    return node


def _check(value, schema, root, path, errors):
    schema = _resolve(schema, root)
    if not schema:
        return

    types = schema.get('type')
    if types is not None:
        allowed = types if isinstance(types, list) else [types]
        if not any(_TYPE_CHECKS[t](value) for t in allowed):
            errors.append(f'{path or "/"}: expected {" or ".join(allowed)}, got {type(value).__name__}')
            return

    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{path or "/"}: {value!r} is not one of {schema["enum"]}')
        return

    if isinstance(value, dict):
        properties = schema.get('properties', {})
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}/{key}: missing')
        extra = schema.get('additionalProperties', True)
        for key, item in value.items():
            if key in properties:
                _check(item, properties[key], root, f'{path}/{key}', errors)
            elif extra is False:
                errors.append(f'{path}/{key}: not allowed')
            elif isinstance(extra, dict):
                _check(item, extra, root, f'{path}/{key}', errors)

    if isinstance(value, list) and isinstance(schema.get('items'), dict):
        for index, item in enumerate(value):
            _check(item, schema['items'], root, f'{path}/{index}', errors)


def errors(document, schema=None):
    """Every way `document` departs from the schema, as JSON-pointer messages."""
    root = schema or load_schema()
    found = []
    _check(document, root, root, '', found)
    return found


def validate(document):
    """Return `document`, or raise ValueError naming what is wrong with it."""
    found = errors(document)
    if found:
        shown = '; '.join(found[:10])
        more = f' (and {len(found) - 10} more)' if len(found) > 10 else ''
        raise ValueError(f'analysis document does not match the schema: {shown}{more}')
    return document
