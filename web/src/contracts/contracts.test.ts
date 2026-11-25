import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { Capture, Intrinsics, LiveFrame, RunRig, RunSplat } from '.';

const root = resolve(import.meta.dirname, '../../../contracts');
const read = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const names = readdirSync(root).filter((f) => f.endsWith('.schema.json')).map((f) => f.replace('.schema.json', ''));

describe('Vertraege', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of names) ajv.addSchema(read(`${name}.schema.json`) as object, name);

  it.each(names)('Beispiel %s passt zum Schema', (name) => {
    const ok = ajv.validate(name, read(`examples/${name}.json`));
    expect(ajv.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('die erzeugten Typen passen zu den Beispielen', () => {
    // Prueft beim Kompilieren (tsc -b), dass die Beispiele den erzeugten Typen entsprechen.
    const examples = {
      capture: read('examples/capture.json') as Capture,
      intrinsics: read('examples/intrinsics.json') as Intrinsics,
      live: read('examples/live-frame.json') as LiveFrame,
      rig: read('examples/run-rig.json') as RunRig,
      splat: read('examples/run-splat.json') as RunSplat,
    };
    expect(examples.live.pts).toHaveLength(33);
    expect(examples.splat.matrix).toHaveLength(4);
    expect(Object.keys(examples.rig.joints)).toContain('nose');
    expect(examples.intrinsics.dist).toHaveLength(5);
    expect(examples.capture.saved.a?.saved).toMatch(/\.mp4$/);
  });
});
