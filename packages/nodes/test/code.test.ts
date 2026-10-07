import { describe, expect, it } from 'vitest';
import { errorOf, runNode } from './harness';

describe('Code node (isolated-vm sandbox)', () => {
  it('runs once for all items', async () => {
    const { run, output } = await runNode(
      'flowforge.code',
      {
        mode: 'runOnceForAllItems',
        jsCode: `const total = $input.all().reduce((s, i) => s + i.json.price, 0);
console.log('total is', total, { n: items.length });
return [{ json: { total } }, { count: items.length }];`,
      },
      [{ price: 10 }, { price: 15 }],
    );
    expect(run.status).toBe('success');
    expect(output()).toEqual([{ total: 25 }, { count: 2 }]);
    expect(run.data.resultData.runData.Node![0]!.logs).toEqual(['total is 25 {"n":2}']);
  });

  it('runs once for each item with $json and async code', async () => {
    const { output, run } = await runNode(
      'flowforge.code',
      {
        mode: 'runOnceForEachItem',
        jsCode: `await Promise.resolve();
return { json: { ...$json, upper: $json.name.toUpperCase(), index: $itemIndex, wf: $workflow.name } };`,
      },
      [{ name: 'asha' }, { name: 'ravi' }],
    );
    expect(run.status).toBe('success');
    expect(output()).toEqual([
      { name: 'asha', upper: 'ASHA', index: 0, wf: 'test' },
      { name: 'ravi', upper: 'RAVI', index: 1, wf: 'test' },
    ]);
    expect(run.data.resultData.runData.Node![0]!.data!.main[0]![1]!.pairedItem).toEqual({ item: 1 });
  });

  it('reports syntax errors with a line number', async () => {
    const { run } = await runNode('flowforge.code', { jsCode: 'const a = 1;\nreturn [{ json: { a } ];' });
    expect(run.status).toBe('error');
    expect(errorOf(run)?.message).toMatch(/\[line 2\]/);
  });

  it('reports runtime errors with item index and line', async () => {
    const { run } = await runNode(
      'flowforge.code',
      { mode: 'runOnceForEachItem', jsCode: 'if ($json.bad) {\n  throw new Error("bad item");\n}\nreturn $input.item;' },
      [{ bad: false }, { bad: true }],
    );
    const error = errorOf(run)!;
    expect(error.message).toBe('bad item [line 2]');
    expect(error.itemIndex).toBe(1);
    expect(error.description).toBe('Error in your code at line 2');
  });

  it('validates the return value', async () => {
    const { run } = await runNode('flowforge.code', { jsCode: 'return [1, 2];' });
    expect(errorOf(run)?.message).toBe("Code doesn't return items properly");
    expect(errorOf(run)?.description).toMatch(/Item 0 is a number/);
  });

  it('has no access to Node.js APIs', async () => {
    const { output } = await runNode('flowforge.code', {
      jsCode: `return [{ json: {
        require: typeof require, process: typeof process, fetch: typeof fetch, globalProcess: typeof globalThis.process
      } }];`,
    });
    expect(output()).toEqual([{ require: 'undefined', process: 'undefined', fetch: 'undefined', globalProcess: 'undefined' }]);
  });

  it('stops infinite loops', async () => {
    const { run } = await runNode('flowforge.code', { jsCode: 'while (true) {}' });
    expect(run.status).toBe('error');
    expect(errorOf(run)?.message).toMatch(/timed out/);
  }, 10_000);
});
