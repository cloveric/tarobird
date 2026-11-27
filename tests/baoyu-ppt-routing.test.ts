import { describe, expect, it } from 'vitest';
import { appCapabilityInstructions, appTurnInstructions, workbenchInstructions } from '../src/gateway/agent-instructions.js';
import { workbenchDesignGuidance } from '../src/gateway/design-guidance.js';

const engines = ['codex', 'claude', 'kimi', 'deepseek', 'antigravity'] as const;

describe('simplified neutral presentation routing (#90)', () => {
  it.each([
    '做一份幻灯片。', '修改 quarterly.pptx。', 'Make a keynote.', '請做一份簡報。',
  ])('does not append a long PPT routing wall to ordinary turn %s', input => {
    for (const engine of engines) {
      const text = appTurnInstructions(input, { engine, nativeDelivery: true, nativeWidgets: true }) ?? '';
      expect(text).not.toMatch(/baoyu|宝玉|宝育/i);
      expect(text).not.toContain("operation:'design.open'");
    }
  });

  it.each(engines)('%s keeps concise neutral Workbench presentation routing when Workbench is open or has an opener', engine => {
    const opener = { deviceId: 'd', windowId: 'opener' };
    for (const context of [
      { target: opener, openTarget: opener },
      { target: { deviceId: 'd', windowId: 'controller', tabId: 'design' }, kind: 'design', revision: 1 },
    ]) {
      const text = workbenchInstructions('chat', 'input', context, undefined, { engine });
      expect(text).toContain('Workbench presentation routing:');
      expect(text).toContain("format:'slides'");
      expect(text).not.toMatch(/baoyu|宝玉|宝育/i);
    }
  });

  it.each(['browser', 'widgets'] as const)('%s capability describes TaroBird Workbench presentation format cleanly', topic => {
    const text = appCapabilityInstructions(topic, { widgetsEnabled: true });
    expect(text).toContain('project/deck.json');
    expect(text).toContain('project/slides/');
    expect(text).toContain("engine's built-in presentation skill");
    expect(text).not.toMatch(/baoyu-ppt|宝玉|宝育/i);
  });

  it('keeps native-authoring publication guidance honest about binary PPTX files', () => {
    expect(workbenchDesignGuidance).toContain('Native authoring to Workbench');
    expect(workbenchDesignGuidance).toContain('not binary .pptx archives');
    expect(workbenchDesignGuidance).not.toMatch(/baoyu-ppt|宝玉|宝育/i);
  });
});
