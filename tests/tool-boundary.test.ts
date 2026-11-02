import { expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

it('declares only the three fixed model tools and never calls management from tools', () => {
  const text = readFileSync(new URL('../packages/dsh-cicada/src/host/index.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const tools: { name: string; methods: string[] }[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineTool'
    ) {
      const object = node.arguments[0];
      if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('Nonliteral tool definition');
      const name = object.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(file) === 'name',
      );
      if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteral(name.initializer))
        throw new Error('Dynamic tool name');
      const methods: string[] = [];
      const calls = (child: ts.Node): void => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.expression.getText(file) === 'active'
        )
          methods.push(child.expression.name.text);
        ts.forEachChild(child, calls);
      };
      calls(object);
      tools.push({ name: name.initializer.text, methods });
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  expect(tools).toEqual([
    { name: 'cicada_status', methods: ['status'] },
    { name: 'cicada_preview_history', methods: ['preview'] },
    { name: 'cicada_drill', methods: ['drill'] },
  ]);
});
